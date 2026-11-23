// Issue 07: Provider groups connect to their own New API instance. Discovery,
// credentials, catalogs and inference roots stay with the instance and the group
// that configured them; one group's state never leaks into another.
//
// Instances and keys are fake; nothing here reaches a real New API deployment.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { ai } from "@opencode/ai"
import * as responses from "@opencode/ai/providers/openai-compatible/responses"
import { makeContext, stubRoutedFetch, type RecordedDrafts, type RecordedRequest } from "./helpers/context.js"
import newapiProvider from "../src/index.js"

const RESPONSES_MODEL = (id: string) => ({ id, supported_endpoint_types: ["openai-response"] })

/** Instance A sits behind a /gw proxy prefix, written with a version suffix and a trailing slash; B is bare. */
const TWO_INSTANCES = {
  providers: [
    {
      base_url: "https://a.example.com/gw/v1/",
      groups: [
        { id: "a-work", name: "A Work" },
        { id: "a-personal", name: "A Personal" },
      ],
    },
    { base_url: "https://b.example.com", groups: [{ id: "b-team", name: "B Team" }] },
  ],
}

const KEYS = {
  "a-work": "sk-fake-a-work",
  "a-personal": "sk-fake-a-personal",
  "b-team": "sk-fake-b-team",
} as const

type GroupID = keyof typeof KEYS

const CREDENTIALS = Object.fromEntries(Object.entries(KEYS).map(([id, key]) => [id, { type: "key", key }])) as Record<
  GroupID,
  { type: string; key: string }
>

/** Every discovery sorted by key: which instance is called with which group's key. */
const DISCOVERIES: ReadonlyArray<readonly [url: string, authorization: string]> = [
  ["https://a.example.com/gw/v1/models", "Bearer sk-fake-a-personal"],
  ["https://a.example.com/gw/v1/models", "Bearer sk-fake-a-work"],
  ["https://b.example.com/v1/models", "Bearer sk-fake-b-team"],
]

const modelIDs = (drafts: RecordedDrafts, groupID: string) => [...drafts.providers.get(groupID)!.models.keys()].sort()

/** Answer a discovery with one model per catalog generation plus one model that only the calling group ever sees. */
function serveInstances(request: RecordedRequest, generation = 1) {
  const group = Object.entries(KEYS).find(([, key]) => request.authorization === `Bearer ${key}`)?.[0] ?? "unexpected"
  const instance = new URL(request.url).host
  return {
    payload: { object: "list", data: [RESPONSES_MODEL(`gen-${generation}`), RESPONSES_MODEL(`${instance}--${group}`)] },
  }
}

const byKey = (x: { authorization?: string }, y: { authorization?: string }) =>
  String(x.authorization).localeCompare(String(y.authorization))

function normalizeCleanup(result: Awaited<ReturnType<typeof newapiProvider.setup>>): (() => Promise<void> | void) | undefined {
  return typeof result === "function" ? result : undefined
}

async function setupWith(options: Record<string, unknown>, credentials: Partial<Record<GroupID, { type: string; key: string }>>) {
  const { context, drafts, connection } = makeContext({ options, connection: { credentialsByIntegration: { ...credentials } } })
  const cleanup = await newapiProvider.setup(context)
  return { drafts, connection, cleanup: normalizeCleanup(cleanup) }
}

