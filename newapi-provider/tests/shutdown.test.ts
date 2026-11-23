// Ticket 09: unloading. Cleanup closes admission first, so that no refresh starts
// any more, then waits for the rounds that already started together with their
// storage writes. It never asks the host to rebuild the models: that rebuild needs
// the lock the unload itself holds.
//
// Rounds are driven by a fetch the test answers by hand, so each test decides what
// is still in flight when the plugin unloads.

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
  type StorageStub,
} from "./helpers/context.js"
import newapiProvider from "../src/index.js"

const RESPONSES_MODEL = (id: string) => ({ id, supported_endpoint_types: ["openai-response"] })
const KEY = "sk-fake-work"
const KEY_2 = "sk-fake-second"
const CATALOG_KEY = "catalog:packy-work"
const OPTIONS = {
  providers: [{ base_url: "https://newapi.example.com", groups: [{ id: "packy-work", name: "Packy Work" }] }],
}
const CONNECTION = { id: "cred-1", credential: { type: "key", key: KEY } }

const list = (...ids: string[]) => ({ payload: { object: "list", data: ids.map(RESPONSES_MODEL) } })
const UNAUTHORIZED = { payload: { error: { message: "invalid access token" } }, status: 401 }
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Give the event loop a few turns; unlike a timer this never waits longer than needed. */
const turns = async (count = 20) => {
  for (let index = 0; index < count; index++) await new Promise<void>((resolve) => setImmediate(resolve))
}

const modelIDs = (drafts: RecordedDrafts) => [...drafts.providers.get("packy-work")!.models.keys()].sort()
const stored = (storage: StorageStub) => storage.data.get(CATALOG_KEY) as { state: string; models: Array<{ id: string }> } | undefined
const storedIDs = (storage: StorageStub) => (stored(storage)?.models ?? []).map((model) => model.id).sort()
const landedStates = (storage: StorageStub) => storage.writes.map((write) => (write.value as { state: string }).state)

async function runRefresh(drafts: RecordedDrafts) {
  await drafts.commands.get("newapi-provider-refresh")!.execute({
    sessionID: "ses_test" as never,
    prompt: {} as never,
    delivery: {} as never,
  })
}

/** Storage holding a good record for `KEY`, so that the next start comes up from it. */
async function seed(...ids: string[]) {
  const storage = makeStorage()
  const made = makeContext({ options: OPTIONS, connection: CONNECTION, storage })
  const stub = stubRoutedFetch(() => list(...ids))
  const cleanup = await newapiProvider.setup(made.context)
  if (typeof cleanup === "function") await cleanup()
  stub.restore()
  storage.reads.length = 0
  storage.writes.length = 0
  return storage
}

