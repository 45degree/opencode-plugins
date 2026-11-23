import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { afterEach, mock, test } from "node:test"
import plugin, { globalConfigDirectory, type PluginContext } from "../src/entry.js"
import type { SkillEditor, SkillInfo } from "../src/overrides.js"

const TEMP_ROOT = "/tmp/opencode"

const originalHome = process.env.HOME
const originalXdg = process.env.XDG_CONFIG_HOME

const temporaryDirectories: string[] = []
const cleanups: Array<() => Promise<void>> = []
const warningRestorers: Array<() => void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {})
  for (const restore of warningRestorers.splice(0)) restore()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdg
})

function trackWarnings(): string[] {
  const warnings: string[] = []
  const mocked = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.join(" "))
  })
  warningRestorers.push(() => mocked.mock.restore())
  return warnings
}

interface Environment {
  root: string
  home: string
  project: string
  globalFile: string
  projectFile: string
}

async function testEnvironment(): Promise<Environment> {
  await mkdir(TEMP_ROOT, { recursive: true })
  const root = await mkdtemp(join(TEMP_ROOT, "skill-override-test-"))
  temporaryDirectories.push(root)
  const home = join(root, "home")
  process.env.HOME = home
  delete process.env.XDG_CONFIG_HOME
  await mkdir(home, { recursive: true })
  const project = join(root, "project")
  await mkdir(project, { recursive: true })
  return {
    root,
    home,
    project,
    globalFile: join(home, ".config", "opencode", "skill-override.json"),
    projectFile: join(project, ".opencode", "skill-override.json"),
  }
}

// Rename-based write so a poller never observes a partially written file;
// every replacement in these tests is therefore atomic.
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, content)
  await rename(temporary, filePath)
}

function overridesJson(entries: Record<string, unknown>): string {
  return JSON.stringify(entries)
}

function makeSkill(id: string, name: string, extra: { description?: string; autoinvoke?: boolean } = {}): SkillInfo {
  return { id, name, path: `/skills/${id}/SKILL.md`, content: "body", ...extra }
}

interface Harness {
  context: PluginContext
  location: { directory: string }
  replay(): Map<string, SkillInfo>
  addOriginal(skill: SkillInfo): void
  state: { reloads: number; disposed: boolean }
}

function createHarness(originals: SkillInfo[], reload?: (replay: () => Map<string, SkillInfo>) => Promise<void>): Harness {
  const mutable = [...originals]
  const state = { reloads: 0, disposed: false }
  let callback: ((editor: SkillEditor) => void) | undefined
  const location = { directory: "" }
  const replay = (): Map<string, SkillInfo> => {
    assert.ok(callback !== undefined, "transform not registered")
    const current = new Map(mutable.map((skill) => [skill.id, { ...skill }]))
    const editor: SkillEditor = {
      list: () => [...current.values()],
      get: (id) => current.get(id),
      add: (skill) => { current.set(skill.id, { ...skill }) },
      update: (id, update) => { const skill = current.get(id); if (skill !== undefined) update(skill) },
      remove: (id) => { current.delete(id) },
    }
    callback(editor)
    return current
  }
  const context: PluginContext = {
    location,
    skill: {
      transform: async (registered) => {
        callback = registered
        return { dispose: async () => { state.disposed = true } }
      },
      reload: reload === undefined
        ? async () => { state.reloads += 1 }
        : () => reload(replay),
      list: async () => ({ data: [...replay().values()] }),
    },
  }
  return {
    context,
    location,
    state,
    addOriginal: (skill) => { mutable.push(skill) },
    replay,
  }
}

async function start(harness: Harness, project: string): Promise<void> {
  harness.location.directory = project
  const cleanup = await plugin.setup(harness.context)
  cleanups.push(() => Promise.resolve(cleanup?.()))
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function settle(durationMs: number, assertStable: () => void): Promise<void> {
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())))
  }
  assertStable()
}

test("applies global then project overrides per field", async () => {
  trackWarnings()
  const env = await testEnvironment()
  await writeFileAtomic(env.globalFile, overridesJson({
    Format: { description: "global", autoinvoke: true },
    Beta: { description: "beta-global" },
  }))
  await writeFileAtomic(env.projectFile, overridesJson({ Format: { description: "project" } }))
  const harness = createHarness([
    makeSkill("fmt", "Format", { description: "original", autoinvoke: false }),
    makeSkill("beta", "Beta", { description: "beta-original" }),
    makeSkill("gamma", "Gamma", { description: "untouched" }),
  ])
  await start(harness, env.project)
  const replayed = harness.replay()
  assert.equal(replayed.get("fmt")?.description, "project")
  assert.equal(replayed.get("fmt")?.autoinvoke, true)
  assert.equal(replayed.get("beta")?.description, "beta-global")
  assert.equal(replayed.get("gamma")?.description, "untouched")
  assert.equal(harness.state.reloads, 0)
})

