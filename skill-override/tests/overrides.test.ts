import assert from "node:assert/strict"
import { test } from "node:test"
import {
  applyOverrides,
  mergeTables,
  parseOverridesContent,
  serializeTable,
  type SkillEditor,
  type SkillInfo,
  type OverrideTable,
} from "../src/overrides.js"

function makeSkill(id: string, name: string, extra: { description?: string; autoinvoke?: boolean } = {}): SkillInfo {
  return { id, name, path: `/skills/${id}/SKILL.md`, content: "body", ...extra }
}

function table(entries: Record<string, { description?: string; autoinvoke?: boolean }>): OverrideTable {
  return new Map(Object.entries(entries))
}

function replay(skills: SkillInfo[], merged: OverrideTable): Map<string, SkillInfo> {
  const current = new Map(skills.map((skill) => [skill.id, { ...skill }]))
  const editor: SkillEditor = {
    list: () => [...current.values()],
    get: (id) => current.get(id),
    add: (skill) => { current.set(skill.id, { ...skill }) },
    update: (id, update) => { const skill = current.get(id); if (skill !== undefined) update(skill) },
    remove: (id) => { current.delete(id) },
  }
  applyOverrides(editor, merged)
  return current
}

test("parses valid content with description and autoinvoke", () => {
  const outcome = parseOverridesContent('{"Format":{"description":"d","autoinvoke":true},"Other":{}}')
  assert.equal(outcome.status, "ok")
  if (outcome.status !== "ok") return
  assert.deepEqual(outcome.table.get("Format"), { description: "d", autoinvoke: true })
  assert.deepEqual(outcome.table.get("Other"), {})
  assert.equal(outcome.table.size, 2)
})

test("rejects invalid JSON and non-object roots", () => {
  assert.deepEqual(parseOverridesContent("{broken"), { status: "error", reason: "invalid JSON" })
  for (const content of ["[]", "null", '"text"', "3"]) {
    const outcome = parseOverridesContent(content)
    assert.equal(outcome.status, "error", content)
    if (outcome.status === "error") assert.match(outcome.reason, /root must be an object/)
  }
})

test("rejects reserved and unknown fields, and wrong value types", () => {
  for (const content of [
    '{"A":{"name":"x"}}',
    '{"A":{"id":"x"}}',
    '{"A":{"path":"/x"}}',
    '{"A":{"content":"x"}}',
    '{"A":{"unknown":1}}',
  ]) {
    const outcome = parseOverridesContent(content)
    assert.equal(outcome.status, "error", content)
    if (outcome.status === "error") assert.match(outcome.reason, /unknown field/)
  }
  for (const content of ['{"A":{"description":1}}', '{"A":{"description":null}}']) {
    const outcome = parseOverridesContent(content)
    assert.equal(outcome.status, "error", content)
    if (outcome.status === "error") assert.match(outcome.reason, /"description" must be a string/)
  }
  for (const content of ['{"A":{"autoinvoke":"no"}}', '{"A":{"autoinvoke":0}}']) {
    const outcome = parseOverridesContent(content)
    assert.equal(outcome.status, "error", content)
    if (outcome.status === "error") assert.match(outcome.reason, /"autoinvoke" must be a boolean/)
  }
  const notObject = parseOverridesContent('{"A":"text"}')
  assert.equal(notObject.status, "error")
  if (notObject.status === "error") assert.match(notObject.reason, /override must be an object/)
})

test("merges layers per field with false and empty strings kept as present values", () => {
  const merged = mergeTables([
    table({ Format: { description: "global", autoinvoke: true }, Only: { description: "only-global" } }),
    table({ Format: { description: "" }, Extra: { autoinvoke: false } }),
  ])
  assert.deepEqual(merged.get("Format"), { description: "", autoinvoke: true })
  assert.deepEqual(merged.get("Only"), { description: "only-global" })
  assert.deepEqual(merged.get("Extra"), { autoinvoke: false })
})

test("serializeTable ignores entry order and empty overrides", () => {
  const first = mergeTables([table({ A: { description: "x", autoinvoke: false }, B: {} })])
  const second = mergeTables([table({ B: {} }), table({ A: { autoinvoke: false, description: "x" } })])
  const third = mergeTables([table({ A: { description: "x", autoinvoke: false } })])
  assert.equal(serializeTable(first), serializeTable(second))
  assert.equal(serializeTable(first), serializeTable(third))
  assert.equal(serializeTable(new Map()), "")
})

test("applyOverrides matches names exactly, covers same-name skills, and only set fields", () => {
  const skills = [
    makeSkill("fmt", "Format", { description: "original", autoinvoke: true }),
    makeSkill("fmt-copy", "Format", { description: "original", autoinvoke: true }),
    makeSkill("by-id", "Other", { description: "keep" }),
    makeSkill("Format", "Different", { description: "keep" }),
  ]
  const result = replay(skills, table({ Format: { autoinvoke: false }, Other: { description: "" } }))
  assert.deepEqual(result.get("fmt"), { ...skills[0], autoinvoke: false })
  assert.deepEqual(result.get("fmt-copy"), { ...skills[1], autoinvoke: false })
  assert.deepEqual(result.get("by-id"), { ...skills[2], description: "" })
  assert.deepEqual(result.get("Format"), skills[3])
})

test("applyOverrides leaves unmatched skills untouched", () => {
  const skills = [makeSkill("fmt", "Format", { description: "original" })]
  const result = replay(skills, table({ format: { description: "lowercase" }, Ghost: { description: "absent" } }))
  assert.deepEqual(result.get("fmt"), skills[0])
})
