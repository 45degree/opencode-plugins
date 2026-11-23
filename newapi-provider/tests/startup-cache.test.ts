// Ticket 09: the startup catalog cache. With `cache` on (the default) a group that
// holds a record for its exact address, connection and key starts from that record
// and refreshes in the background. A background result is written for the NEXT start
// and leaves what this instance shows alone. Everything else starts online, and
// `cache: false` never touches storage.
//
// Instances, keys and addresses are fake; every discovery is answered by the test.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  makeContext,
  makeStorage,
  settled,
  stubGatedFetch,
  stubRoutedFetch,
  until,
  type RecordedDrafts,
  type RecordedRequest,
  type StorageStub,
} from "./helpers/context.js"
import newapiProvider from "../src/index.js"

const RESPONSES_MODEL = (id: string) => ({ id, supported_endpoint_types: ["openai-response"] })
const KEY = "sk-fake-work"
const KEY_2 = "sk-fake-second"
const CATALOG_KEY = "catalog:packy-work"
const ROOT = "https://newapi.example.com"

const options = (cache?: boolean) => ({
  ...(cache === undefined ? {} : { cache }),
  providers: [{ base_url: ROOT, groups: [{ id: "packy-work", name: "Packy Work" }] }],
})
const CONNECTION = { id: "cred-1", credential: { type: "key", key: KEY } }

interface Reply {
  payload: unknown
  status?: number
}
const list = (...ids: string[]): Reply => ({ payload: { object: "list", data: ids.map(RESPONSES_MODEL) } })
const UNAUTHORIZED: Reply = { payload: { error: { message: "invalid access token" } }, status: 401 }
/** The instance cannot be reached at all. */
const OFFLINE = (): never => {
  throw new TypeError("fetch failed")
}

const modelIDs = (drafts: RecordedDrafts) => [...drafts.providers.get("packy-work")!.models.keys()].sort()
const record = (storage: StorageStub) => storage.data.get(CATALOG_KEY) as Record<string, unknown> | undefined
const storedIDs = (storage: StorageStub) =>
  ((record(storage)?.["models"] ?? []) as Array<{ id: string }>).map((model) => model.id).sort()
/** Give the event loop a few turns; unlike a timer this never waits longer than needed. */
const turns = async (count = 20) => {
  for (let index = 0; index < count; index++) await new Promise<void>((resolve) => setImmediate(resolve))
}

async function runRefresh(drafts: RecordedDrafts) {
  await drafts.commands.get("newapi-provider-refresh")!.execute({
    sessionID: "ses_test" as never,
    prompt: {} as never,
    delivery: {} as never,
  })
}

/** A plugin instance whose instance answers every discovery at once. */
async function start(
  storage: StorageStub,
  reply: (request: RecordedRequest) => Reply,
  opts: Record<string, unknown> = options(),
  connection: { id?: string; credential: { type: string; key: string } } = CONNECTION,
) {
  const made = makeContext({ options: opts, connection, storage })
  const stub = stubRoutedFetch((request) => reply(request))
  let cleanup: (() => Promise<void> | void) | undefined
  const finish = async () => {
    if (cleanup) await cleanup()
    stub.restore()
  }
  try {
    const result = await newapiProvider.setup(made.context)
    cleanup = typeof result === "function" ? result : undefined
  } catch (error) {
    await finish()
    throw error
  }
  return { ...made, finish }
}

/** A plugin instance whose discovery requests wait until the test answers them. */
function open(storage: StorageStub, opts: Record<string, unknown> = options()) {
  const made = makeContext({ options: opts, connection: CONNECTION, storage })
  const fetch = stubGatedFetch()
  let cleanup: (() => Promise<void> | void) | undefined
  return {
    ...made,
    fetch,
    /** Run setup and keep its cleanup for `unload`. */
    setup: async () => {
      const result = await newapiProvider.setup(made.context)
      cleanup = typeof result === "function" ? result : undefined
    },
    unload: async () => cleanup?.(),
    /** Answer whatever is still waiting, unload, then stop stubbing fetch. */
    finish: async () => {
      for (const gated of fetch.pending()) gated.answer(list("leftover").payload)
      if (cleanup) await cleanup()
      fetch.restore()
    },
  }
}

