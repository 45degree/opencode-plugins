// Each discovered model carries its own protocol route: the best known protocol is
// selected from `supported_endpoint_types` (openai-response > anthropic > gemini >
// openai), and the model's package + settings.baseURL are set explicitly so mixed
// protocols under one provider all reach the right endpoint of the shared gateway.
// Models without any known marker stay disabled with a clear reason.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { makeContext, stubModelsFetch } from "./helpers/context.js"
import newapiProvider from "../src/index.js"

const UPSTREAM = (id: string, endpointTypes: string[]) => ({ id, supported_endpoint_types: endpointTypes })

const OPTIONS = { providers: [{ base_url: "https://newapi.example.com", groups: [{ id: "packy-work", name: "Packy Work" }] }] }
/** The instance sits behind a reverse proxy: every derived root has to keep the proxy path. */
const PROXY_OPTIONS = {
  providers: [{ base_url: "https://gw.example.com/proxy/v1", groups: [{ id: "packy-work", name: "Packy Work" }] }],
}

async function setupWith(payload: unknown, options: Record<string, unknown> = OPTIONS) {
  const { context, drafts } = makeContext({
    options,
    connection: { credential: { type: "key", key: "sk-fake-work" } },
  })
  const { restore } = stubModelsFetch(payload)
  const cleanup = await newapiProvider.setup(context)
  restore()
  return { drafts, cleanup: typeof cleanup === "function" ? cleanup : undefined }
}

function registeredModel(drafts: import("./helpers/context.js").RecordedDrafts, id: string) {
  const model = drafts.providers.get("packy-work")!.models.get(id)! as unknown as Record<string, unknown>
  assert.ok(model, `${id} must be registered`)
  return model
}

