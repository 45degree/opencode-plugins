// Each discovered model carries its own protocol route: the best known protocol is
// selected from `supported_endpoint_types` (openai-response > anthropic > gemini >
// openai), and the model's package + settings.baseURL are set explicitly so mixed
// protocols under one provider all reach the right endpoint of the shared gateway.
// Models without any known marker stay disabled with a clear reason.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { makeContext, stubModelsFetch } from "./helpers/context.js"
import packyapi from "../src/index.js"

const UPSTREAM = (id: string, endpointTypes: string[]) => ({ id, supported_endpoint_types: endpointTypes })

const OPTIONS = { providers: [{ id: "packy-work", name: "Packy Work" }] }
const PROXY_OPTIONS = {
  baseURL: "https://gw.example.com/proxy/v1",
  providers: [{ id: "packy-work", name: "Packy Work" }],
}

async function setupWith(payload: unknown, options: Record<string, unknown> = OPTIONS) {
  const { context, drafts } = makeContext({
    options,
    connection: { credential: { type: "key", key: "sk-fake-work" } },
  })
  const { restore } = stubModelsFetch(payload)
  const cleanup = await packyapi.setup(context)
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
    assert.deepEqual(model.settings, { baseURL: "https://www.packyapi.ai/v1" })
  })

  it("maps anthropic-only models to the Anthropic package with the shared API root", async () => {
    const { drafts } = await setupWith({ object: "list", data: [UPSTREAM("m-claude", ["anthropic", "openai"])] })
    const model = registeredModel(drafts, "m-claude")
    assert.equal(model.package, "@opencode/ai/providers/anthropic")
    assert.deepEqual(model.settings, { baseURL: "https://www.packyapi.ai/v1" })
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
      assert.deepEqual(model.settings, { baseURL: "https://www.packyapi.ai/v1beta" })
    }
  })

  it("maps openai-chat-only models to the openai-compatible chat package with the shared API root", async () => {
    const { drafts } = await setupWith({ object: "list", data: [UPSTREAM("m-chat", ["openai"])] })
    const model = registeredModel(drafts, "m-chat")
    assert.equal(model.package, "@opencode/ai/providers/openai-compatible")
    assert.deepEqual(model.settings, { baseURL: "https://www.packyapi.ai/v1" })
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
})