/** Run `task` while console.warn is captured; returns the lines it printed. */
async function capturingWarnings(task: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => lines.push(args.join(" "))
  try {
    await task()
  } finally {
    console.warn = original
  }
  return lines
}

/** Let one instance write a good record for `KEY`, so later starts have something to reuse. */
async function seededStorage(...ids: string[]) {
  const storage = makeStorage()
  const first = await start(storage, () => list(...ids))
  await first.finish()
  storage.reads.length = 0
  storage.writes.length = 0
  return storage
}

describe("startup cache: what a start does with storage", () => {
  it("a cold start goes online and leaves a record that names the key only by fingerprint", async () => {
    const storage = makeStorage()
    const first = await start(storage, () => list("a", "b"))
    try {
      assert.deepEqual(modelIDs(first.drafts), ["a", "b"], "the online list is shown")
      assert.deepEqual(storage.reads, [CATALOG_KEY], "the record is read before the group goes online")
      assert.equal(storage.writes.length, 1, "the fetched list is written once")
      assert.equal(storage.data.size, 1, "one record per group")

      const [write] = storage.writes
      const value = write!.value as Record<string, unknown>
      assert.equal(write!.key, CATALOG_KEY)
      assert.match(String(value["keyFingerprint"]), /^[0-9a-f]{64}$/, "the key is stored as a SHA-256 fingerprint")
      assert.equal(typeof value["updatedAt"], "number")
      assert.deepEqual(
        { ...value, keyFingerprint: "<hex>", updatedAt: "<ms>" },
        {
          version: 1,
          gatewayRoot: ROOT,
          group: "packy-work",
          connection: "credential:cred-1-packy-work",
          keyFingerprint: "<hex>",
          state: "ok",
          models: [
            { id: "a", endpointTypes: ["openai-response"] },
            { id: "b", endpointTypes: ["openai-response"] },
          ],
          updatedAt: "<ms>",
        },
        "the record names what it is valid for, and nothing that could act as the key",
      )
      assert.doesNotMatch(JSON.stringify(value), new RegExp(KEY), "the record never carries the key")
    } finally {
      await first.finish()
    }
  })

  it("a warm start shows the cached list before the instance answers; the background result is saved for the next start only", async () => {
    const storage = await seededStorage("gen-1")

    const second = open(storage)
    try {
      const ready = settled(second.setup())
      await until(ready, "setup to finish while the discovery request is unanswered")
      assert.deepEqual(modelIDs(second.drafts), ["gen-1"], "the cached list is visible before any response")
      assert.equal(second.fetch.requests.length, 1, "exactly one background refresh was started")
      assert.equal(second.fetch.pending().length, 1, "and it is still waiting for the instance")

      second.fetch.answer(0, list("gen-2").payload)
      await until(() => storage.writes.length === 1, "the background result to be written")
      assert.deepEqual(modelIDs(second.drafts), ["gen-1"], "this instance keeps the list it started with")
      assert.deepEqual(storedIDs(storage), ["gen-2"], "the record holds the background result for the next start")
      assert.equal(record(storage)?.["state"], "ok")
    } finally {
      await second.finish()
    }

    const third = open(storage)
    try {
      await until(settled(third.setup()), "the third start to finish before its request is answered")
      assert.deepEqual(modelIDs(third.drafts), ["gen-2"], "the next start shows the background result")
    } finally {
      await third.finish()
    }
  })

  it("does not reuse a record that is malformed, rejected, or written for another address, connection or key", async () => {
    const seed = await seededStorage("gen-1")
    const good = record(seed)!

    const variants: Array<{ name: string; value: unknown }> = [
      { name: "not JSON", value: "{not json" },
      { name: "from another cache version", value: { ...good, version: 99 } },
      { name: "with a malformed model list", value: { ...good, models: [{ id: 42 }] } },
      { name: "the instance rejected", value: { ...good, state: "rejected" } },
      { name: "written for another key", value: { ...good, keyFingerprint: "0".repeat(64) } },
      { name: "written for another connection", value: { ...good, connection: "credential:someone-else" } },
      { name: "written for another address", value: { ...good, gatewayRoot: "https://elsewhere.example.com" } },
    ]
    for (const variant of variants) {
      const storage = makeStorage({ [CATALOG_KEY]: structuredClone(variant.value) })
      const opened = open(storage)
      try {
        const ready = settled(opened.setup())
        await turns()
        assert.equal(opened.fetch.requests.length, 1, `${variant.name}: the group goes online`)
        assert.equal(ready(), false, `${variant.name}: setup waits for the online list`)

        opened.fetch.answer(0, list("online").payload)
        await until(ready, `${variant.name}: setup to finish`)
        assert.deepEqual(modelIDs(opened.drafts), ["online"], `${variant.name}: the online list is shown`)
        assert.deepEqual(storedIDs(storage), ["online"], `${variant.name}: the record is replaced by the online result`)
      } finally {
        await opened.finish()
      }
    }
  })

  it("`cache: false` never reads or writes storage, and never falls back to a record", async () => {
    const storage = await seededStorage("gen-1")

    const offline = await start(storage, OFFLINE, options(false))
    try {
      assert.deepEqual(modelIDs(offline.drafts), [], "no list without the cache and without the instance")
      assert.deepEqual(storage.reads, [], "nothing is read")
      assert.deepEqual(storage.writes, [], "nothing is written")
      assert.deepEqual(storedIDs(storage), ["gen-1"], "the existing record is left alone")
    } finally {
      await offline.finish()
    }

    const online = open(storage, options(false))
    try {
      const ready = settled(online.setup())
      await turns()
      assert.equal(ready(), false, "setup waits for the online list although a valid record exists")
      online.fetch.answer(0, list("gen-2").payload)
      await until(ready, "setup to finish")
      assert.deepEqual(modelIDs(online.drafts), ["gen-2"])

      const refreshing = runRefresh(online.drafts)
      await until(() => online.fetch.pending().length === 1, "the manual refresh to reach the instance")
      online.fetch.answer(0, UNAUTHORIZED.payload, UNAUTHORIZED.status)
      await assert.rejects(refreshing, /hidden/)
      assert.deepEqual(modelIDs(online.drafts), [], "a rejected credential shows nothing")
      assert.deepEqual(storage.reads, [], "still nothing read")
      assert.deepEqual(storage.writes, [], "still nothing written")
    } finally {
      await online.finish()
    }
  })

  it("a changed key starts online and rewrites the record for the new key", async () => {
    const storage = await seededStorage("gen-1")
    const oldFingerprint = record(storage)?.["keyFingerprint"]

    const rotated = await start(storage, () => list("gen-key-2"), options(), {
      id: "cred-1",
      credential: { type: "key", key: KEY_2 },
    })
    try {
      assert.deepEqual(modelIDs(rotated.drafts), ["gen-key-2"], "the new key's own list, fetched online")
      assert.deepEqual(storage.reads, [CATALOG_KEY], "the old record was looked at and passed over")
      assert.deepEqual(storedIDs(storage), ["gen-key-2"])
      assert.notEqual(record(storage)?.["keyFingerprint"], oldFingerprint, "the record now belongs to the new key")
      assert.doesNotMatch(JSON.stringify(record(storage)), new RegExp(KEY_2))
    } finally {
      await rotated.finish()
    }
  })
})

