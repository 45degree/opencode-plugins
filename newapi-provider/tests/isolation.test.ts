// Ticket 03: groups are isolated. Each discovery uses its own active key, catalogs
// are never merged across keys, one failing group does not affect another, and no
// error or diagnostic output ever contains a key.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { makeContext, stubModelsFetch, type RecordedRequest } from "./helpers/context.js"
import newapiProvider from "../src/index.js"

/** One instance with a work and a personal group: the same deployment, different keys. */
const BOTH_PROVIDERS = {
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

const RESPONSES_MODEL = (id: string) => ({ id, supported_endpoint_types: ["openai-response"] })

/** Serve a key-dependent catalog: each fake key sees a different visibility. */
function stubKeyAwareFetch(): { requests: RecordedRequest[]; restore: () => void } {
  const requests: RecordedRequest[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const authorization = headers["authorization"] ?? headers["Authorization"] ?? ""
    requests.push({ url: String(input), authorization })
    const data =
      authorization === "Bearer sk-fake-work"
        ? [RESPONSES_MODEL("work-only"), RESPONSES_MODEL("shared-model")]
        : authorization === "Bearer sk-fake-personal"
          ? [RESPONSES_MODEL("shared-model")]
          : []
    return new Response(JSON.stringify({ object: "list", data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof globalThis.fetch
  return { requests, restore: () => (globalThis.fetch = original) }
}

describe("setup: multi-provider isolation", () => {
  it("discovers each provider with its own active key and never merges catalogs", async () => {
    const { context, drafts } = makeContext({
      options: BOTH_PROVIDERS,
      connection: {
        credentialsByIntegration: {
          "packy-work": { type: "key", key: "sk-fake-work" },
          "packy-personal": { type: "key", key: "sk-fake-personal" },
        },
      },
    })
    const { requests, restore } = stubKeyAwareFetch()

    try {
      await newapiProvider.setup(context)
    } finally {
      restore()
    }

    assert.equal(requests.length, 2, "one discovery request per provider")
    const authorizations = requests.map((r) => r.authorization).sort()
    assert.deepEqual(authorizations, ["Bearer sk-fake-personal", "Bearer sk-fake-work"])

    const work = drafts.providers.get("packy-work")!.models
    const personal = drafts.providers.get("packy-personal")!.models
    assert.ok(work.has("work-only"), "work provider sees its own model")
    assert.equal(personal.has("work-only"), false, "personal provider must not see work's model")
    assert.ok(work.has("shared-model") && personal.has("shared-model"), "shared model exists under both providers")
  })

  it("isolates a failing provider: the healthy provider still discovers and registers", async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
    const { context, drafts } = makeContext({
      options: BOTH_PROVIDERS,
      connection: {
        credentialsByIntegration: {
          "packy-work": { type: "key", key: "sk-fake-work" },
          "packy-personal": { type: "key", key: "sk-fake-personal" },
        },
      },
    })
    const requests: RecordedRequest[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const authorization = headers["authorization"] ?? headers["Authorization"] ?? ""
      requests.push({ url: String(input), authorization })
      const status = authorization === "Bearer sk-fake-work" ? 500 : 200
      const data = status === 200 ? [RESPONSES_MODEL("resp-1")] : []
      return new Response(JSON.stringify({ object: "list", data }), {
        status,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch
    const restore = () => (globalThis.fetch = original)

    try {
      await newapiProvider.setup(context)
    } finally {
      console.warn = originalWarn
      restore()
    }

    const diagnostics = warnings.join("\n")
    assert.match(diagnostics, /packy-work/, "the failing provider is named")
    assert.match(diagnostics, /HTTP 500/, "the failure classification is reported")
    assert.doesNotMatch(diagnostics, /sk-fake/, "diagnostics contain no key")

    const work = drafts.providers.get("packy-work")
    const personal = drafts.providers.get("packy-personal")
    assert.ok(work, "failing provider still registered (no callable models)")
    assert.equal(work!.models.size, 0)
    assert.ok(personal, "healthy provider registered")
    assert.ok(personal!.models.has("resp-1"), "healthy provider discovered its catalog")
  })

  it("never places a key into provider ids, integration ids or model ids", async () => {
    const { context, drafts } = makeContext({
      options: BOTH_PROVIDERS,
      connection: { credential: { type: "key", key: "sk-fake-work" } },
    })
    const { restore } = stubModelsFetch({ object: "list", data: [RESPONSES_MODEL("shared-model")] })

    try {
      await newapiProvider.setup(context)
    } finally {
      restore()
    }

    const allRegisteredIDs = [
      ...drafts.integrations.keys(),
      ...drafts.providers.keys(),
      ...[...drafts.providers.values()].flatMap((entry) => [...entry.models.keys()]),
    ]
    for (const id of allRegisteredIDs) {
      assert.doesNotMatch(id, /sk-fake/, `registered id ${JSON.stringify(id)} must never contain a key`)
    }
  })
})
