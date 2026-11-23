// Ticket 04: lifecycle. Load refreshes; the native `packyapi-refresh` command refreshes
// without any inference request; active-key changes refresh the right provider; a key
// change in flight never lets the old key's late result win; a same-key failure keeps
// the last good catalog; a legitimate empty catalog clears models; removed providers
// stop refreshing; cleanup stops the event loop.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { makeContext, stubModelsFetch, type RecordedRequest } from "./helpers/context.js"
import packyapi from "../src/index.js"

const RESPONSES_MODEL = (id: string) => ({ id, supported_endpoint_types: ["openai-response"] })

const OPTIONS = {
  providers: [{ id: "packy-work", name: "Packy Work" }],
}

/** Deferred fetch factory: tests resolve requests in a chosen order. */
interface PendingFetch {
  authorization: string
  resolve: (payload: unknown) => void
}

function stubDeferredFetch(): {
  requests: RecordedRequest[]
  pending: PendingFetch[]
  replyIndex: (index: number, data: Array<{ id: string }>) => void
  restore: () => void
} {
  const requests: RecordedRequest[] = []
  const pending: PendingFetch[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const authorization = headers["authorization"] ?? headers["Authorization"] ?? ""
    requests.push({ url: String(input), authorization })
    const response = await new Promise<Response>((resolve) => {
      pending.push({
        authorization,
        resolve: (payload: unknown) => {
          resolve(new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }))
        },
      })
    })
    return response
  }) as unknown as typeof globalThis.fetch
  const replyIndex = (index: number, data: Array<{ id: string }>) => {
    const entry = pending[index]
    assert.ok(entry, `no pending request at index ${index}`)
    pending.splice(index, 1)
    entry.resolve({ object: "list", data })
  }
  return { requests, pending, replyIndex, restore: () => (globalThis.fetch = original) }
}

async function drainMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe("lifecycle: manual refresh command", () => {
  it("registers a native command and executing it refreshes without any inference", async () => {
    const { context, drafts } = makeContext({
      options: OPTIONS,
      connection: { credential: { type: "key", key: "sk-fake-work" } },
    })
    const { restore } = stubModelsFetch({ object: "list", data: [RESPONSES_MODEL("resp-1")] })

    let cleanup: (() => Promise<void> | void) | undefined
    try {
      cleanup = normalizeCleanup(await packyapi.setup(context))
    } finally {
      restore()
    }

    const command = drafts.commands.get("packyapi-refresh")
    assert.ok(command, "native refresh command registered")

    const { requests, restore: restore2 } = stubModelsFetch({
      object: "list",
      data: [RESPONSES_MODEL("resp-2")],
    })
    try {
      await command!.execute({ sessionID: "ses_test" as never, prompt: {} as never, delivery: {} as never })
    } finally {
      restore2()
    }

    assert.equal(requests.length, 1, "manual refresh performs model discovery")
    assert.equal(requests[0]!.url, "https://www.packyapi.ai/v1/models", "discovery only, no inference request")
    assert.equal(
      drafts.providers.get("packy-work")!.models.has("resp-2"),
      true,
      "the refreshed catalog replaced the registered models",
    )
    if (cleanup) await cleanup()
  })

  it("a failed manual refresh keeps the last good catalog and reports a sanitized error", async () => {
    const { context, drafts } = makeContext({
      options: OPTIONS,
      connection: { credential: { type: "key", key: "sk-fake-work" } },
    })
    const first = stubModelsFetch({ object: "list", data: [RESPONSES_MODEL("resp-1")] })
    let cleanup: (() => Promise<void> | void) | undefined
    try {
      cleanup = normalizeCleanup(await packyapi.setup(context))
    } finally {
      first.restore()
    }

    const command = drafts.commands.get("packyapi-refresh")!
    const second = stubModelsFetch({ object: "list", data: [] }, 500)
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
    try {
      await assert.rejects(() =>
        command.execute({ sessionID: "ses_test" as never, prompt: {} as never, delivery: {} as never }),
      )
    } finally {
      console.warn = originalWarn
      second.restore()
    }

    assert.equal(
      drafts.providers.get("packy-work")!.models.has("resp-1"),
      true,
      "same-key failure keeps the last good catalog",
    )
    const output = warnings.join("\n")
    assert.doesNotMatch(output, /sk-fake-work/, "failure output never contains the key")
    if (cleanup) await cleanup()
  })
})

