export interface SkillInfo {
  id: string
  name: string
  description?: string
  autoinvoke?: boolean
  path: string
  content: string
}

export interface SkillEditor {
  list(): readonly SkillInfo[]
  get(id: string): SkillInfo | undefined
  add(skill: SkillInfo): void
  update(id: string, update: (skill: SkillInfo) => void): void
  remove(id: string): void
}

export interface SkillOverride {
  readonly description?: string
  readonly autoinvoke?: boolean
}

export type OverrideTable = ReadonlyMap<string, SkillOverride>

export type ParseOutcome =
  | { readonly status: "ok"; readonly table: OverrideTable }
  | { readonly status: "error"; readonly reason: string }

export function parseOverridesContent(content: string): ParseOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { status: "error", reason: "invalid JSON" }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "error", reason: "invalid schema: root must be an object keyed by skill name" }
  }
  const table = new Map<string, SkillOverride>()
  for (const [name, raw] of Object.entries(parsed)) {
    const invalid = (reason: string): ParseOutcome => ({
      status: "error",
      reason: `invalid schema: skill ${JSON.stringify(name)}: ${reason}`,
    })
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return invalid("override must be an object")
    }
    const override: { description?: string; autoinvoke?: boolean } = {}
    for (const [field, value] of Object.entries(raw)) {
      if (field === "description") {
        if (typeof value !== "string") return invalid('field "description" must be a string')
        override.description = value
      } else if (field === "autoinvoke") {
        if (typeof value !== "boolean") return invalid('field "autoinvoke" must be a boolean')
        override.autoinvoke = value
      } else {
        return invalid(`unknown field "${field}"; allowed fields are "description" and "autoinvoke"`)
      }
    }
    table.set(name, override)
  }
  return { status: "ok", table }
}

export function mergeTables(layers: readonly OverrideTable[]): Map<string, SkillOverride> {
  const merged = new Map<string, SkillOverride>()
  for (const layer of layers) {
    for (const [name, override] of layer) {
      const previous = merged.get(name)
      merged.set(name, previous === undefined ? override : {
        description: override.description ?? previous.description,
        autoinvoke: override.autoinvoke ?? previous.autoinvoke,
      })
    }
  }
  return merged
}

// Canonical form used for change detection: order-independent, and an entry
// with no fields set is equivalent to the same entry being absent.
export function serializeTable(table: OverrideTable): string {
  const entries: string[] = []
  for (const [name, override] of table) {
    if (override.description === undefined && override.autoinvoke === undefined) continue
    entries.push(`${JSON.stringify(name)}:${JSON.stringify([override.description ?? null, override.autoinvoke ?? null])}`)
  }
  entries.sort()
  return entries.join("|")
}

export function applyOverrides(editor: SkillEditor, merged: OverrideTable): void {
  for (const skill of editor.list()) {
    const override = merged.get(skill.name)
    if (override === undefined) continue
    editor.update(skill.id, (skill) => {
      if (override.description !== undefined) skill.description = override.description
      if (override.autoinvoke !== undefined) skill.autoinvoke = override.autoinvoke
    })
  }
}
