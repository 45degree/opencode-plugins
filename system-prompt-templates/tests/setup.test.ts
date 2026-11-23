import assert from "node:assert/strict"
import { test } from "node:test"
import plugin, { HOOK_NAMES, type HookEvent, type HookName } from "../src/entry.js"

type HookCallback = (event: HookEvent) => Promise<void> | void

interface Harness {
  registrations: string[]
  callback(name: HookName): HookCallback
}

async function harness(): Promise<Harness> {
  const registrations: string[] = []
  const callbacks = new Map<string, HookCallback>()
  const ctx = {
    session: {
      hook: async (name: string, callback: HookCallback) => {
        registrations.push(name)
        callbacks.set(name, callback)
        return { dispose: async () => {} }
      },
    },
  }
  await plugin.setup(ctx as never)
  return { registrations, callback: (name) => callbacks.get(name)! }
}

function contextEvent(system: string[]): HookEvent {
  return {
    sessionID: "s1",
    agent: "build",
    model: { providerID: "acme", id: "gpt-example" },
    system: system.map((text) => ({ type: "text", text })),
    messages: [],
    options: {},
    tools: {},
  }
}

const IF_ELSE_TEMPLATE = [
  "通用指令。",
  '<!-- {% if model == "gpt-example" %} -->',
  "先给结论。",
  "<!-- {% else %} -->",
  "备用指令。",
  "<!-- {% endif %} -->",
].join("\n")

const MATCHED = "通用指令。\n\n先给结论。\n"
const FALLBACK = "通用指令。\n\n备用指令。\n"

test("setup registers exactly the four session hooks", async () => {
  const { registrations } = await harness()
  assert.deepEqual([...registrations].sort(), [...HOOK_NAMES].sort())
  assert.equal(new Set(registrations).size, registrations.length)
})

test("context hook keeps the matching branch body", async () => {
  const { callback } = await harness()
  const event = contextEvent([IF_ELSE_TEMPLATE])
  await callback("context")(event)
  assert.equal(event.system[0]!.text, MATCHED)
})

test("context hook keeps the fallback branch when the model does not match", async () => {
  const { callback } = await harness()
  const event = contextEvent([IF_ELSE_TEMPLATE])
  event.model = { providerID: "acme", id: "other-model" }
  await callback("context")(event)
  assert.equal(event.system[0]!.text, FALLBACK)
})

test("rendered system text contains no HTML comment block tags", async () => {
  const { callback } = await harness()
  const event = contextEvent([IF_ELSE_TEMPLATE])
  await callback("context")(event)
  const rendered = event.system[0]!.text!
  assert.ok(!rendered.includes("<!-- {%"), "block start tag must be removed")
  assert.ok(!rendered.includes("%} -->"), "block end tag must be removed")
})