test("matches by exact skill name, covers same-name skills, and never matches by id", async () => {
  const warnings = trackWarnings()
  const env = await testEnvironment()
  await writeFileAtomic(env.projectFile, overridesJson({
    Format: { description: "overridden" },
    format: { description: "lowercase-ignored" },
    Other: { description: "by-name" },
  }))
  const harness = createHarness([
    makeSkill("fmt", "Format", { description: "original" }),
    makeSkill("fmt-copy", "Format", { description: "original" }),
    makeSkill("by-id", "Other", { description: "original" }),
    makeSkill("Format", "Different", { description: "untouched" }),
  ])
  await start(harness, env.project)
  const replayed = harness.replay()
  assert.equal(replayed.get("fmt")?.description, "overridden")
  assert.equal(replayed.get("fmt-copy")?.description, "overridden")
  assert.equal(replayed.get("by-id")?.description, "by-name")
  assert.equal(replayed.get("Format")?.description, "untouched")
  assert.deepEqual(warnings, [])
})

test("applies autoinvoke false and empty descriptions without clobbering other fields", async () => {
  trackWarnings()
  const env = await testEnvironment()
  await writeFileAtomic(env.projectFile, overridesJson({
    Format: { autoinvoke: false },
    Beta: { description: "" },
    Empty: {},
  }))
  const harness = createHarness([
    makeSkill("fmt", "Format", { description: "keep", autoinvoke: true }),
    makeSkill("beta", "Beta", { description: "original", autoinvoke: false }),
    makeSkill("empty", "Empty", { description: "original", autoinvoke: false }),
  ])
  await start(harness, env.project)
  const replayed = harness.replay()
  assert.equal(replayed.get("fmt")?.description, "keep")
  assert.equal(replayed.get("fmt")?.autoinvoke, false)
  assert.equal(replayed.get("beta")?.description, "")
  assert.equal(replayed.get("beta")?.autoinvoke, false)
  assert.deepEqual(replayed.get("empty"), makeSkill("empty", "Empty", { description: "original", autoinvoke: false }))
})

test("unknown skill names stay silent and later replays cover newly registered skills", async () => {
  const warnings = trackWarnings()
  const env = await testEnvironment()
  await writeFileAtomic(env.projectFile, overridesJson({ Ghost: { description: "later" } }))
  const harness = createHarness([makeSkill("fmt", "Format", { description: "original" })])
  await start(harness, env.project)
  await settle(700, () => assert.deepEqual(warnings, []))
  assert.deepEqual(harness.replay().get("fmt"), makeSkill("fmt", "Format", { description: "original" }))

  harness.addOriginal(makeSkill("ghost", "Ghost", { description: "ghost-original" }))
  const replayed = harness.replay()
  assert.equal(replayed.get("ghost")?.description, "later")
  assert.equal(harness.state.reloads, 0)
})

test("invalid files keep the last valid overrides, warn once per distinct content, and do not reload", async () => {
  const warnings = trackWarnings()
  const env = await testEnvironment()
  const skill = makeSkill("fmt", "Format", { description: "original" })
  const harness = createHarness([skill])
  await start(harness, env.project)

  await writeFileAtomic(env.projectFile, overridesJson({ Format: { description: "v1" } }))
  await waitFor(() => harness.replay().get("fmt")?.description === "v1")
  assert.equal(harness.state.reloads, 1)

  await writeFileAtomic(env.projectFile, "{not-json")
  await waitFor(() => warnings.some((line) => line.includes("invalid JSON")))
  await settle(1200, () => assert.equal(warnings.filter((line) => line.includes("invalid JSON")).length, 1))
  assert.equal(harness.replay().get("fmt")?.description, "v1")
  assert.equal(harness.state.reloads, 1)

  await writeFileAtomic(env.projectFile, overridesJson({ Format: { name: "renamed" } }))
  await waitFor(() => warnings.some((line) => line.includes("unknown field")))
  assert.equal(harness.replay().get("fmt")?.description, "v1")
  assert.equal(harness.state.reloads, 1)

  await writeFileAtomic(env.projectFile, overridesJson({ Format: { description: "v2" } }))
  await waitFor(() => harness.replay().get("fmt")?.description === "v2")
  assert.equal(warnings.filter((line) => line.includes("invalid JSON")).length, 1)
  assert.equal(harness.state.reloads, 2)
})

