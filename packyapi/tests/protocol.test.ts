// Ticket 01: only models whose `supported_endpoint_types` include `openai-response`
// become callable; missing or other protocols are reported, never silently enabled.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { makeContext, stubModelsFetch } from "./helpers/context.js"
import packyapi from "../src/index.js"

const OPTIONS = {
  providers: [{ id: "packy-work", name: "Packy Work" }],
}

describe("setup: Responses protocol filtering", () => {
  it("enables only openai-response models and reports why others are skipped", async () => {
    const { context, drafts } = makeContext({ options: OPTIONS, connection: { credential: { type: "key", key: "sk-fake-work" } } })
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
    const { restore } = stubModelsFetch({
      object: "list",
      data: [
        { id: "resp-ok", supported_endpoint_types: ["openai-response"] },
        { id: "chat-only", supported_endpoint_types: ["openai-chat"] },
        { id: "no-types" },
        { id: "mixed", supported_endpoint_types: ["openai-chat", "openai-response"] },
      ],
    })

    try {
      await packyapi.setup(context)
    } finally {
      console.warn = originalWarn
      restore()
    }

    const entry = drafts.providers.get("packy-work")
    assert.ok(entry)
    assert.deepEqual(
      [...entry.models.keys()].sort(),
      ["mixed", "resp-ok"],
      "only explicitly Responses-capable models are enabled",
    )
    const diagnostics = warnings.join("\n")
    assert.match(diagnostics, /chat-only/, "skipped models are reported")
    assert.match(diagnostics, /no-types/, "missing protocol is reported")
    assert.doesNotMatch(diagnostics, /sk-fake-work/, "diagnostics never contain the key")
  })

  it("uses the upstream display name as the model name when present", async () => {
    const { context, drafts } = makeContext({ options: OPTIONS, connection: { credential: { type: "key", key: "sk-fake-work" } } })
    const { restore } = stubModelsFetch({
      object: "list",
      data: [{ id: "resp-named", display_name: "Resp Named", supported_endpoint_types: ["openai-response"] }],
    })

    try {
      await packyapi.setup(context)
    } finally {
      restore()
    }

    const model = drafts.providers.get("packy-work")!.models.get("resp-named")!
    assert.equal(model.name, "Resp Named")
  })
})