describe("protocol mapping: per-model package and baseURL", () => {
  it("maps openai-response models to the Responses package with the shared API root", async () => {
    const { drafts } = await setupWith({ object: "list", data: [UPSTREAM("m-resp", ["openai-response", "anthropic"])] })
    const model = registeredModel(drafts, "m-resp")
    assert.equal(model.package, "@opencode/ai/providers/openai-compatible/responses", "responses wins the priority")
    assert.deepEqual(model.settings, { baseURL: "https://newapi.example.com/v1" })
  })

  it("maps anthropic-only models to the Anthropic package with the shared API root", async () => {
    const { drafts } = await setupWith({ object: "list", data: [UPSTREAM("m-claude", ["anthropic", "openai"])] })
    const model = registeredModel(drafts, "m-claude")
    assert.equal(model.package, "@opencode/ai/providers/anthropic")
    assert.deepEqual(model.settings, { baseURL: "https://newapi.example.com/v1" })
  })

  it("maps gemini models to the Google package with the Gemini root, gemini beating openai", async () => {
    const { drafts } = await setupWith({
      object: "list",
      data: [UPSTREAM("m-gemini", ["gemini"]), UPSTREAM("m-both", ["gemini", "openai"])],
    })
    const gemini = registeredModel(drafts, "m-gemini")
    const both = registeredModel(drafts, "m-both")
    for (const model of [gemini, both]) {
      assert.equal(model.package, "@opencode/ai/providers/google", "native gemini beats openai chat")
      assert.deepEqual(model.settings, { baseURL: "https://newapi.example.com/v1beta" })
    }
  })

  it("maps openai-chat-only models to the openai-compatible chat package with the shared API root", async () => {
    const { drafts } = await setupWith({ object: "list", data: [UPSTREAM("m-chat", ["openai"])] })
    const model = registeredModel(drafts, "m-chat")
    assert.equal(model.package, "@opencode/ai/providers/openai-compatible")
    assert.deepEqual(model.settings, { baseURL: "https://newapi.example.com/v1" })
  })

  it("disables models with no known protocol marker and says why", async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
    const { drafts } = await setupWith({
      object: "list",
      data: [UPSTREAM("m-unknown", ["mistral"]), { id: "m-none" }],
    })
    console.warn = originalWarn
    assert.equal(drafts.providers.get("packy-work")!.models.has("m-unknown"), false)
    assert.equal(drafts.providers.get("packy-work")!.models.has("m-none"), false)
    const diagnostics = warnings.join("\n")
    assert.match(diagnostics, /m-unknown/, "the unknown-protocol model is reported")
    assert.match(diagnostics, /m-none/, "the protocol-less model is reported")
  })

  it("derives per-model roots from a proxied gateway base, preserving the proxy path", async () => {
    const { drafts } = await setupWith(
      {
        object: "list",
        data: [UPSTREAM("m-resp", ["openai-response"]), UPSTREAM("m-gem", ["gemini"]), UPSTREAM("m-chat", ["openai"])],
      },
      PROXY_OPTIONS,
    )
    const resp = registeredModel(drafts, "m-resp")
    const gem = registeredModel(drafts, "m-gem")
    const chat = registeredModel(drafts, "m-chat")
    assert.deepEqual(resp.settings, { baseURL: "https://gw.example.com/proxy/v1" })
    assert.deepEqual(gem.settings, { baseURL: "https://gw.example.com/proxy/v1beta" })
    assert.deepEqual(chat.settings, { baseURL: "https://gw.example.com/proxy/v1" })
  })

  // Issue 07: the protocol is the model's own declaration, read in the order
  // OpenAI Responses > Anthropic > Gemini > OpenAI Chat. Nothing is guessed from
  // the model id; a model without a usable declaration is skipped and the log says why.
  it("picks the best protocol a model declares, in the order responses, anthropic, gemini, chat", async () => {
    const { drafts, cleanup } = await setupWith({
      object: "list",
      data: [
        UPSTREAM("m-all-four", ["openai", "gemini", "anthropic", "openai-response"]),
        UPSTREAM("m-three", ["openai", "gemini", "anthropic"]),
        UPSTREAM("m-two", ["openai", "gemini"]),
        UPSTREAM("m-one", ["openai"]),
      ],
    })
    if (cleanup) await cleanup()
    assert.equal(registeredModel(drafts, "m-all-four").package, "@opencode/ai/providers/openai-compatible/responses", "Responses beats the other three")
    assert.equal(registeredModel(drafts, "m-three").package, "@opencode/ai/providers/anthropic", "Anthropic beats Gemini and Chat")
    assert.equal(registeredModel(drafts, "m-two").package, "@opencode/ai/providers/google", "Gemini beats Chat")
    assert.equal(registeredModel(drafts, "m-one").package, "@opencode/ai/providers/openai-compatible", "Chat when it is the only one")
  })

  it("a known protocol wins over unknown ones declared next to it", async () => {
    const { drafts, cleanup } = await setupWith({
      object: "list",
      data: [UPSTREAM("m-mixed", ["mistral", "gemini", "somesdk"])],
    })
    if (cleanup) await cleanup()
    assert.equal(registeredModel(drafts, "m-mixed").package, "@opencode/ai/providers/google")
  })

  it("skips a model whose declaration is missing, empty or unknown-only, and logs why", async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
    let drafts: import("./helpers/context.js").RecordedDrafts
    let cleanup: (() => Promise<void> | void) | undefined
    try {
      ;({ drafts, cleanup } = await setupWith({
        object: "list",
        data: [{ id: "m-missing" }, UPSTREAM("m-empty", []), UPSTREAM("m-unknown", ["mistral", "somesdk"]), UPSTREAM("m-ok", ["anthropic"])],
      }))
    } finally {
      console.warn = originalWarn
    }
    if (cleanup) await cleanup()

    assert.deepEqual([...drafts.providers.get("packy-work")!.models.keys()].sort(), ["m-ok"], "only the model with a known protocol is listed")
    const diagnostics = warnings.join("\n")
    assert.match(diagnostics, /`m-missing` not enabled: no `supported_endpoint_types` reported by upstream/)
    assert.match(diagnostics, /`m-empty` not enabled: upstream reports no endpoint types/)
    assert.match(
      diagnostics,
      /`m-unknown` not enabled: upstream protocols \[mistral, somesdk\] do not include a supported marker: openai-response, anthropic, gemini, openai/,
      "the log names the declared protocols and the supported ones, so a protocol problem reads differently from a connection problem",
    )
    assert.doesNotMatch(diagnostics, /`m-ok`/, "a routable model raises no protocol diagnostic")
  })
})
