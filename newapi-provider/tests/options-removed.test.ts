// The PackyAPI option contract is removed, and so are the hand-written model
// parameters (defaults/overrides) from before it. None of them is read or
// silently ignored: each one fails loudly, names the option, and does so before
// the plugin sends a request or registers anything.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { makeContext, stubModelsFetch } from "./helpers/context.js"
import newapiProvider from "../src/index.js"

const GROUP = { id: "packy-work", name: "Packy Work" }
const INSTANCE = { base_url: "https://newapi.example.com", groups: [GROUP] }
const VALID = { providers: [INSTANCE] }

async function assertRejectedBeforeNetwork(options: Record<string, unknown>, ...patterns: RegExp[]) {
  const { context, drafts } = makeContext({
    options,
    connection: { credential: { type: "key", key: "sk-fake-work" } },
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
        for (const pattern of patterns) assert.match(message, pattern, `message: ${message}`)
        assert.doesNotMatch(message, /sk-fake-work/, "the message never contains a key")
        return true
      },
    )
  } finally {
    restore()
  }
  assert.deepEqual(requests, [], "no discovery request leaves for a removed or unknown option")
  assert.equal(drafts.integrationTransforms, 0, "nothing is registered")
}

describe("options: removed options fail loudly", () => {
  it("rejects the removed `defaults` option with an explicit error", async () => {
    await assertRejectedBeforeNetwork(
      { ...VALID, defaults: { limit: { context: 1000, output: 100 } } },
      /`defaults` was removed/,
    )
  })

  it("rejects the removed `overrides` option with an explicit error", async () => {
    await assertRejectedBeforeNetwork(
      { ...VALID, overrides: { "packy-work": { "some-model": { limit: { context: 1, output: 1 } } } } },
      /`overrides` was removed/,
    )
  })

  it("rejects the removed shared `baseURL` option and points at the per-instance `base_url`", async () => {
    await assertRejectedBeforeNetwork({ baseURL: "https://old.example.com", providers: [INSTANCE] }, /`baseURL` was removed/, /`base_url`/)
  })

  it("rejects the old provider entries ({ id, name }) instead of reading them as groups", async () => {
    await assertRejectedBeforeNetwork(
      { providers: [{ id: "packy-work", name: "Packy Work" }] },
      /providers\[0\] has an unknown field `id`/,
      /expected `base_url` and `groups`/,
    )
  })

  it("rejects an unknown option instead of ignoring it", async () => {
    await assertRejectedBeforeNetwork({ ...VALID, cach: true }, /unknown option `cach`/, /supported options: `providers`/)
  })

  it("rejects an unknown option even when its name collides with an Object prototype member", async () => {
    await assertRejectedBeforeNetwork({ ...VALID, toString: "x" }, /unknown option `toString`/)
  })

  it("accepts a configuration that only uses the supported options", async () => {
    const { context, drafts } = makeContext({
      options: VALID,
      connection: { credential: { type: "key", key: "sk-fake-work" } },
    })
    const { restore } = stubModelsFetch({
      object: "list",
      data: [{ id: "resp-1", supported_endpoint_types: ["openai-response"] }],
    })
    let cleanup: (() => Promise<void> | void) | undefined
    try {
      const result = await newapiProvider.setup(context)
      cleanup = typeof result === "function" ? result : undefined
    } finally {
      restore()
    }
    assert.equal(drafts.providers.get("packy-work")!.models.has("resp-1"), true)
    if (cleanup) await cleanup()
  })
})
