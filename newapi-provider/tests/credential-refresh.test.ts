// Ticket 08: the visible catalog belongs to the connection AND the key that was
// served it. A rotated key invalidates the old list even when the host keeps the
// same credential id; a rejected credential (HTTP 401/403) hides the list at once;
// a network failure on an unchanged credential keeps it. Only a fetch for the
// current connection and key can put models back.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { makeContext, stubModelsFetch, stubRoutedFetch, type RecordedDrafts } from "./helpers/context.js"
import newapiProvider from "../src/index.js"

const RESPONSES_MODEL = (id: string) => ({ id, supported_endpoint_types: ["openai-response"] })

const OPTIONS = { providers: [{ base_url: "https://newapi.example.com", groups: [{ id: "packy-work", name: "Packy Work" }] }] }
const OLD_KEY = "sk-fake-old"
const ROTATED_KEY = "sk-fake-rotated"

const modelIDs = (drafts: RecordedDrafts, groupID = "packy-work") => [...drafts.providers.get(groupID)!.models.keys()].sort()

/** Load with the old key under credential id `cred-1`; the credential id never changes in this file. */
async function loadWithOldKey() {
  const { context, drafts, connection } = makeContext({
    options: OPTIONS,
    connection: { id: "cred-1", credential: { type: "key", key: OLD_KEY } },
  })
  const initial = stubModelsFetch({ object: "list", data: [RESPONSES_MODEL("old-only"), RESPONSES_MODEL("shared")] })
  let cleanup: (() => Promise<void> | void) | undefined
  try {
    const result = await newapiProvider.setup(context)
    cleanup = typeof result === "function" ? result : undefined
  } finally {
    initial.restore()
  }
  assert.deepEqual(modelIDs(drafts), ["old-only", "shared"], "precondition: the old key's catalog is visible")
  return { drafts, connection, cleanup }
}

async function runRefresh(drafts: RecordedDrafts) {
  await drafts.commands.get("newapi-provider-refresh")!.execute({
    sessionID: "ses_test" as never,
    prompt: {} as never,
    delivery: {} as never,
  })
}