/** A plugin instance whose discovery requests wait until the test answers them. */
function open(storage: StorageStub) {
  const made = makeContext({ options: OPTIONS, connection: CONNECTION, storage })
  const fetch = stubGatedFetch()
  let cleanup: (() => Promise<void> | void) | undefined
  return {
    ...made,
    fetch,
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

/** Hold the next write of records whose state passes `hold`; resolves when the test calls the returned release. */
function holdWrites(storage: StorageStub, hold: (value: unknown) => boolean) {
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  let entered = 0
  storage.beforeWrite = async (_key, value) => {
    if (!hold(value)) return
    entered += 1
    await gate
  }
  return { release: () => release(), entered: () => entered }
}

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

describe("shutdown: cleanup waits for the work that already started", () => {
  it("waits for a background refresh and its write, and triggers no rebuild or status call", async () => {
    const storage = await seed("gen-1")
    const plugin = open(storage)
    try {
      await until(settled(plugin.setup()), "the start to come up from the record")
      assert.equal(plugin.fetch.pending().length, 1, "precondition: one background refresh in flight")
      const reloads = plugin.drafts.reloadCalls
      const statuses = plugin.drafts.statusReports.length

      const stopped = plugin.unload()
      const stoppedDone = settled(stopped)
      await delay(40)
      assert.equal(stoppedDone(), false, "cleanup does not return while the request is in flight")

      plugin.fetch.answer(0, list("gen-2").payload)
      await stopped
      assert.deepEqual(storedIDs(storage), ["gen-2"], "the round was written before cleanup returned")
      assert.equal(plugin.drafts.reloadCalls, reloads, "cleanup, and the round it waited for, trigger no rebuild")
      assert.equal(plugin.drafts.statusReports.length, statuses, "nor a connection status call")
    } finally {
      plugin.fetch.restore()
    }
  })

  it("waits for a storage write that is still in flight", async () => {
    const storage = await seed("gen-1")
    const held = holdWrites(storage, (value) => (value as { state: string }).state === "ok")
    const plugin = open(storage)
    try {
      await until(settled(plugin.setup()), "the start to come up from the record")
      plugin.fetch.answer(0, list("gen-2").payload)
      await until(() => held.entered() === 1, "the round to reach storage")

      const stopped = plugin.unload()
      const stoppedDone = settled(stopped)
      await delay(40)
      assert.equal(stoppedDone(), false, "cleanup does not return while the write is pending")

      held.release()
      await stopped
      assert.deepEqual(storedIDs(storage), ["gen-2"], "the write landed before cleanup returned")
    } finally {
      plugin.fetch.restore()
    }
  })

  it("starts no refresh once cleanup began: events and the manual command are ignored", async () => {
    const storage = await seed("gen-1")
    const plugin = open(storage)
    try {
      await until(settled(plugin.setup()), "the start to come up from the record")

      const stopped = plugin.unload()
      await delay(20)
      plugin.emitEvent({ type: "credential.updated", data: { integrationID: "packy-work", credentialID: "cred" } })
      await runRefresh(plugin.drafts)
      await delay(30)
      assert.equal(plugin.fetch.requests.length, 1, "no further request reached the instance")
      assert.equal(plugin.drafts.subscriptionAborts, 1, "the event subscription was cancelled")

      plugin.fetch.answer(0, list("gen-2").payload)
      await stopped
      assert.deepEqual(storedIDs(storage), ["gen-2"])
    } finally {
      plugin.fetch.restore()
    }
  })

  it("a superseded round's late result is never written over the current one", async () => {
    const storage = await seed("gen-1")
    const plugin = open(storage)
    try {
      await until(settled(plugin.setup()), "the start to come up from the record")
      plugin.connection.credential = { type: "key", key: KEY_2 }
      const rotating = runRefresh(plugin.drafts)
      await until(() => plugin.fetch.pending().length === 2, "the old and the new round to be in flight")
      assert.equal(plugin.fetch.requests[1]!.authorization, `Bearer ${KEY_2}`)

      plugin.fetch.answer(1, list("for-key-2").payload)
      await rotating
      assert.deepEqual(modelIDs(plugin.drafts), ["for-key-2"])
      assert.deepEqual(storedIDs(storage), ["for-key-2"], "the current round was written")

      const writes = storage.writes.length
      plugin.fetch.answer(0, list("late-for-old-key").payload)
      await turns(40)
      assert.equal(storage.writes.length, writes, "the superseded round wrote nothing")
      assert.deepEqual(storedIDs(storage), ["for-key-2"])
      assert.deepEqual(modelIDs(plugin.drafts), ["for-key-2"], "nor did it change what is shown")
    } finally {
      await plugin.finish()
    }
  })
})

describe("shutdown: records stay consistent when rounds overlap", () => {
  it("a rejection recorded behind a held success lands last, so it is the final state", async () => {
    const storage = await seed("gen-1")
    const held = holdWrites(storage, () => true)
    const plugin = open(storage)
    try {
      await until(settled(plugin.setup()), "the start to come up from the record")
      plugin.fetch.answer(0, list("gen-2").payload)
      await until(() => held.entered() === 1, "the successful round to reach storage")

      // The outcome is observed through a handled promise: the command settles on
      // its own while the writes below are still being arranged.
      const refreshing = runRefresh(plugin.drafts).then(
        () => "resolved",
        (error: Error) => error,
      )
      await until(() => plugin.fetch.pending().length === 1, "the manual round to reach the instance")
      plugin.fetch.answer(0, UNAUTHORIZED.payload, UNAUTHORIZED.status)
      await turns(40)
      assert.deepEqual(modelIDs(plugin.drafts), [], "hidden at once, before anything is written")
      assert.equal(held.entered(), 1, "the rejection write waits behind the write already in flight")
      assert.equal(storage.writes.length, 0, "nothing landed while the first write is held")

      held.release()
      await until(() => storage.writes.length === 2, "both writes to land")
      const outcome = await refreshing
      assert.match(String(outcome), /models hidden/, "the round reports the rejection once its write landed")
      assert.deepEqual(landedStates(storage), ["ok", "rejected"], "in the order the rounds finished")
      assert.equal(stored(storage)?.state, "rejected")
    } finally {
      await plugin.finish()
    }
  })

  it("a success recorded behind a held rejection lands last, so the list is usable again at the next start", async () => {
    const storage = await seed("gen-1")
    const held = holdWrites(storage, (value) => (value as { state: string }).state === "rejected")
    const plugin = open(storage)
    try {
      await until(settled(plugin.setup()), "the start to come up from the record")
      plugin.fetch.answer(0, UNAUTHORIZED.payload, UNAUTHORIZED.status)
      await until(() => held.entered() === 1, "the rejection to reach storage")
      assert.deepEqual(modelIDs(plugin.drafts), [], "the background refresh hides the rejected list at once")

      const refreshing = runRefresh(plugin.drafts).then(
        () => "resolved",
        (error: Error) => error,
      )
      await until(() => plugin.fetch.pending().length === 1, "the manual round to reach the instance")
      plugin.fetch.answer(0, list("gen-3").payload)
      await turns(40)
      assert.deepEqual(modelIDs(plugin.drafts), ["gen-3"], "shown at once, before anything is written")
      assert.equal(held.entered(), 1, "the successful write waits behind the write already in flight")
      assert.equal(storage.writes.length, 0, "nothing landed while the rejection write is held")

      held.release()
      await until(() => storage.writes.length === 2, "both writes to land")
      assert.equal(await refreshing, "resolved", "the command ends once its write landed")
      assert.deepEqual(landedStates(storage), ["rejected", "ok"])
      assert.equal(stored(storage)?.state, "ok")
      assert.deepEqual(storedIDs(storage), ["gen-3"])
    } finally {
      await plugin.finish()
    }
  })
})

describe("shutdown: failures do not trap the unload", () => {
  it("a storage write that fails during unload is reported and lets cleanup finish", async () => {
    const storage = await seed("gen-1")
    storage.beforeWrite = async () => {
      throw new Error("disk full")
    }
    const plugin = open(storage)
    try {
      const lines = await capturingWarnings(async () => {
        await until(settled(plugin.setup()), "the start to come up from the record")
        const stopped = plugin.unload()
        plugin.fetch.answer(0, list("gen-2").payload)
        await stopped
      })
      assert.match(lines.join("\n"), /`packy-work`.*could not be written/)
      assert.deepEqual(storedIDs(storage), ["gen-1"], "the earlier successful record is untouched")
    } finally {
      plugin.fetch.restore()
    }
  })

  it("a request that never answers ends at the 15 second limit, so cleanup can finish", { timeout: 30_000 }, async () => {
    const storage = await seed("gen-1")
    const plugin = open(storage)
    try {
      await until(settled(plugin.setup()), "the start to come up from the record")
      const started = Date.now()
      await plugin.unload()
      const elapsed = Date.now() - started
      assert.ok(elapsed >= 14_000 && elapsed < 25_000, `cleanup returned after ${elapsed} ms`)
      assert.deepEqual(storedIDs(storage), ["gen-1"], "a round that timed out writes nothing")
      assert.deepEqual(modelIDs(plugin.drafts), ["gen-1"], "and the same credential keeps its list")
    } finally {
      plugin.fetch.restore()
    }
  })
})