test("deleting a file restores the lower layer and then the original values", async () => {
  trackWarnings()
  const env = await testEnvironment()
  await writeFileAtomic(env.globalFile, overridesJson({ Format: { description: "global", autoinvoke: false } }))
  await writeFileAtomic(env.projectFile, overridesJson({ Format: { description: "project" } }))
  const skill = makeSkill("fmt", "Format", { description: "original", autoinvoke: true })
  const harness = createHarness([skill])
  await start(harness, env.project)
  assert.equal(harness.replay().get("fmt")?.description, "project")

  await rm(env.projectFile)
  await waitFor(() => harness.replay().get("fmt")?.description === "global")
  assert.equal(harness.replay().get("fmt")?.autoinvoke, false)

  await rm(env.globalFile)
  await waitFor(() => {
    const replayed = harness.replay().get("fmt")
    return replayed?.description === "original" && replayed?.autoinvoke === true
  })
})

test("starts with a missing .opencode directory and picks the file up once created", async () => {
  const warnings = trackWarnings()
  const env = await testEnvironment()
  const harness = createHarness([makeSkill("fmt", "Format", { description: "original" })])
  await start(harness, env.project)
  assert.deepEqual(warnings, [])

  await writeFileAtomic(env.projectFile, overridesJson({ Format: { description: "later" } }))
  await waitFor(() => harness.replay().get("fmt")?.description === "later")
  assert.ok(harness.state.reloads >= 1)
  assert.deepEqual(warnings, [])
})

test("startup with an invalid file and no history yields empty overrides", async () => {
  const warnings = trackWarnings()
  const env = await testEnvironment()
  await writeFileAtomic(env.globalFile, "{broken")
  const skill = makeSkill("fmt", "Format", { description: "original" })
  const harness = createHarness([skill])
  await start(harness, env.project)
  await waitFor(() => warnings.some((line) => line.includes("invalid JSON")))
  assert.deepEqual(harness.replay().get("fmt"), skill)
  assert.equal(harness.state.reloads, 0)
})

test("read errors warn once, keep the last valid content, and recover without reloading", { skip: process.getuid?.() === 0 }, async () => {
  const warnings = trackWarnings()
  const env = await testEnvironment()
  await writeFileAtomic(env.globalFile, overridesJson({ Format: { description: "v1" } }))
  const skill = makeSkill("fmt", "Format", { description: "original" })
  const harness = createHarness([skill])
  await start(harness, env.project)
  await waitFor(() => harness.replay().get("fmt")?.description === "v1")
  assert.equal(harness.state.reloads, 0)

  await chmod(env.globalFile, 0o000)
  await waitFor(() => warnings.some((line) => line.includes("read failed")))
  await settle(1200, () => assert.equal(warnings.filter((line) => line.includes("read failed")).length, 1))
  assert.equal(harness.replay().get("fmt")?.description, "v1")
  assert.equal(harness.state.reloads, 0)

  await chmod(env.globalFile, 0o644)
  await settle(1200, () => assert.equal(harness.state.reloads, 0))
  assert.equal(harness.replay().get("fmt")?.description, "v1")
  assert.equal(warnings.filter((line) => line.includes("read failed")).length, 1)
})

test("cleanup stops polling, finishes the in-flight refresh, and disposes the registration", async () => {
  trackWarnings()
  const env = await testEnvironment()
  const pending: Array<() => void> = []
  let reloads = 0
  const harness = createHarness(
    [makeSkill("fmt", "Format", { description: "original" })],
    () => {
      reloads += 1
      return new Promise<void>((resolve) => pending.push(resolve))
    },
  )
  await start(harness, env.project)
  assert.equal(reloads, 0)

  await writeFileAtomic(env.projectFile, overridesJson({ Format: { description: "one" } }))
  await waitFor(() => reloads === 1)

  const cleanup = cleanups.pop()
  assert.ok(cleanup !== undefined)
  const cleanupDone = cleanup()
  await writeFileAtomic(env.projectFile, overridesJson({ Format: { description: "two" } }))
  for (const resolve of pending.splice(0)) resolve()
  await cleanupDone

  assert.equal(harness.state.disposed, true)
  assert.equal(harness.replay().get("fmt")?.description, "one")
  await settle(1300, () => assert.equal(reloads, 1))
})