describe("credential-aware refresh: key rotation under the same connection id", () => {
  it("deactivates the old list once the key changes, and a failed fetch on the new key never restores it", async () => {
    const { drafts, connection, cleanup } = await loadWithOldKey()
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
    const { requests, restore } = stubModelsFetch({ object: "list", data: [] }, 500)
    try {
      connection.credential = { type: "key", key: ROTATED_KEY }
      const before = drafts.reloadCalls
      await assert.rejects(() => runRefresh(drafts))

      assert.deepEqual(
        requests.map((request) => request.authorization),
        [`Bearer ${ROTATED_KEY}`],
        "the round asked the instance with the rotated key only",
      )
      assert.deepEqual(modelIDs(drafts), [], "the old key's models are gone: the new key did not get a list")
      assert.ok(drafts.reloadCalls > before, "the deactivation and the outcome reached the host")
    } finally {
      console.warn = originalWarn
      restore()
      if (cleanup) await cleanup()
    }
    const diagnostics = warnings.join("\n")
    assert.match(diagnostics, /`packy-work`/, "the group is named")
    assert.doesNotMatch(diagnostics, /sk-fake-old|sk-fake-rotated/, "diagnostics contain neither key")
  })

  it("publishes the rotated key's list at once; the old key's late response cannot overwrite it", async () => {
    const { drafts, connection, cleanup } = await loadWithOldKey()

    // Deferred fetch: the test answers requests in a chosen order.
    const pending: Array<{ authorization: string; resolve: (payload: unknown) => void }> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const authorization = headers["authorization"] ?? headers["Authorization"] ?? ""
      return new Promise<Response>((resolve) => {
        pending.push({
          authorization,
          resolve: (payload: unknown) =>
            resolve(new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })),
        })
      })
    }) as unknown as typeof globalThis.fetch
    const reply = (authorization: string, ...ids: string[]) => {
      const index = pending.findIndex((request) => request.authorization === authorization)
      assert.ok(index >= 0, `no pending request with ${authorization}`)
      const [request] = pending.splice(index, 1)
      request.resolve({ object: "list", data: ids.map(RESPONSES_MODEL) })
    }
    const settle = () => new Promise((resolve) => setImmediate(resolve))

    try {
      // A refresh on the old key is in flight when the key rotates.
      const stale = runRefresh(drafts)
      await settle()
      assert.deepEqual(pending.map((request) => request.authorization), [`Bearer ${OLD_KEY}`])

      connection.credential = { type: "key", key: ROTATED_KEY }
      const fresh = runRefresh(drafts)
      await settle()
      assert.deepEqual(modelIDs(drafts), [], "the old list is deactivated as soon as the rotated key is seen")

      reply(`Bearer ${ROTATED_KEY}`, "rotated-only")
      await fresh
      assert.deepEqual(modelIDs(drafts), ["rotated-only"], "the rotated key's list is visible without a restart")

      reply(`Bearer ${OLD_KEY}`, "late-old-only")
      await stale
      await settle()
      assert.deepEqual(modelIDs(drafts), ["rotated-only"], "the old key's late response is discarded")
    } finally {
      globalThis.fetch = original
      if (cleanup) await cleanup()
    }
  })

  it("leaves the other groups alone when one group's key is rejected", async () => {
    const { context, drafts } = makeContext({
      options: {
        providers: [
          {
            base_url: "https://newapi.example.com",
            groups: [
              { id: "packy-work", name: "Packy Work" },
              { id: "packy-personal", name: "Packy Personal" },
            ],
          },
        ],
      },
      connection: {
        credentialsByIntegration: {
          "packy-work": { type: "key", key: OLD_KEY },
          "packy-personal": { type: "key", key: "sk-fake-personal" },
        },
      },
    })
    const unauthorized = { error: { message: "invalid access token" } }
    const stub = stubRoutedFetch((request) => ({
      payload: request.authorization === `Bearer ${OLD_KEY}` ? unauthorized : { object: "list", data: [RESPONSES_MODEL("personal-only")] },
      status: request.authorization === `Bearer ${OLD_KEY}` ? 403 : 200,
    }))
    let cleanup: (() => Promise<void> | void) | undefined
    try {
      const result = await newapiProvider.setup(context)
      cleanup = typeof result === "function" ? result : undefined
    } finally {
      stub.restore()
    }
    if (cleanup) await cleanup()

    assert.deepEqual(modelIDs(drafts, "packy-work"), [], "the rejected key's group lists nothing")
    assert.deepEqual(modelIDs(drafts, "packy-personal"), ["personal-only"], "the other group is served as usual")
  })
})

