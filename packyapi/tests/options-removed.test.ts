// The hand-written model-parameter mechanism (defaults/overrides) was removed by
// user decision: configuration is providers-only, and passing the removed options
// must fail loudly instead of being silently ignored.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { makeContext, stubModelsFetch } from "./helpers/context.js"
import packyapi from "../src/index.js"

describe("options: hand-written model parameters are removed", () => {
  it("rejects the removed `defaults` option with an explicit error", async () => {
    const { context } = makeContext({
      options: {
        providers: [{ id: "packy-work", name: "Packy Work" }],
        defaults: { limit: { context: 1000, output: 100 } },
      },
    })
    await assert.rejects(
      async () => {
        await packyapi.setup(context)
      },
      (error: unknown) => /defaults.*removed|removed.*defaults/i.test(String((error as Error).message)),
    )
  })

  it("rejects the removed `overrides` option with an explicit error", async () => {
    const { context } = makeContext({
      options: {
        providers: [{ id: "packy-work", name: "Packy Work" }],
        overrides: { "packy-work": { "some-model": { limit: { context: 1, output: 1 } } } },
      },
    })
    await assert.rejects(
      async () => {
        await packyapi.setup(context)
      },
      (error: unknown) => /overrides.*removed|removed.*overrides/i.test(String((error as Error).message)),
    )
  })

  it("accepts providers-only configuration", async () => {
    const { context, drafts } = makeContext({
      options: { providers: [{ id: "packy-work", name: "Packy Work" }] },
      connection: { credential: { type: "key", key: "sk-fake-work" } },
    })
    const { restore } = stubModelsFetch({
      object: "list",
      data: [{ id: "resp-1", supported_endpoint_types: ["openai-response"] }],
    })
    try {
      await packyapi.setup(context)
    } finally {
      restore()
    }
    assert.equal(drafts.providers.get("packy-work")!.models.has("resp-1"), true)
  })
})
