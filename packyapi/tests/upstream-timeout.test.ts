// The discovery timeout must cover the whole response body read, not only the
// response headers, and an external abort signal (plugin cleanup) must cancel
// an in-flight request.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { fetchModels } from "../src/upstream.ts"

// Real fetch binds the response body to the request signal: an abort errors the
// body stream. The fixture mirrors that platform contract.
const hangingBodyFetch = (): typeof globalThis.fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"))
        // Never closes on its own: the body read hangs until the signal aborts.
        signal?.addEventListener("abort", () => controller.error(new Error("The operation was aborted.")), {
          once: true,
        })
      },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof globalThis.fetch

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("upstream: body read timeout and external abort", () => {
  it("fails as network when the body never completes within the timeout", async () => {
    const result = await fetchModels("sk-fake-key", { fetch: hangingBodyFetch(), timeoutMs: 60 })
    assert.equal(result.ok, false, "a hanging body must not hang forever")
    if (!result.ok) {
      assert.equal(result.kind, "network")
      assert.match(result.message, /timed out|cancelled/i)
      assert.doesNotMatch(result.message, /sk-fake-key/)
    }
  })

  it("returns promptly when the external signal aborts before the timeout", async () => {
    const controller = new AbortController()
    const started = Date.now()
    const promise = fetchModels("sk-fake-key", {
      fetch: hangingBodyFetch(),
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    await delay(20)
    controller.abort()
    const result = await promise
    assert.ok(Date.now() - started < 5_000, "external abort returns promptly instead of waiting out the timeout")
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.kind, "network")
  })
})
