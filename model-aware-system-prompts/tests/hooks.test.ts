import assert from "node:assert/strict"
import { test } from "node:test"
import plugin, { type HookEvent, type HookName } from "../src/entry.js"

type HookCallback = (event: HookEvent) => Promise<void> | void

async function harness(): Promise<(name: HookName) => HookCallback> {
  const callbacks = new Map<string, HookCallback>()
  const ctx = {
    session: {
      hook: async (name: string, callback: HookCallback) => {
        callbacks.set(name, callback)
        return { dispose: async () => {} }
      },
    },
  }
  await plugin.setup(ctx as never)
  return (name) => callbacks.get(name)!
}

function event(name: HookName, system: string[]): HookEvent {
  const base: HookEvent = {
    sessionID: "s1",
    model: { providerID: "acme", id: "gpt-example" },
    system: system.map((text) => ({ type: "text", text })),
    messages: [],
    options: {},
  }
  if (name !== "title") {
    return { ...base, agent: "build", tools: {} }
  }
  return base
}

const MODEL_BRANCH = [
  '<!-- {% if model == "gpt-example" %} -->',
  "先给结论。",
  "<!-- {% else %} -->",
  "备用指令。",
  "<!-- {% endif %} -->",
].join("\n")

const AGENT_BRANCH = ["<!-- {% if agent == null %} -->", "无 agent。", "<!-- {% else %} -->", "有 agent。", "<!-- {% endif %} -->"].join("\n")

for (const name of ["compaction", "generate", "title"] as const) {
  test(`${name} hook renders its own if/else branch`, async () => {
    const callback = await harness()
    // Each request arrives as a fresh event draft with the original template,
    // mirroring how the host re-assembles the system prompt per request.
    const matched = event(name, [MODEL_BRANCH])
    await callback(name)(matched)
    assert.equal(matched.system[0]!.text, "\n先给结论。\n")
    const fallback = event(name, [MODEL_BRANCH])
    fallback.model = { providerID: "acme", id: "other-model" }
    await callback(name)(fallback)
    assert.equal(fallback.system[0]!.text, "\n备用指令。\n")
  })
}

test("title hook sees agent as null", async () => {
  const callback = await harness()
  const subject = event("title", [AGENT_BRANCH])
  await callback("title")(subject)
  assert.equal(subject.system[0]!.text, "\n无 agent。\n")
})

test("context hook sees the request's agent", async () => {
  const callback = await harness()
  const subject = event("context", [AGENT_BRANCH])
  await callback("context")(subject)
  assert.equal(subject.system[0]!.text, "\n有 agent。\n")
})

test("consecutive requests never reuse the previous request's values", async () => {
  const callback = await harness()
  const first = event("context", [MODEL_BRANCH])
  await callback("context")(first)
  assert.equal(first.system[0]!.text, "\n先给结论。\n")

  const second = event("context", [MODEL_BRANCH])
  second.model = { providerID: "other-provider", id: "claude-x" }
  await callback("context")(second)
  assert.equal(second.system[0]!.text, "\n备用指令。\n")

  // Going back to the original model must pick its branch again, proving no
  // state from the second request carried over.
  const third = event("context", [MODEL_BRANCH])
  await callback("context")(third)
  assert.equal(third.system[0]!.text, "\n先给结论。\n")
})

test("consecutive requests follow agent changes", async () => {
  const callback = await harness()
  const AGENT_SPECIFIC = ['<!-- {% if agent == "build" %} -->', "构建。", "<!-- {% else %} -->", "非构建。", "<!-- {% endif %} -->"].join("\n")

  const first = event("context", [AGENT_SPECIFIC])
  await callback("context")(first)
  assert.equal(first.system[0]!.text, "\n构建。\n")

  const second = event("context", [AGENT_SPECIFIC])
  second.agent = "plan"
  await callback("context")(second)
  assert.equal(second.system[0]!.text, "\n非构建。\n")

  // Returning to the first agent must pick its branch again.
  const third = event("context", [AGENT_SPECIFIC])
  await callback("context")(third)
  assert.equal(third.system[0]!.text, "\n构建。\n")
})