describe("lifecycle: source identity invalidation", () => {
  it("clears a changed-credential catalog before fetching, and a failed fetch on the new key never restores it", async () => {
    const { context, drafts, connection } = makeContext({
      options: OPTIONS,
      connection: { id: "cred-1", credential: { type: "key", key: "sk-fake-work" } },
    })
    const reloadMarks: string[] = []
    const requests: RecordedRequest[] = []
    const pendingResolvers: Array<(payload: unknown) => void> = []
    const original = globalThis.fetch
    let firstFetchDone = false
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const authorization = headers["authorization"] ?? headers["Authorization"] ?? ""
      requests.push({ url: String(input), authorization })
      reloadMarks.push(`fetch:${authorization}`)
      if (!firstFetchDone) {
        firstFetchDone = true
        return new Response(
          JSON.stringify({ object: "list", data: [RESPONSES_MODEL("resp-1")] }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      // The rotated-credential discovery hangs until the test resolves it.
      reloadMarks.push(`pending:${authorization}`)
      await new Promise<void>((resolve) => {
        pendingResolvers.push(() => {
          reloadMarks.push(`resolved:${authorization}`)
          resolve()
        })
      })
      return new Response(JSON.stringify({ object: "list", data: [] }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch

    let cleanup: (() => Promise<void> | void) | undefined
    try {
      cleanup = normalizeCleanup(await packyapi.setup(context))
      assert.ok(drafts.providers.get("packy-work")!.models.has("resp-1"), "initial catalog registered")

      // The active credential is replaced; the manual refresh must discard the old
      // catalog BEFORE the new fetch resolves (and even before it is answered).
      connection.id = "cred-2"
      connection.credential = { type: "key", key: "sk-rotated" }
      const command = drafts.commands.get("packyapi-refresh")!
      const execution = command.execute({
        sessionID: "ses_test" as never,
        prompt: {} as never,
        delivery: {} as never,
      })
      await drainMicrotasks()

      assert.ok(
        !drafts.providers.get("packy-work")!.models.has("resp-1"),
        "the old catalog is discarded before the new fetch completes",
      )
      assert.ok(
        reloadMarks.includes("pending:Bearer sk-rotated"),
        "the rotated discovery is in flight while the catalog is already cleared",
      )
      assert.ok(
        reloadMarks.indexOf("pending:Bearer sk-rotated") > reloadMarks.indexOf("fetch:Bearer sk-fake-work"),
        "invalidation happens on the new refresh round, not during setup",
      )

      pendingResolvers.splice(0).forEach((resolve) => resolve(undefined))
      await assert.rejects(
        () => execution,
        (error: unknown) => {
          const message = String((error as Error).message)
          assert.match(message, /no catalog/, "the failed round reports the missing catalog")
          assert.doesNotMatch(message, /sk-rotated|sk-fake-work/, "the reported problem stays sanitized")
          return true
        },
      )

      assert.equal(
        drafts.providers.get("packy-work")!.models.has("resp-1"),
        false,
        "a failure on the NEW key never restores the OLD key's catalog",
      )
    } finally {
      if (cleanup) await cleanup()
      globalThis.fetch = original
    }
  })

  it("keeps the last good catalog when the same credential fails", async () => {
    const { context, drafts } = makeContext({
      options: OPTIONS,
      connection: { id: "cred-1", credential: { type: "key", key: "sk-fake-work" } },
    })
    const first = stubModelsFetch({ object: "list", data: [RESPONSES_MODEL("resp-1")] })
    let cleanup: (() => Promise<void> | void) | undefined
    try {
      cleanup = normalizeCleanup(await packyapi.setup(context))
    } finally {
      first.restore()
    }
    const command = drafts.commands.get("packyapi-refresh")!
    const second = stubModelsFetch({ object: "list", data: [] }, 500)
    try {
      await assert.rejects(() =>
        command.execute({ sessionID: "ses_test" as never, prompt: {} as never, delivery: {} as never }),
      )
    } finally {
      second.restore()
    }
    assert.equal(
      drafts.providers.get("packy-work")!.models.has("resp-1"),
      true,
      "same-credential failure keeps the last good catalog",
    )
    if (cleanup) await cleanup()
  })
})

describe("lifecycle: cleanup", () => {
  it("invalidates in-flight refreshes: a late result is dropped and never reloads", async () => {
    const { context, drafts } = makeContext({
      options: OPTIONS,
      connection: { credential: { type: "key", key: "sk-fake-work" } },
    })
    const stub = stubDeferredFetch()

    const setupPromise = packyapi.setup(context)
    await drainMicrotasks()
    stub.replyIndex(0, [RESPONSES_MODEL("resp-1")])
    const cleanup = await setupPromise
    assert.ok(cleanup, "setup returns a cleanup")
    const reloadsBefore = drafts.reloadCalls

    const command = drafts.commands.get("packyapi-refresh")!
    const inFlight = command.execute({
      sessionID: "ses_test" as never,
      prompt: {} as never,
      delivery: {} as never,
    })
    await drainMicrotasks()
    await drainMicrotasks()

    if (cleanup) await cleanup()
    stub.replyIndex(0, [RESPONSES_MODEL("resp-late")])
    await inFlight
    await drainMicrotasks()

    const models = drafts.providers.get("packy-work")!.models
    assert.equal(models.has("resp-late"), false, "the late result after cleanup is discarded")
    assert.equal(
      drafts.reloadCalls,
      reloadsBefore,
      "a superseded refresh does not trigger another provider reload",
    )
    stub.restore()
  })
})

describe("lifecycle: credential events", () => {
  it("a credential.switched event refreshes that provider with the new key", async () => {
    const { context, drafts, emitEvent, connection } = makeContext({
      options: OPTIONS,
      connection: { credential: { type: "key", key: "sk-fake-work" } },
    })
    const requests: RecordedRequest[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const authorization = headers["authorization"] ?? headers["Authorization"] ?? ""
      requests.push({ url: String(input), authorization })
      const data =
        authorization === "Bearer sk-rotated" ? [RESPONSES_MODEL("resp-rotated")] : [RESPONSES_MODEL("resp-1")]
      return new Response(
        JSON.stringify({ object: "list", data }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof globalThis.fetch

    let cleanup: (() => Promise<void> | void) | undefined
    try {
      cleanup = normalizeCleanup(await packyapi.setup(context))

      assert.equal(requests[0]?.authorization, "Bearer sk-fake-work", "load refreshes with the active key")

      connection.credential = { type: "key", key: "sk-rotated" }
      const before = requests.length
      emitEvent({ type: "credential.switched", data: { integrationID: "packy-work", credentialID: "cred-2" } })
      await drainMicrotasks()

      assert.ok(requests.length > before, "the switch triggered a new discovery")
      assert.equal(
        requests[requests.length - 1]?.authorization,
        "Bearer sk-rotated",
        "the new discovery used the rotated key",
      )
      assert.equal(
        drafts.providers.get("packy-work")!.models.has("resp-rotated"),
        true,
        "the rotated catalog replaced the old one",
      )
    } finally {
      if (cleanup) await cleanup()
      globalThis.fetch = original
    }
  })

  it("a late result from the old key never overwrites the new key's catalog", async () => {
    const { context, drafts } = makeContext({
      options: OPTIONS,
      connection: { credential: { type: "key", key: "sk-fake-work" } },
    })
    const stub = stubDeferredFetch()

    const setupPromise = packyapi.setup(context)
    await drainMicrotasks()
    stub.replyIndex(0, [RESPONSES_MODEL("resp-1")])
    const cleanup = await setupPromise

    const command = drafts.commands.get("packyapi-refresh")!
    const executionSlow = command.execute({
      sessionID: "ses_test" as never,
      prompt: {} as never,
      delivery: {} as never,
    })
    await drainMicrotasks()
    const executionFast = command.execute({
      sessionID: "ses_test" as never,
      prompt: {} as never,
      delivery: {} as never,
    })
    await drainMicrotasks()

    // The fast (newer) refresh completes first; the slow (older) one lands afterwards.
    stub.replyIndex(1, [RESPONSES_MODEL("resp-new")])
    await executionFast
    stub.replyIndex(0, [RESPONSES_MODEL("resp-stale-old")])
    await executionSlow
    await drainMicrotasks()

    const models = drafts.providers.get("packy-work")!.models
    assert.ok(models.has("resp-new"), "the newer refresh's catalog is applied")
    assert.equal(models.has("resp-stale-old"), false, "the old late result is discarded")
    if (cleanup) await cleanup()
    stub.restore()
  })

  it("refreshes two providers concurrently without one blocking the other", async () => {
    const options = {
      providers: [
        { id: "packy-work", name: "Packy Work" },
        { id: "packy-personal", name: "Packy Personal" },
      ],
    }
    const { context, drafts } = makeContext({
      options,
      connection: {
        credentialsByIntegration: {
          "packy-work": { type: "key", key: "sk-fake-work" },
          "packy-personal": { type: "key", key: "sk-fake-personal" },
        },
      },
    })
    const stub = stubDeferredFetch()

    const setupPromise = packyapi.setup(context)
    await drainMicrotasks()
    // Reply in descending index order: each reply splices the pending list.
    stub.replyIndex(1, [RESPONSES_MODEL("resp-2")])
    stub.replyIndex(0, [RESPONSES_MODEL("resp-1")])
    const cleanup = await setupPromise

    const command = drafts.commands.get("packyapi-refresh")!
    const execution = command.execute({ sessionID: "ses_test" as never, prompt: {} as never, delivery: {} as never })
    await drainMicrotasks()
    await drainMicrotasks()
    // Personal's discovery returns first; work's delayed response must still land.
    stub.replyIndex(1, [RESPONSES_MODEL("resp-personal-new")])
    await drainMicrotasks()
    stub.replyIndex(0, [RESPONSES_MODEL("resp-work-new")])
    await execution

    const work = drafts.providers.get("packy-work")!.models
    const personal = drafts.providers.get("packy-personal")!.models
    assert.ok(work.has("resp-work-new"), "delayed provider catalog still applied")
    assert.ok(personal.has("resp-personal-new"), "fast provider catalog applied")
    assert.equal(work.has("resp-personal-new"), false, "catalogs stay isolated")
    if (cleanup) await cleanup()
    stub.restore()
  })

  it("an empty but successful catalog clears the models", async () => {
    const { context, drafts } = makeContext({
      options: OPTIONS,
      connection: { credential: { type: "key", key: "sk-fake-work" } },
    })
    const first = stubModelsFetch({ object: "list", data: [RESPONSES_MODEL("resp-1")] })
    let cleanup: (() => Promise<void> | void) | undefined
    try {
      cleanup = normalizeCleanup(await packyapi.setup(context))
    } finally {
      first.restore()
    }

    const command = drafts.commands.get("packyapi-refresh")!
    const second = stubModelsFetch({ object: "list", data: [] })
    try {
      await command.execute({ sessionID: "ses_test" as never, prompt: {} as never, delivery: {} as never })
    } finally {
      second.restore()
    }

    assert.equal(
      drafts.providers.get("packy-work")!.models.size,
      0,
      "a legitimate empty catalog clears the models",
    )
    if (cleanup) await cleanup()
  })

  it("stopping the plugin stops refreshes: events no longer trigger discovery", async () => {
    const { context, drafts, emitEvent } = makeContext({
      options: OPTIONS,
      connection: { credential: { type: "key", key: "sk-fake-work" } },
    })
    const first = stubModelsFetch({ object: "list", data: [RESPONSES_MODEL("resp-1")] })
    let cleanup: (() => Promise<void> | void) | undefined
    try {
      cleanup = normalizeCleanup(await packyapi.setup(context))
    } finally {
      first.restore()
    }
    assert.ok(cleanup, "setup returns a cleanup")

    await cleanup()
    const before = drafts.setModelCalls.length
    const second = stubModelsFetch({ object: "list", data: [RESPONSES_MODEL("resp-after")], })
    emitEvent({ type: "credential.switched", data: { integrationID: "packy-work", credentialID: "cred-2" } })
    await drainMicrotasks()
    second.restore()

    assert.equal(
      drafts.setModelCalls.length,
      before,
      "no refresh runs after cleanup",
    )
  })
})

function normalizeCleanup(result: Awaited<ReturnType<typeof packyapi.setup>>): (() => Promise<void> | void) | undefined {
  return typeof result === "function" ? result : undefined
}