describe("credential-aware refresh: scope and edge outcomes", () => {
  const TWO_GROUPS = {
    providers: [
      {
        base_url: "https://newapi.example.com",
        groups: [
          { id: "packy-work", name: "Packy Work" },
          { id: "packy-personal", name: "Packy Personal" },
        ],
      },
    ],
  }

  it("a credential event for one group refreshes that group only", async () => {
    const { context, drafts, connection, emitEvent } = makeContext({
      options: TWO_GROUPS,
      connection: {
        credentialsByIntegration: {
          "packy-work": { type: "key", key: OLD_KEY },
          "packy-personal": { type: "key", key: "sk-fake-personal" },
        },
      },
    })
    const catalogFor = (authorization: string) =>
      authorization === `Bearer ${OLD_KEY}`
        ? [RESPONSES_MODEL("old-only")]
        : authorization === `Bearer ${ROTATED_KEY}`
          ? [RESPONSES_MODEL("rotated-only")]
          : [RESPONSES_MODEL("personal-only")]
    const stub = stubRoutedFetch((request) => ({ payload: { object: "list", data: catalogFor(request.authorization ?? "") } }))
    const until = async (condition: () => boolean) => {
      for (let waited = 0; !condition(); waited += 5) {
        assert.ok(waited < 2_000, "the event-driven refresh did not reach the instance in time")
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    let cleanup: (() => Promise<void> | void) | undefined
    try {
      const result = await newapiProvider.setup(context)
      cleanup = typeof result === "function" ? result : undefined
      const personalBefore = modelIDs(drafts, "packy-personal")
      const before = stub.requests.length

      connection.credentialsByIntegration = {
        ...connection.credentialsByIntegration,
        "packy-work": { type: "key", key: ROTATED_KEY },
      }
      emitEvent({ type: "credential.updated", data: { integrationID: "packy-work", credentialID: "cred" } })
      await until(() => stub.requests.length > before)
      await new Promise((resolve) => setTimeout(resolve, 30))

      assert.deepEqual(
        stub.requests.slice(before).map((request) => request.authorization),
        [`Bearer ${ROTATED_KEY}`],
        "only the group whose credential changed is asked again, with its new key",
      )
      assert.deepEqual(modelIDs(drafts), ["rotated-only"], "the new key's list is published without a restart")
      assert.deepEqual(modelIDs(drafts, "packy-personal"), personalBefore, "the other group's list is untouched")
    } finally {
      stub.restore()
      if (cleanup) await cleanup()
    }
  })

  it("an empty list served to the rotated key is a valid answer: it clears the group and is not a failure", async () => {
    const { drafts, connection, cleanup } = await loadWithOldKey()
    const { requests, restore } = stubModelsFetch({ object: "list", data: [] })
    try {
      connection.credential = { type: "key", key: ROTATED_KEY }
      await runRefresh(drafts)
    } finally {
      restore()
      if (cleanup) await cleanup()
    }
    assert.deepEqual(requests.map((request) => request.authorization), [`Bearer ${ROTATED_KEY}`])
    assert.deepEqual(modelIDs(drafts), [], "the old list is gone and nothing replaced it")
  })

  it("an unreadable success response keeps the list of an unchanged key", async () => {
    const { drafts, cleanup } = await loadWithOldKey()
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof globalThis.fetch
    try {
      await assert.rejects(() => runRefresh(drafts), /non-JSON/)
    } finally {
      globalThis.fetch = original
      if (cleanup) await cleanup()
    }
    assert.deepEqual(modelIDs(drafts), ["old-only", "shared"], "the same key's last good catalog survives an invalid response")
  })
})

describe("credential-aware refresh: the instance rejects the credential", () => {
  for (const status of [401, 403]) {
    it(`HTTP ${status} hides the connection's models and asks for a working key`, async () => {
      const { drafts, connection, cleanup } = await loadWithOldKey()
      const warnings: string[] = []
      const originalWarn = console.warn
      console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
      const { restore } = stubModelsFetch({ error: { message: "invalid access token" } }, status)
      try {
        await assert.rejects(() => runRefresh(drafts))
      } finally {
        console.warn = originalWarn
        restore()
        if (cleanup) await cleanup()
      }

      assert.deepEqual(modelIDs(drafts), [], "a rejected credential shows no models")
      const last = drafts.statusReports.at(-1)
      assert.equal(last?.integrationID, "packy-work")
      assert.equal((last?.status as { status?: string } | undefined)?.status, "needs_auth", "the connection is marked as needing auth")
      const diagnostics = warnings.join("\n")
      assert.match(diagnostics, /`packy-work`/)
      assert.match(diagnostics, new RegExp(`HTTP ${status}`))
      assert.doesNotMatch(diagnostics, /sk-fake-old/, "diagnostics contain no key")
      void connection
    })
  }

  it("keeps the list hidden through a later network failure on the same key, and shows it again after a success", async () => {
    const { drafts, cleanup } = await loadWithOldKey()
    const rejected = stubModelsFetch({ error: { message: "invalid access token" } }, 401)
    try {
      await assert.rejects(() => runRefresh(drafts))
    } finally {
      rejected.restore()
    }
    assert.deepEqual(modelIDs(drafts), [])

    const outage = stubModelsFetch({ object: "list", data: [] }, 500)
    try {
      await assert.rejects(() => runRefresh(drafts))
    } finally {
      outage.restore()
    }
    assert.deepEqual(modelIDs(drafts), [], "a network failure must not bring back a list the instance rejected")

    const recovered = stubModelsFetch({ object: "list", data: [RESPONSES_MODEL("back")] })
    try {
      await runRefresh(drafts)
    } finally {
      recovered.restore()
    }
    assert.deepEqual(modelIDs(drafts), ["back"], "a successful fetch on the same key restores the list")
    assert.equal((drafts.statusReports.at(-1)?.status as { status?: string } | undefined)?.status, undefined, "the auth warning is cleared")
    if (cleanup) await cleanup()
  })
})
