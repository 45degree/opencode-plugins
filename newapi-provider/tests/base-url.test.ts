// Issue 07: every instance carries its own `base_url`. It accepts the bare root,
// an explicit /v1 or /v1beta suffix and trailing slashes; a reverse-proxy path
// prefix is preserved. The plugin derives each group's discovery URL
// ({root}/v1/models) and inference roots ({root}/v1, {root}/v1beta) from the
// normalized root. Addresses carrying credentials, query parameters or a fragment
// are rejected without echoing the value.
//
// Real local HTTP servers are used so the asserted URLs are the ones actually sent.

import { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { makeContext, stubModelsFetch } from "./helpers/context.js"
import newapiProvider from "../src/index.js"

const RESPONSES_MODEL = (id: string) => ({ id, supported_endpoint_types: ["openai-response"] })

interface ServerRecord {
  port: number
  requests: Array<{ path: string; authorization: string | undefined }>
  stop: () => Promise<void>
}

/** A local New API instance: answers /v1/models with one model named after the calling key. */
function startCatalogServer(): Promise<ServerRecord> {
  const requests: Array<{ path: string; authorization: string | undefined }> = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push({ path: req.url ?? "", authorization: req.headers["authorization"] })
    res.writeHead(200, { "content-type": "application/json" })
    const tag = (req.headers["authorization"] ?? "").slice("Bearer sk-".length)
    res.end(JSON.stringify({ object: "list", data: [RESPONSES_MODEL(`model-on-${tag}`)] }))
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

function normalizeCleanup(result: Awaited<ReturnType<typeof newapiProvider.setup>>): (() => Promise<void> | void) | undefined {
  return typeof result === "function" ? result : undefined
}

const groupOptions = (baseURL: string, ...ids: string[]) => ({
  providers: [{ base_url: baseURL, groups: ids.map((id) => ({ id, name: id })) }],
})
const keysFor = (...ids: string[]) =>
  Object.fromEntries(ids.map((id) => [id, { type: "key", key: `sk-${id}` }]))

describe("providers[].base_url: one root per instance", () => {
  it("normalizes proxy paths, explicit version suffixes and trailing slashes to the instance root", async () => {
    const server = await startAndTrack()
    const cases = [
      { suffix: "", modelsPath: "/v1/models", inferenceRoot: "/v1" },
      { suffix: "/v1", modelsPath: "/v1/models", inferenceRoot: "/v1" },
      { suffix: "/proxy", modelsPath: "/proxy/v1/models", inferenceRoot: "/proxy/v1" },
      { suffix: "/proxy/", modelsPath: "/proxy/v1/models", inferenceRoot: "/proxy/v1" },
      { suffix: "/proxy/v1", modelsPath: "/proxy/v1/models", inferenceRoot: "/proxy/v1" },
      { suffix: "/proxy/v1beta", modelsPath: "/proxy/v1/models", inferenceRoot: "/proxy/v1" },
      { suffix: "/proxy/v1beta/", modelsPath: "/proxy/v1/models", inferenceRoot: "/proxy/v1" },
      { suffix: "/proxy/v1//", modelsPath: "/proxy/v1/models", inferenceRoot: "/proxy/v1" },
      // A doubled slash between the proxy path and the version suffix: the root
      // must come out clean, or the derived roots would carry "//v1".
      { suffix: "/proxy//v1", modelsPath: "/proxy/v1/models", inferenceRoot: "/proxy/v1" },
    ]
    for (const [index, { suffix, modelsPath, inferenceRoot }] of cases.entries()) {
      server.requests.length = 0
      const groupID = `base-p${index}`
      const { fetch: guard, blocked } = guardLocalFetch()
      const original = globalThis.fetch
      globalThis.fetch = guard
      const { context, drafts } = makeContext({
        options: groupOptions(`http://127.0.0.1:${server.port}${suffix}`, groupID),
        connection: { credentialsByIntegration: keysFor(groupID) },
      })
      let cleanup: (() => Promise<void> | void) | undefined
      try {
        cleanup = normalizeCleanup(await newapiProvider.setup(context))
      } finally {
        globalThis.fetch = original
      }
      if (cleanup) await cleanup()

      assert.deepEqual(blocked, [], `no request may leave for non-local endpoints (${suffix})`)
      assert.deepEqual(server.requests.map((r) => r.path), [modelsPath], `discovery for ${suffix} targets the normalized root`)
      assert.equal(
        drafts.providers.get(groupID)!.provider.settings?.baseURL,
        `http://127.0.0.1:${server.port}${inferenceRoot}`,
        `the inference root for ${suffix} keeps the proxy path with /v1`,
      )
    }
  })

  it("derives every group's discovery and inference root from the instance it belongs to", async () => {
    const proxied = await startAndTrack()
    const bare = await startAndTrack()
    // Keep every request OFF the real network: only 127.0.0.1 passes through.
    const { fetch: guard, blocked } = guardLocalFetch()
    const original = globalThis.fetch
    globalThis.fetch = guard
    const { context, drafts } = makeContext({
      options: {
        providers: [
          {
            base_url: `http://127.0.0.1:${proxied.port}/gw/v1`,
            groups: [
              { id: "a-work", name: "A Work" },
              { id: "a-personal", name: "A Personal" },
            ],
          },
          { base_url: `http://127.0.0.1:${bare.port}`, groups: [{ id: "b-team", name: "B Team" }] },
        ],
      },
      connection: { credentialsByIntegration: keysFor("a-work", "a-personal", "b-team") },
    })

    let cleanup: (() => Promise<void> | void) | undefined
    try {
      cleanup = normalizeCleanup(await newapiProvider.setup(context))
    } finally {
      globalThis.fetch = original
    }
    if (cleanup) await cleanup()
    assert.deepEqual(blocked, [], "no request may leave for non-local endpoints")

    const sent = (server: ServerRecord) => server.requests.map((r) => [r.path, r.authorization]).sort()
    assert.deepEqual(sent(proxied), [
      ["/gw/v1/models", "Bearer sk-a-personal"],
      ["/gw/v1/models", "Bearer sk-a-work"],
    ], "both groups of the proxied instance ask its normalized root, each with its own key")
    assert.deepEqual(sent(bare), [["/v1/models", "Bearer sk-b-team"]], "the bare instance is asked at its own root")

    assert.equal(drafts.providers.get("a-work")!.provider.settings?.baseURL, `http://127.0.0.1:${proxied.port}/gw/v1`)
    assert.equal(drafts.providers.get("a-personal")!.provider.settings?.baseURL, `http://127.0.0.1:${proxied.port}/gw/v1`)
    assert.equal(drafts.providers.get("b-team")!.provider.settings?.baseURL, `http://127.0.0.1:${bare.port}/v1`)

    const models = (groupID: string) => [...drafts.providers.get(groupID)!.models.keys()].sort()
    assert.deepEqual(models("a-work"), ["model-on-a-work"])
    assert.deepEqual(models("a-personal"), ["model-on-a-personal"])
    assert.deepEqual(models("b-team"), ["model-on-b-team"])
  })

  it("rejects addresses with credentials, query parameters or a fragment without echoing the value", async () => {
    const cases: Array<{ raw: string; reason: RegExp }> = [
      { raw: "http://secret-user:secret-pass@newapi.example.com/proxy", reason: /username or password/ },
      { raw: "http://secret-user@newapi.example.com/proxy", reason: /username or password/ },
      { raw: "http://@newapi.example.com/proxy", reason: /username or password/ },
      { raw: "http://newapi.example.com/proxy?api_key=secret-query", reason: /query/ },
      // A bare delimiter carries nothing, and is not silently dropped either.
      { raw: "http://newapi.example.com?", reason: /query/ },
      { raw: "http://newapi.example.com/proxy#secret-fragment", reason: /fragment/ },
      { raw: "http://newapi.example.com/proxy#", reason: /fragment/ },
    ]
    for (const { raw, reason } of cases) {
      const { context, drafts } = makeContext({
        options: groupOptions(raw, "packy-work"),
        connection: { credentialsByIntegration: keysFor("packy-work") },
      })
      const { requests, restore } = stubModelsFetch({ object: "list", data: [] })
      try {
        await assert.rejects(
          async () => {
            await newapiProvider.setup(context)
          },
          (error: unknown) => {
            const message = String((error as Error).message)
            assert.match(message, /newapi-provider config error/)
            assert.match(message, /providers\[0\]\.base_url/, `names the field: ${message}`)
            assert.match(message, reason, `states the reason: ${message}`)
            assert.doesNotMatch(message, /secret-/, "the value is never echoed")
            return true
          },
        )
      } finally {
        restore()
      }
      assert.deepEqual(requests, [], `no request is sent for ${raw}`)
      assert.equal(drafts.providerTransforms, 0, "nothing is registered for an invalid address")
    }
  })

  it("rejects non-http(s), relative and ambiguously spelled addresses with a config error that does not echo the value", async () => {
    // The URL parser would quietly take the last three as absolute http(s)
    // addresses. They read like typos, so only the explicit `scheme://` spelling passes.
    for (const raw of [
      "not a url at all",
      "ftp://newapi.example.com/x",
      "/relative/proxy",
      "newapi.example.com:8443",
      "http:newapi.example.com",
      "https:/newapi.example.com",
      "https:\\newapi.example.com",
    ]) {
      const { context, drafts } = makeContext({
        options: groupOptions(raw, "packy-work"),
        connection: { credentialsByIntegration: keysFor("packy-work") },
      })
      const { requests, restore } = stubModelsFetch({ object: "list", data: [] })
      try {
        await assert.rejects(
          async () => {
            await newapiProvider.setup(context)
          },
          (error: unknown) => {
            const message = String((error as Error).message)
            assert.match(message, /newapi-provider config error/)
            assert.match(message, /providers\[0\]\.base_url/, "names the field")
            assert.match(message, /absolute http\(s\) URL/, "states the reason")
            assert.doesNotMatch(message, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the value is never echoed")
            return true
          },
        )
      } finally {
        restore()
      }
      assert.deepEqual(requests, [], `no request is sent for ${raw}`)
      assert.equal(drafts.providerTransforms, 0, "nothing is registered for an invalid address")
    }
  })
})