test("ticks never overlap and unchanged content triggers no reload", async () => {
  trackWarnings()
  const env = await testEnvironment()
  const pending: Array<() => void> = []
  let reloads = 0
  const harness = createHarness(
    [makeSkill("fmt", "Format", { description: "original" })],
    () => {
      reloads += 1
      return new Promise<void>((resolve) => pending.push(resolve))
    },
  )
  await start(harness, env.project)

  await writeFileAtomic(env.globalFile, overridesJson({ Format: { description: "v1" } }))
  await waitFor(() => reloads === 1)

  await writeFileAtomic(env.globalFile, overridesJson({ Format: { description: "v2" } }))
  await settle(1300, () => assert.equal(reloads, 1))

  for (const resolve of pending.splice(0)) resolve()
  await waitFor(() => reloads === 2)
  assert.equal(harness.replay().get("fmt")?.description, "v2")
  for (const resolve of pending.splice(0)) resolve()

  await writeFileAtomic(env.globalFile, overridesJson({ Format: { description: "v2" } }))
  await settle(1300, () => assert.equal(reloads, 2))
})

test("retries reload after failure and advances the visible registry only on success", async () => {
  const warnings = trackWarnings()
  const env = await testEnvironment()
  const original = makeSkill("fmt", "Format", { description: "original" })
  const visible = new Map<string, SkillInfo>([[original.id, { ...original }]])
  let failing = true
  let attempts = 0
  let successes = 0
  const harness = createHarness([original], async (replay) => {
    attempts += 1
    if (failing) throw new Error("reload boom")
    successes += 1
    visible.clear()
    for (const [id, skill] of replay()) visible.set(id, skill)
  })
  await start(harness, env.project)

  await writeFileAtomic(env.projectFile, overridesJson({ Format: { description: "v1" } }))
  await waitFor(() => warnings.some((line) => line.includes("skill reload failed") && line.includes("reload boom")))
  assert.equal(visible.get("fmt")?.description, "original")
  await settle(1300, () => assert.equal(warnings.filter((line) => line.includes("reload boom")).length, 1))
  assert.equal(visible.get("fmt")?.description, "original")
  assert.ok(attempts >= 2)

  failing = false
  await waitFor(() => visible.get("fmt")?.description === "v1")
  assert.ok(successes >= 1)
  const attemptsAfterSuccess = attempts
  await settle(1300, () => assert.equal(attempts, attemptsAfterSuccess))
})

test("resolves the global directory through XDG_CONFIG_HOME and HOME", async () => {
  trackWarnings()
  const env = await testEnvironment()
  process.env.XDG_CONFIG_HOME = join(env.root, "xdg")
  assert.equal(globalConfigDirectory(), join(env.root, "xdg", "opencode"))
  process.env.XDG_CONFIG_HOME = "relative/path"
  assert.equal(globalConfigDirectory(), join(env.home, ".config", "opencode"))
  process.env.XDG_CONFIG_HOME = ""
  assert.equal(globalConfigDirectory(), join(env.home, ".config", "opencode"))
  delete process.env.XDG_CONFIG_HOME
  assert.equal(globalConfigDirectory(), join(env.home, ".config", "opencode"))

  process.env.XDG_CONFIG_HOME = join(env.root, "xdg")
  await writeFileAtomic(join(env.root, "xdg", "opencode", "skill-override.json"), overridesJson({ Format: { description: "xdg" } }))
  const harness = createHarness([makeSkill("fmt", "Format", { description: "original" })])
  await start(harness, env.project)
  assert.equal(harness.replay().get("fmt")?.description, "xdg")
})

test("reads the project file in ctx.location.directory only, without parent lookup", async () => {
  const warnings = trackWarnings()
  const root = await testEnvironment()
  const parent = root.project
  const child = join(parent, "child")
  await mkdir(child, { recursive: true })
  await writeFileAtomic(join(parent, ".opencode", "skill-override.json"), overridesJson({ Format: { description: "parent" } }))
  const skill = makeSkill("fmt", "Format", { description: "original" })
  const harness = createHarness([skill])
  await start(harness, child)
  await settle(700, () => assert.deepEqual(warnings, []))
  assert.deepEqual(harness.replay().get("fmt"), skill)
  assert.equal(harness.state.reloads, 0)
})
