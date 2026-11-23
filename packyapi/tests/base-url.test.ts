// A single optional options.baseURL (gateway root) is shared by every provider of
// this plugin instance. It accepts the bare root, an explicit /v1 or /v1beta
// suffix, and trailing slashes; proxy prefixes are preserved. The plugin derives
// the discovery URL ({root}/v1/models) and the per-protocol inference roots from
// the normalized gateway root.
//
// Real local HTTP servers are used so the asserted URLs are the ones actually sent.

import { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { makeContext } from "./helpers/context.js"
import packyapi from "../src/index.js"

const RESPONSES_MODEL = (id: string) => ({ id, supported_endpoint_types: ["openai-response"] })

interface ServerRecord {
  port: number
  requests: Array<{ path: string; authorization: string | undefined }>
  stop: () => Promise<void>
}

function startCatalogServer(): Promise<ServerRecord> {
  const requests: Array<{ path: string; authorization: string | undefined }> = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push({ path: req.url ?? "", authorization: req.headers["authorization"] })
    res.writeHead(200, { "content-type": "application/json" })
    const auth = req.headers["authorization"] ?? ""
    const tag = auth.endsWith("sk-key-a") ? "key-a" : auth.endsWith("sk-key-b") ? "key-b" : auth.slice(-4)
    res.end(
      JSON.stringify({
        object: "list",
        data: [RESPONSES_MODEL(`model-on-${tag}`)],
      }),
    )
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port
      resolve({
        port,
        requests,
        stop: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

const cleanupQueue: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const stop of cleanupQueue.splice(0).reverse()) await stop()
})

async function startAndTrack(): Promise<ServerRecord> {
  const server = await startCatalogServer()
  cleanupQueue.push(server.stop)
  return server
}

/** Passes only loopback requests to the real fetch; anything else is blocked and recorded. */
function guardLocalFetch(): { fetch: typeof globalThis.fetch; blocked: string[] } {
  const blocked: string[] = []
  const real = globalThis.fetch
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes("127.0.0.1")) {
      blocked.push(url)
      return new Response(JSON.stringify({ object: "list", data: [] }), { status: 404 })
    }
    return real(url, init)
  }) as unknown as typeof globalThis.fetch
  return { fetch, blocked }
}

function normalizeCleanup(result: Awaited<ReturnType<typeof packyapi.setup>>): (() => Promise<void> | void) | undefined {
  return typeof result === "function" ? result : undefined
}

