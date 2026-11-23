// Cycle A of ticket 01: one configured provider, active key, discovery, registration.
// The plugin must register the integration + key method, discover the catalog with the
// active key through GET https://newapi.example.com/v1/models, and register the provider
// bound to the Responses-only native package with the discovered models.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { makeContext, stubModelsFetch } from "./helpers/context.js"
import newapiProvider from "../src/index.js"

const CATALOG = {
  object: "list",
  data: [
    {
      id: "gemini-3-pro",
      display_name: "Gemini 3 Pro",
      supported_endpoint_types: ["openai-response"],
    },
  ],
}

const OPTIONS = {
  providers: [{ base_url: "https://newapi.example.com", groups: [{ id: "packy-work", name: "Packy Work" }] }],
}

describe("setup: single provider registration", () => {
  it("registers the integration with a key method under the same stable id", async () => {
    const { context, drafts } = makeContext({ options: OPTIONS, connection: { credential: { type: "key", key: "sk-fake-work" } } })
    const { restore } = stubModelsFetch(CATALOG)

    try {
      await newapiProvider.setup(context)
    } finally {
      restore()
    }

    const integration = drafts.integrations.get("packy-work")
    assert.ok(integration, "integration registered")
    assert.equal(integration.name, "Packy Work")
    assert.ok(
      drafts.methods.some(
        (m) => m.integrationID === "packy-work" && m.method.type === "key" && m.method.label === "Packy Work API Key",
      ),
      "key login method registered for the integration",
    )
  })

  it("discovers models with the active key and registers the Responses provider", async () => {
    const { context, drafts } = makeContext({ options: OPTIONS, connection: { credential: { type: "key", key: "sk-fake-work" } } })
    const { requests, restore } = stubModelsFetch(CATALOG)

    try {
      await newapiProvider.setup(context)
    } finally {
      restore()
    }

    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.url, "https://newapi.example.com/v1/models")
    assert.equal(requests[0]!.authorization, "Bearer sk-fake-work")

    const entry = drafts.providers.get("packy-work")
    assert.ok(entry, "provider registered")
    assert.equal(entry.provider.name, "Packy Work")
    assert.equal(entry.provider.integrationID, "packy-work")
    assert.equal(entry.provider.package, "@opencode/ai/providers/openai-compatible/responses")
    assert.equal(entry.provider.settings?.baseURL, "https://newapi.example.com/v1")

    const model = entry.models.get("gemini-3-pro")
    assert.ok(model, "discovered model registered under its upstream id")
    assert.equal(model.enabled, true)
    assert.equal(model.providerID, "packy-work")
  })

  it("registers no catalog when the integration has no active key", async () => {
    const { context, drafts } = makeContext({
      options: { providers: [{ base_url: "https://newapi.example.com", groups: [{ id: "packy-work", name: "Packy Work" }] }] },
      connection: {},
    })
    const { requests, restore } = stubModelsFetch(CATALOG)

    try {
      await newapiProvider.setup(context)
    } finally {
      restore()
    }

    assert.equal(requests.length, 0, "no discovery request without an active key")
    const entry = drafts.providers.get("packy-work")
    assert.ok(entry, "provider still registered so /connect can attach a key")
    assert.equal(entry.models.size, 0, "no callable models without a key")
  })
})