describe("startup cache: what survives a restart", () => {
  it("a credential the instance rejected stays hidden across restarts until the instance accepts it again", async () => {
    const storage = await seededStorage("gen-1")

    // Start 2: the cached list appears, then the background refresh learns the key is rejected.
    const second = open(storage)
    try {
      await until(settled(second.setup()), "the second start to come up from the record")
      assert.deepEqual(modelIDs(second.drafts), ["gen-1"], "the list is shown from the record first")
      second.fetch.answer(0, UNAUTHORIZED.payload, UNAUTHORIZED.status)
      await until(() => record(storage)?.["state"] === "rejected", "the rejection to be recorded")
      assert.deepEqual(modelIDs(second.drafts), [], "the list is hidden as soon as the instance rejects the key")
      assert.deepEqual(storedIDs(storage), [], "and the rejected list is dropped from the record")
    } finally {
      await second.finish()
    }

    // Start 3: the instance cannot be reached. The rejected list must not come back.
    const third = await start(storage, OFFLINE)
    try {
      assert.deepEqual(modelIDs(third.drafts), [], "no fallback to a list the instance rejected")
      assert.equal(record(storage)?.["state"], "rejected", "the offline start leaves the rejection in place")
    } finally {
      await third.finish()
    }

    // Start 4: the instance accepts the key again.
    const fourth = await start(storage, () => list("gen-4"))
    try {
      assert.deepEqual(modelIDs(fourth.drafts), ["gen-4"])
      assert.deepEqual({ state: record(storage)?.["state"], ids: storedIDs(storage) }, { state: "ok", ids: ["gen-4"] })
    } finally {
      await fourth.finish()
    }
  })

  it("a rejection found by a manual refresh is recorded the same way", async () => {
    const storage = await seededStorage("gen-1")
    let rejected = false
    const live = await start(storage, () => (rejected ? UNAUTHORIZED : list("gen-1")))
    try {
      rejected = true
      await assert.rejects(runRefresh(live.drafts), /hidden/)
      assert.deepEqual(modelIDs(live.drafts), [])
      assert.equal(record(storage)?.["state"], "rejected")
    } finally {
      await live.finish()
    }
    const next = await start(storage, OFFLINE)
    try {
      assert.deepEqual(modelIDs(next.drafts), [], "the restart does not show the rejected list")
    } finally {
      await next.finish()
    }
  })

  it("an empty list empties the group at once when refreshed by hand, and at the next start when found in the background", async () => {
    // By hand.
    const byHand = await seededStorage("gen-1")
    let empty = false
    const live = await start(byHand, () => (empty ? list() : list("gen-1")))
    try {
      empty = true
      await runRefresh(live.drafts)
      assert.deepEqual(modelIDs(live.drafts), [], "cleared at once")
      assert.deepEqual(storedIDs(byHand), [], "and recorded as empty")
    } finally {
      await live.finish()
    }

    // In the background.
    const inBackground = await seededStorage("gen-1")
    const second = open(inBackground)
    try {
      await until(settled(second.setup()), "the second start to come up from the record")
      second.fetch.answer(0, list().payload)
      await until(() => inBackground.writes.length === 1, "the empty result to be written")
      assert.deepEqual(storedIDs(inBackground), [])
      assert.deepEqual(modelIDs(second.drafts), ["gen-1"], "the background result does not change this instance")
    } finally {
      await second.finish()
    }
    const third = open(inBackground)
    try {
      await until(settled(third.setup()), "the third start to come up from the record")
      assert.deepEqual(modelIDs(third.drafts), [], "the next start shows the empty list")
    } finally {
      await third.finish()
    }
  })

  it("a failed cache write is reported without the raw error, keeps the last good record, and does not hold the unload", async () => {
    const storage = await seededStorage("gen-1")
    let attempts = 0
    storage.beforeWrite = async () => {
      attempts += 1
      throw new Error(`disk full while storing ${KEY}`)
    }
    const second = open(storage)
    try {
      const lines = await capturingWarnings(async () => {
        await until(settled(second.setup()), "the second start to come up from the record")
        second.fetch.answer(0, list("gen-2").payload)
        await until(() => attempts === 1, "the write to be attempted")
        await turns()
      })
      assert.deepEqual(modelIDs(second.drafts), ["gen-1"])
      assert.deepEqual(storedIDs(storage), ["gen-1"], "the previous record is kept")
      const diagnostics = lines.join("\n")
      assert.match(diagnostics, /`packy-work`.*could not be written/, "the failed write is reported for the group")
      assert.doesNotMatch(diagnostics, new RegExp(KEY), "the raw storage error is not passed through")
    } finally {
      await second.finish()
    }

    // A cold start still shows the list it fetched when the record cannot be written.
    const cold = makeStorage()
    cold.beforeWrite = async () => {
      throw new Error("disk full")
    }
    const third = await start(cold, () => list("live"))
    try {
      assert.deepEqual(modelIDs(third.drafts), ["live"], "the fetched list does not depend on the write")
    } finally {
      await third.finish()
    }
  })

  it("a temporary network failure never overwrites a good record", async () => {
    const storage = await seededStorage("gen-1")
    const second = open(storage)
    try {
      await until(settled(second.setup()), "the second start to come up from the record")
      second.fetch.answer(0, { error: { message: "bad gateway" } }, 502)
      await turns(40)
      assert.deepEqual(modelIDs(second.drafts), ["gen-1"], "the same credential keeps its valid list")
      assert.deepEqual(storage.writes, [], "a failure writes nothing")
      assert.deepEqual(storedIDs(storage), ["gen-1"])
    } finally {
      await second.finish()
    }
  })
})