describe("options.baseURL: one gateway root for the whole plugin instance", () => {
  it("keeps the official default path when no baseURL is configured", async () => {
    const { context, drafts } = makeContext({
      options: { providers: [{ id: "packy-work", name: "Packy Work" }] },
      connection: { credential: { type: "key", key: "sk-fake-work" } },
    })
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (async (input: string | URL) => {
      seen.push(String(input))
      return new Response(JSON.stringify({ object: "list", data: [RESPONSES_MODEL("resp-1")] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch
    let cleanup: (() => Promise<void> | void) | undefined
    try {
      cleanup = normalizeCleanup(await packyapi.setup(context))
    } finally {
      globalThis.fetch = original
    }
    assert.equal(seen[0], "https://www.packyapi.ai/v1/models", "the official discovery URL is the default")
    assert.equal(
      drafts.providers.get("packy-work")!.provider.settings?.baseURL,
      "https://www.packyapi.ai/v1",
      "the official inference API root is the default",
    )
    if (cleanup) await cleanup()
  })

  it("discovers every provider of the instance from the shared root, each with its own key", async () => {
    const server = await startAndTrack()
    // Keep every request OFF the real network: only 127.0.0.1 passes through.
    const { fetch: guard, blocked } = guardLocalFetch()
    const original = globalThis.fetch
    globalThis.fetch = guard
    const { context, drafts } = makeContext({
      options: {
        baseURL: `http://127.0.0.1:${server.port}`,
        providers: [
          { id: "packy-work", name: "Packy Work" },
          { id: "packy-personal", name: "Packy Personal" },
        ],
      },
      connection: {
        credentialsByIntegration: {
          "packy-work": { type: "key", key: "sk-key-a" },
          "packy-personal": { type: "key", key: "sk-key-b" },
        },
      },
    })

    const cleanup = await packyapi.setup(context)
    globalThis.fetch = original
    if (typeof cleanup === "function") await cleanup()
    assert.deepEqual(blocked, [], "no request may leave for non-local endpoints")

    assert.deepEqual(server.requests.map((r) => r.path), ["/v1/models", "/v1/models"], "both discoveries share the gateway root")
    assert.deepEqual(
      server.requests.map((r) => r.authorization).sort(),
      ["Bearer sk-key-a", "Bearer sk-key-b"],
      "each provider still uses its own key",
    )
    assert.equal(drafts.providers.get("packy-work")!.provider.settings?.baseURL, `http://127.0.0.1:${server.port}/v1`)
    assert.equal(drafts.providers.get("packy-personal")!.provider.settings?.baseURL, `http://127.0.0.1:${server.port}/v1`)
    assert.ok(drafts.providers.get("packy-work")!.models.has("model-on-key-a"))
    assert.ok(drafts.providers.get("packy-personal")!.models.has("model-on-key-b"))
  })

  it("normalizes proxy paths, explicit version suffixes and trailing slashes to the gateway root", async () => {
    const server = await startAndTrack()
    const cases: Array<{ raw: string; expectedModelsPath: string; expectedInferenceRoot: string }> = [
      { raw: `http://127.0.0.1:${server.port}/proxy/v1`, expectedModelsPath: "/proxy/v1/models", expectedInferenceRoot: "/proxy/v1" },
      { raw: `http://127.0.0.1:${server.port}/proxy`, expectedModelsPath: "/proxy/v1/models", expectedInferenceRoot: "/proxy/v1" },
      { raw: `http://127.0.0.1:${server.port}/proxy/`, expectedModelsPath: "/proxy/v1/models", expectedInferenceRoot: "/proxy/v1" },
      { raw: `http://127.0.0.1:${server.port}/proxy/v1beta`, expectedModelsPath: "/proxy/v1/models", expectedInferenceRoot: "/proxy/v1" },
    ]
    for (const [index, { raw, expectedModelsPath, expectedInferenceRoot }] of cases.entries()) {
      server.requests.length = 0
      const providerID = `packy-p${index}`
      const { fetch: guard } = guardLocalFetch()
      const original = globalThis.fetch
      globalThis.fetch = guard
      const { context, drafts } = makeContext({
        options: { baseURL: raw, providers: [{ id: providerID, name: providerID }] },
        connection: { credentialsByIntegration: { [providerID]: { type: "key", key: `sk-${providerID}` } } },
      })
      const cleanup = await packyapi.setup(context)
      globalThis.fetch = original
      if (typeof cleanup === "function") await cleanup()
      assert.deepEqual(
        server.requests.map((r) => r.path),
        [expectedModelsPath],
        `discovery for ${raw} must target the normalized root`,
      )
      assert.equal(
        drafts.providers.get(providerID)!.provider.settings?.baseURL,
        `http://127.0.0.1:${server.port}${expectedInferenceRoot}`,
        `the inference root for ${raw} must keep the proxy path with /v1`,
      )
    }
  })

  it("rejects invalid baseURL values with a config error that does not echo the value", async () => {
    for (const raw of ["not a url at all", "ftp://127.0.0.1/x"]) {
      const { context } = makeContext({
        options: { baseURL: raw, providers: [{ id: "packy-work", name: "Packy Work" }] },
      })
      const original = globalThis.fetch
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ object: "list", data: [] }), { status: 404 })) as unknown as typeof globalThis.fetch
      await assert.rejects(
        async () => {
          await packyapi.setup(context)
        },
        (error: unknown) => {
          const message = String((error as Error).message)
          assert.match(message, /packyapi config error/)
          assert.match(message, /baseURL/)
          assert.doesNotMatch(message, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the value is never echoed")
          return true
        },
      )
      globalThis.fetch = original
    }
  })
})