describe("multi-instance: discovery", () => {
  it("asks each group's own normalized instance for GET /v1/models with that group's key", async () => {
    const stub = stubRoutedFetch((request) => serveInstances(request))
    const { drafts, cleanup } = await setupWith(TWO_INSTANCES, CREDENTIALS)
    if (cleanup) await cleanup()
    stub.restore()

    assert.deepEqual(
      [...stub.requests]
        .sort(byKey)
        .map((request) => ({ url: request.url, method: request.method, authorization: request.authorization })),
      [
        { url: "https://a.example.com/gw/v1/models", method: "GET", authorization: "Bearer sk-fake-a-personal" },
        { url: "https://a.example.com/gw/v1/models", method: "GET", authorization: "Bearer sk-fake-a-work" },
        { url: "https://b.example.com/v1/models", method: "GET", authorization: "Bearer sk-fake-b-team" },
      ],
      "one discovery per group, addressed to its own instance with its own key",
    )

    assert.deepEqual(modelIDs(drafts, "a-work"), ["a.example.com--a-work", "gen-1"])
    assert.deepEqual(modelIDs(drafts, "a-personal"), ["a.example.com--a-personal", "gen-1"])
    assert.deepEqual(modelIDs(drafts, "b-team"), ["b.example.com--b-team", "gen-1"], "each group sees only what its key was served")
  })

  it("connects a group that has no key yet: it is registered, lists nothing and requests nothing", async () => {
    const stub = stubRoutedFetch((request) => serveInstances(request))
    const { drafts, cleanup } = await setupWith(TWO_INSTANCES, { "a-work": CREDENTIALS["a-work"], "b-team": CREDENTIALS["b-team"] })
    if (cleanup) await cleanup()
    stub.restore()

    const integration = drafts.integrations.get("a-personal")
    assert.ok(integration, "the keyless group gets its integration, so /connect can attach a key")
    assert.equal(integration.name, "A Personal")
    assert.ok(
      drafts.methods.some(
        (m) => m.integrationID === "a-personal" && m.method.type === "key" && m.method.label === "A Personal API Key",
      ),
      "the key method is offered for the keyless group",
    )
    assert.ok(drafts.providers.get("a-personal"), "the keyless group is registered as a provider")
    assert.deepEqual(modelIDs(drafts, "a-personal"), [], "no callable models without a key")

    assert.deepEqual(
      [...stub.requests].sort(byKey).map((request) => [request.url, request.authorization]),
      [
        ["https://a.example.com/gw/v1/models", "Bearer sk-fake-a-work"],
        ["https://b.example.com/v1/models", "Bearer sk-fake-b-team"],
      ],
      "only the groups that have a key are discovered",
    )
    assert.deepEqual(modelIDs(drafts, "a-work"), ["a.example.com--a-work", "gen-1"], "the keyed group on the same instance is unaffected")
  })

  it("keeps the other groups when one instance fails, naming the failing group without its key", async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
    const stub = stubRoutedFetch((request) =>
      request.authorization === `Bearer ${KEYS["b-team"]}`
        ? { payload: { error: "upstream exploded for sk-fake-b-team" }, status: 500 }
        : serveInstances(request),
    )
    let drafts: RecordedDrafts
    try {
      drafts = (await setupWith(TWO_INSTANCES, CREDENTIALS)).drafts
    } finally {
      console.warn = originalWarn
      stub.restore()
    }

    assert.equal(stub.requests.length, 3, "every group was asked once, the failing one included")
    assert.ok(drafts.providers.get("b-team"), "the failing group stays registered (no callable models)")
    assert.deepEqual(modelIDs(drafts, "b-team"), [])
    assert.deepEqual(modelIDs(drafts, "a-work"), ["a.example.com--a-work", "gen-1"])
    assert.deepEqual(modelIDs(drafts, "a-personal"), ["a.example.com--a-personal", "gen-1"])

    const diagnostics = warnings.join("\n")
    assert.match(diagnostics, /`b-team`/, "the failing group is named")
    assert.match(diagnostics, /HTTP 500/, "the failure classification is reported")
    assert.doesNotMatch(diagnostics, /sk-fake-/, "diagnostics contain no key")
    assert.doesNotMatch(diagnostics, /upstream exploded/, "the raw upstream body is not passed through")
  })

  it("shows a manually refreshed catalog at once, and picks up a key connected after startup", async () => {
    let generation = 1
    const stub = stubRoutedFetch((request) => serveInstances(request, generation))
    const { drafts, connection, cleanup } = await setupWith(TWO_INSTANCES, {
      "a-work": CREDENTIALS["a-work"],
      "b-team": CREDENTIALS["b-team"],
    })
    try {
      assert.deepEqual(modelIDs(drafts, "a-personal"), [], "starts without models: no key yet")

      // The user connects a new key for the personal group, and both instances
      // publish a new catalog generation in the meantime.
      connection.credentialsByIntegration = { ...CREDENTIALS }
      generation = 2
      const before = stub.requests.length
      await drafts.commands.get("newapi-provider-refresh")!.execute({
        sessionID: "ses_test" as never,
        prompt: {} as never,
        delivery: {} as never,
      })

      assert.deepEqual(
        [...stub.requests].slice(before).sort(byKey).map((request) => [request.url, request.authorization]),
        DISCOVERIES,
        "the manual refresh asks every group's own instance with its own key, the newly connected one included",
      )
      assert.ok(stub.requests.every((request) => request.method === "GET"), "a refresh discovers only: no inference request")

      assert.deepEqual(modelIDs(drafts, "a-work"), ["a.example.com--a-work", "gen-2"], "the new list replaced the old one")
      assert.deepEqual(modelIDs(drafts, "a-personal"), ["a.example.com--a-personal", "gen-2"], "the newly connected group lists its models")
      assert.deepEqual(modelIDs(drafts, "b-team"), ["b.example.com--b-team", "gen-2"])
    } finally {
      if (cleanup) await cleanup()
      stub.restore()
    }
  })
})

describe("multi-instance: inference", () => {
  it("routes inference through the instance's proxy prefix, on the route the plugin registered", async () => {
    const requests: Array<{ method: string; path: string; authorization: string | undefined }> = []
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers["authorization"] })
      req.resume()
      if (req.method === "GET" && req.url === "/gw/v1/models") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [RESPONSES_MODEL("m-resp")] }))
        return
      }
      if (req.method === "POST" && req.url === "/gw/v1/responses") {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.end(
          [
            { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", id: "msg_1" } },
            { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello through the proxy" },
            {
              type: "response.completed",
              response: {
                id: "resp_mock",
                output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello through the proxy" }] }],
                usage: { input_tokens: 5, output_tokens: 2 },
              },
            },
          ]
            .map((event) => `event: ${event["type"]}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as { port: number }

    try {
      // The instance is configured behind the /gw proxy prefix; discovery and
      // inference both have to keep it.
      const { drafts, cleanup } = await setupWith(
        { providers: [{ base_url: `http://127.0.0.1:${port}/gw/v1`, groups: [{ id: "a-work", name: "A Work" }] }] },
        { "a-work": CREDENTIALS["a-work"] },
      )
      try {
        const provider = drafts.providers.get("a-work")!
        assert.equal(provider.provider.settings?.baseURL, `http://127.0.0.1:${port}/gw/v1`)

        // The host builds a model from the registered package + settings and the connected key.
        const registered = provider.models.get("m-resp")! as unknown as { settings?: Record<string, unknown> }
        const model = responses.model("m-resp", {
          apiKey: KEYS["a-work"],
          baseURL: registered.settings?.baseURL as string,
        })
        const result = await ai.generate({ model, prompt: "Say hi" })
        const text = (result.message?.content ?? [])
          .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
          .join("")
        assert.match(text, /Hello through the proxy/)
      } finally {
        if (cleanup) await cleanup()
      }

      assert.deepEqual(
        requests,
        [
          { method: "GET", path: "/gw/v1/models", authorization: "Bearer sk-fake-a-work" },
          { method: "POST", path: "/gw/v1/responses", authorization: "Bearer sk-fake-a-work" },
        ],
        "discovery and inference both keep the proxy prefix of the instance address",
      )
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
