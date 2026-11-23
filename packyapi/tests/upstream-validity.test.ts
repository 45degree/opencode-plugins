// Only a fully valid success may replace a catalog. Any invalid entry inside
// `data` makes the whole response invalid (the same-key catalog is kept);
// a legal `data: []` is the only success that clears models.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { fetchModels } from "../src/upstream.ts"

function okFetch(payload: unknown) {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch
}

describe("upstream: response validity", () => {
  it("rejects a response whose data contains invalid entries instead of treating it as empty", async () => {
    const result = await fetchModels("sk-fake-key", {
      fetch: okFetch({
        object: "list",
        data: [{ id: "resp-ok", supported_endpoint_types: ["openai-response"] }, "garbage", 42],
      }),
    })
    assert.equal(result.ok, false, "invalid entries make the whole response invalid")
    if (!result.ok) {
      assert.equal(result.kind, "invalid")
      assert.doesNotMatch(result.message, /sk-fake-key/, "message stays sanitized")
    }
  })

  it("still accepts a legal empty data array as a valid empty catalog", async () => {
    const result = await fetchModels("sk-fake-key", { fetch: okFetch({ object: "list", data: [] }) })
    assert.deepEqual(result, { ok: true, models: [] })
  })
})
