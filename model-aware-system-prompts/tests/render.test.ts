import assert from "node:assert/strict"
import { mock, test } from "node:test"
import plugin, { type HookEvent, type HookName } from "../src/entry.js"

type HookCallback = (event: HookEvent) => Promise<void> | void

// Callback-only harness: no global side effects, safe to use without cleanup.
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

// Harness for tests that assert on console.error diagnostics. The mock MUST be
// restored; callers use the return value in a finally block.
async function diagnosticHarness(): Promise<{ callback(name: HookName): HookCallback; errors: string[]; restore(): void }> {
  const errors: string[] = []
  const mocked = mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args.join(" "))
  })
  const callback = await harness()
  return {
    callback,
    errors,
    restore: () => mocked.mock.restore(),
  }
}

function contextEvent(system: HookEvent["system"]): HookEvent {
  return {
    sessionID: "s1",
    agent: "build",
    model: { providerID: "acme", id: "gpt-example" },
    system,
    messages: [{ id: "m1", role: "user", text: "原始消息" }],
    options: {},
    tools: {},
  }
}

const PROMPT_MARKER = "机密正文标记"

async function rendered(text: string): Promise<HookEvent> {
  const callback = await harness()
  const event = contextEvent([{ type: "text", text }])
  await callback("context")(event)
  return event
}

test("matches selects a branch by model id pattern", async () => {
  const subject = await rendered(`<!-- {% if matches(model, "^gpt") %} -->\n${PROMPT_MARKER}\n<!-- {% else %} -->\n其他\n<!-- {% endif %} -->`)
  assert.ok(subject.system[0]!.text!.includes(PROMPT_MARKER), "matching branch body must stay")
  assert.ok(!subject.system[0]!.text!.includes("其他"), "non-matching branch body must go")
})

test("matches falls back when the pattern does not match", async () => {
  const subject = await rendered(`<!-- {% if matches(model, "^claude") %} -->\n其他\n<!-- {% else %} -->\n${PROMPT_MARKER}\n<!-- {% endif %} -->`)
  assert.ok(subject.system[0]!.text!.includes(PROMPT_MARKER))
})

test("matches accepts RegExp flags", async () => {
  const subject = await rendered(`<!-- {% if matches(model, "^GPT", "i") %} -->\n${PROMPT_MARKER}\n<!-- {% endif %} -->`)
  assert.ok(subject.system[0]!.text!.includes(PROMPT_MARKER), "case-insensitive flag must apply")
})

test("provider, model and agent are all readable inside matches", async () => {
  const subject = await rendered(`<!-- {% if matches(provider, "^acme") and matches(agent, "^bui") %} -->\n${PROMPT_MARKER}\n<!-- {% endif %} -->`)
  assert.ok(subject.system[0]!.text!.includes(PROMPT_MARKER))
})

test("a segment with an invalid pattern keeps its original text", async () => {
  const callback = await harness()
  const event = contextEvent([
    { type: "text", text: "无模板段落。" },
    { type: "text", text: `<!-- {% if matches(model, "(") %} -->\n坏段\n<!-- {% endif %} -->` },
    { type: "text", text: "<!-- {% if model == \"gpt-example\" %} -->\n好段\n<!-- {% endif %} -->" },
  ])
  await callback("context")(event)
  const broken = event.system[1]!.text!
  assert.ok(broken.includes("matches(model"), "failing segment must keep its template verbatim")
  assert.ok(broken.includes("坏段"), "failing segment must keep its body verbatim")
  assert.equal(event.system[0]!.text, "无模板段落。")
  assert.ok(event.system[2]!.text!.includes("好段"), "other segments must still render")
  assert.ok(!event.system[2]!.text!.includes("matches"), "other segments must lose their tags")
})

test("a segment with invalid regex flags keeps its original text", async () => {
  const callback = await harness()
  const event = contextEvent([{ type: "text", text: `<!-- {% if matches(model, "^gpt", "q") %} -->\n坏段\n<!-- {% endif %} -->` }])
  await callback("context")(event)
  const broken = event.system[0]!.text!
  assert.ok(broken.includes(`matches(model, "^gpt", "q")`))
  assert.ok(broken.includes("坏段"))
})

test("render failures log diagnostics without prompt or template content", async () => {
  const { callback, errors, restore } = await diagnosticHarness()
  try {
    const event = contextEvent([
      { type: "text", text: `普通文本。\n<!-- {% if bad syntax %} -->\n${PROMPT_MARKER}\n<!-- {% endif %} -->` },
    ])
    await callback("context")(event)
    assert.equal(errors.length, 1, "exactly one diagnostic for one failing segment")
    const line = errors[0]!
    assert.ok(line.includes("model-aware-system-prompts"), "diagnostic is tagged")
    assert.ok(line.includes("kind=context"), "diagnostic records the request kind")
    assert.ok(line.includes("segment=0"), "diagnostic records the segment index")
    assert.ok(/line=\d+/.test(line), "diagnostic records the available line number")
    assert.ok(!line.includes(PROMPT_MARKER), "diagnostic must not contain prompt text")
    assert.ok(!line.includes("bad syntax"), "diagnostic must not contain template body")
  } finally {
    restore()
  }
})

test("a diagnostic without an available line number still names kind and segment", async () => {
  const { callback, errors, restore } = await diagnosticHarness()
  try {
    const event = contextEvent([{ type: "text", text: `<!-- {% if matches(model, "(") %} -->\n${PROMPT_MARKER}\n<!-- {% endif %} -->` }])
    await callback("context")(event)
    assert.equal(errors.length, 1)
    const line = errors[0]!
    assert.ok(line.includes("kind=context"))
    assert.ok(line.includes("segment=0"))
    assert.ok(!line.includes(PROMPT_MARKER))
  } finally {
    restore()
  }
})

test("clean renders produce no diagnostics", async () => {
  const { callback, errors, restore } = await diagnosticHarness()
  try {
    const event = contextEvent([{ type: "text", text: `<!-- {% if model == "gpt-example" %} -->\n好段\n<!-- {% endif %} -->` }])
    await callback("context")(event)
    assert.equal(errors.length, 0)
  } finally {
    restore()
  }
})

test("segment order, metadata, non-text parts and messages stay untouched", async () => {
  const callback = await harness()
  const nonText = { type: "image", url: "https://example.invalid/a.png" } as unknown as HookEvent["system"][number]
  const metaPart = { type: "text", text: `<!-- {% if model == "gpt-example" %} -->\n${PROMPT_MARKER}\n<!-- {% endif %} -->`, metadata: { source: "core/test" } }
  const plainPart = { type: "text", text: "无模板段落。" }
  const event = contextEvent([metaPart, nonText, plainPart])
  await callback("context")(event)

  assert.equal(event.system.length, 3, "segment count must not change")
  assert.ok(event.system[0]!.text!.includes(PROMPT_MARKER), "first segment rendered in place")
  assert.equal(event.system[0]!.metadata!.source, "core/test", "metadata must survive rendering")
  assert.equal(event.system[1], nonText, "non-text part must be the same untouched object")
  assert.equal(event.system[2]!.text, "无模板段落。", "plain segment must stay last and unchanged")
  assert.deepEqual(event.messages, [{ id: "m1", role: "user", text: "原始消息" }], "messages must not be modified")
})
