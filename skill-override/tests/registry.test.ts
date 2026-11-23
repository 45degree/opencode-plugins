import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, mock, test } from "node:test"
import plugin, { type PluginContext } from "../src/entry.js"
import type { SkillEditor, SkillInfo } from "../src/overrides.js"

const TEMP_ROOT = "/tmp/opencode"

const originalHome = process.env.HOME
const originalXdg = process.env.XDG_CONFIG_HOME

const temporaryDirectories: string[] = []
const cleanups: Array<() => Promise<void>> = []
const warningRestorers: Array<() => void> = []
const pendingGateReleases: Array<() => void> = []

afterEach(async () => {
  for (const release of pendingGateReleases.splice(0)) release()
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

// Isolated HOME keeps the global skill-override.json out of these tests; only
// the project file is used.
async function testProject(): Promise<{ project: string; projectFile: string }> {
  await mkdir(TEMP_ROOT, { recursive: true })
  const root = await mkdtemp(join(TEMP_ROOT, "skill-override-registry-"))
  temporaryDirectories.push(root)
  process.env.HOME = join(root, "home")
  delete process.env.XDG_CONFIG_HOME
  await mkdir(process.env.HOME, { recursive: true })
  const project = join(root, "project")
  const projectFile = join(project, ".opencode", "skill-override.json")
  await mkdir(join(project, ".opencode"), { recursive: true })
  return { project, projectFile }
}

function makeSkill(id: string, name: string, extra: { description?: string; autoinvoke?: boolean } = {}): SkillInfo {
  return { id, name, path: `/skills/${id}/SKILL.md`, content: "body", ...extra }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitFor timed out")
    await sleep(25)
  }
}

async function settle(durationMs: number, assertStable: () => void): Promise<void> {
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    await sleep(Math.min(50, deadline - Date.now()))
  }
  assertStable()
}

interface TransformHandle {
  dispose(): Promise<void>
}

interface SequentialRegistry {
  transform(callback: (editor: SkillEditor) => void): Promise<TransformHandle>
  list(): Promise<{ data: readonly SkillInfo[] }>
  reload(): Promise<void>
  visible(): Map<string, SkillInfo>
  listCallCount(): number
  activeTransformCount(): number
}

// Mirrors the Core registry semantics that matter here: every read replays all
// active transforms, in registration order, onto a fresh empty value. Skill
// sources are modeled as transforms that add skills, exactly like Core's
// opencode.config.skill plugin.
function createSequentialRegistry(): SequentialRegistry {
  const entries: Array<{ apply: (editor: SkillEditor) => void; disposed: boolean }> = []
  const visibleState = new Map<string, SkillInfo>()
  let dirty = true
  let listCalls = 0

  const rebuild = (): void => {
    const current = new Map<string, SkillInfo>()
    const editor: SkillEditor = {
      list: () => [...current.values()],
      get: (id) => current.get(id),
      add: (skill) => { current.set(skill.id, { ...skill }) },
      update: (id, update) => { const skill = current.get(id); if (skill !== undefined) update(skill) },
      remove: (id) => { current.delete(id) },
    }
    for (const entry of entries) {
      if (!entry.disposed) entry.apply(editor)
    }
    visibleState.clear()
    for (const [id, skill] of current) visibleState.set(id, skill)
    dirty = false
  }

  return {
    transform: async (callback) => {
      const entry = { apply: callback, disposed: false }
      entries.push(entry)
      dirty = true
      return {
        dispose: async () => {
          entry.disposed = true
          dirty = true
        },
      }
    },
    list: async () => {
      listCalls += 1
      if (dirty) rebuild()
      return { data: [...visibleState.values()] }
    },
    reload: async () => {
      dirty = true
    },
    visible: () => {
      if (dirty) rebuild()
      return visibleState
    },
    listCallCount: () => listCalls,
    activeTransformCount: () => entries.filter((entry) => !entry.disposed).length,
  }
}

function sourceSkill(registry: SequentialRegistry, skill: SkillInfo): Promise<TransformHandle> {
  return registry.transform((editor) => {
    editor.add(skill)
  })
}

interface Gate {
  promise: Promise<void>
  release(): void
  enter(): void
  entered(): boolean
}

function makeGate(): Gate {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  let enteredFlag = false
  return {
    promise,
    release: () => release(),
    enter: () => {
      enteredFlag = true
    },
    entered: () => enteredFlag,
  }
}

interface PluginHost {
  context: PluginContext
  createAttempts(): number
  snapshotHandles(): readonly TransformHandle[]
  activePluginTransforms(): number
  failNextCreate(): void
  failList(error: Error): void
  healList(): void
  failDispose(error: Error): void
  healDispose(): void
  hangNextList(): { release(): void; waiting(): boolean }
  hangNextDispose(): { release(): void; waiting(): boolean }
}

function createPluginHost(registry: SequentialRegistry, project: string): PluginHost {
  const handles = new Set<TransformHandle>()
  let createAttempts = 0
  let failNext = false
  let listFailure: Error | null = null
  let disposeFailure: Error | null = null
  let listGate: Gate | undefined
  let disposeGate: Gate | undefined

  const context: PluginContext = {
    location: { directory: project },
    skill: {
      list: async () => {
        if (listFailure !== null) throw listFailure
        const gate = listGate
        listGate = undefined
        if (gate !== undefined) {
          gate.enter()
          await gate.promise
        }
        return registry.list()
      },
      transform: async (callback) => {
        createAttempts += 1
        if (failNext) {
          failNext = false
          // Core adds the transform before notifying; a rejected creation can
          // leave an active transform whose handle never reaches the plugin.
          void registry.transform(callback)
          throw new Error("transform notify failed")
        }
        const handle = await registry.transform(callback)
        const wrapper: TransformHandle = {
          dispose: async () => {
            if (disposeFailure !== null) throw disposeFailure
            const gate = disposeGate
            disposeGate = undefined
            if (gate !== undefined) {
              gate.enter()
              await gate.promise
            }
            await handle.dispose()
            handles.delete(wrapper)
          },
        }
        handles.add(wrapper)
        return wrapper
      },
      reload: () => registry.reload(),
    },
  }

  return {
    context,
    createAttempts: () => createAttempts,
    snapshotHandles: () => [...handles],
    activePluginTransforms: () => handles.size,
    failNextCreate: () => {
      failNext = true
    },
    failList: (error: Error) => {
      listFailure = error
    },
    healList: () => {
      listFailure = null
    },
    failDispose: (error: Error) => {
      disposeFailure = error
    },
    healDispose: () => {
      disposeFailure = null
    },
    hangNextList: () => {
      const gate = makeGate()
      listGate = gate
      pendingGateReleases.push(gate.release)
      return { release: gate.release, waiting: () => gate.entered() }
    },
    hangNextDispose: () => {
      const gate = makeGate()
      disposeGate = gate
      pendingGateReleases.push(gate.release)
      return { release: gate.release, waiting: () => gate.entered() }
    },
  }
}

async function startPlugin(host: PluginHost): Promise<void> {
  const cleanup = await plugin.setup(host.context)
  cleanups.push(() => Promise.resolve(cleanup?.()))
}

async function writeOverrides(filePath: string, entries: Record<string, unknown>): Promise<void> {
  await writeFile(filePath, JSON.stringify(entries))
}

test("cold start: override converges after the skill source registers late", async () => {
  const warnings = trackWarnings()
  const { project, projectFile } = await testProject()
  await writeOverrides(projectFile, { Format: { description: "overridden" } })
  const registry = createSequentialRegistry()
  const host = createPluginHost(registry, project)
  await startPlugin(host)
  await sleep(1600)
  assert.equal(registry.visible().has("fmt"), false)
  await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await waitFor(() => registry.visible().get("fmt")?.description === "overridden")
  assert.equal(host.activePluginTransforms(), 1)
  assert.deepEqual(warnings, [])
})

test("re-registers once when a re-registered source overwrites the override", async () => {
  const warnings = trackWarnings()
  const { project, projectFile } = await testProject()
  await writeOverrides(projectFile, { Format: { description: "overridden" } })
  const registry = createSequentialRegistry()
  const host = createPluginHost(registry, project)
  await startPlugin(host)
  const source = await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await waitFor(() => registry.visible().get("fmt")?.description === "overridden")
  const attemptsBefore = host.createAttempts()

  await source.dispose()
  await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await waitFor(() => registry.visible().get("fmt")?.description === "overridden")
  assert.equal(host.createAttempts() - attemptsBefore, 1)
  assert.equal(host.activePluginTransforms(), 1)
  assert.deepEqual(warnings, [])
})

test("keeps the existing registration when an unrelated source re-registers", async () => {
  const warnings = trackWarnings()
  const { project, projectFile } = await testProject()
  await writeOverrides(projectFile, { Format: { description: "overridden" } })
  const registry = createSequentialRegistry()
  const host = createPluginHost(registry, project)
  await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await startPlugin(host)
  const other = await sourceSkill(registry, makeSkill("other", "Other", { description: "other-original" }))
  await waitFor(() => registry.visible().get("fmt")?.description === "overridden")
  const handlesBefore = host.snapshotHandles()
  const attemptsBefore = host.createAttempts()

  await other.dispose()
  await sourceSkill(registry, makeSkill("other", "Other", { description: "other-original" }))
  await settle(1300, () => {
    assert.equal(host.createAttempts(), attemptsBefore)
    assert.deepEqual(host.snapshotHandles(), handlesBefore)
    assert.equal(registry.visible().get("fmt")?.description, "overridden")
  })
  assert.deepEqual(warnings, [])
})

test("plain reloads and rule edits do not re-register once converged", async () => {
  const warnings = trackWarnings()
  const { project, projectFile } = await testProject()
  await writeOverrides(projectFile, { Format: { description: "overridden" } })
  const registry = createSequentialRegistry()
  const host = createPluginHost(registry, project)
  await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await startPlugin(host)
  await waitFor(() => registry.visible().get("fmt")?.description === "overridden")
  const attemptsBefore = host.createAttempts()

  await registry.reload()
  await settle(700, () => assert.equal(host.createAttempts(), attemptsBefore))

  await writeOverrides(projectFile, { Format: { description: "edited" } })
  await waitFor(() => registry.visible().get("fmt")?.description === "edited")
  const attemptsAfterEdit = host.createAttempts()
  await settle(1300, () => assert.equal(host.createAttempts(), attemptsAfterEdit))
  assert.equal(host.activePluginTransforms(), 1)
  assert.deepEqual(warnings, [])
})

test("deleting the rule file restores upstream values and stops list polling", async () => {
  const warnings = trackWarnings()
  const { project, projectFile } = await testProject()
  await writeOverrides(projectFile, { Format: { description: "overridden" } })
  const registry = createSequentialRegistry()
  const host = createPluginHost(registry, project)
  await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await startPlugin(host)
  await waitFor(() => registry.visible().get("fmt")?.description === "overridden")

  await rm(projectFile)
  await waitFor(() => registry.visible().get("fmt")?.description === "original")
  const attempts = host.createAttempts()
  const listCalls = registry.listCallCount()
  await settle(1300, () => {
    assert.equal(host.createAttempts(), attempts)
    assert.equal(registry.listCallCount(), listCalls)
  })
  assert.deepEqual(warnings, [])
})

test("false, empty description, and unmatched names after late convergence", async () => {
  const warnings = trackWarnings()
  const { project, projectFile } = await testProject()
  await writeOverrides(projectFile, {
    Hide: { autoinvoke: false },
    Blank: { description: "" },
    Ghost: { description: "never-registered" },
  })
  const registry = createSequentialRegistry()
  const host = createPluginHost(registry, project)
  await startPlugin(host)
  await sleep(1600)
  await sourceSkill(registry, makeSkill("hide", "Hide", { description: "hide-original", autoinvoke: true }))
  await sourceSkill(registry, makeSkill("blank", "Blank", { description: "blank-original" }))
  await waitFor(() => registry.visible().get("hide")?.autoinvoke === false && registry.visible().get("blank")?.description === "")
  assert.equal(registry.visible().get("hide")?.description, "hide-original")
  assert.equal(registry.visible().has("ghost"), false)
  assert.equal(host.activePluginTransforms(), 1)
  assert.deepEqual(warnings, [])
})

test("repeated polls keep exactly one active override transform", async () => {
  trackWarnings()
  const { project, projectFile } = await testProject()
  await writeOverrides(projectFile, { Format: { description: "overridden" } })
  const registry = createSequentialRegistry()
  const host = createPluginHost(registry, project)
  await startPlugin(host)
  await sleep(1600)
  await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await waitFor(() => registry.visible().get("fmt")?.description === "overridden")
  const attempts = host.createAttempts()
  await settle(2600, () => {
    assert.equal(host.createAttempts(), attempts)
    assert.equal(host.activePluginTransforms(), 1)
  })
})

test("cleanup while a list call is in flight leaves no leaks", async () => {
  trackWarnings()
  const { project, projectFile } = await testProject()
  await writeOverrides(projectFile, { Format: { description: "overridden" } })
  const registry = createSequentialRegistry()
  const host = createPluginHost(registry, project)
  await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await startPlugin(host)
  await waitFor(() => registry.visible().get("fmt")?.description === "overridden")
  assert.equal(host.activePluginTransforms(), 1)

  const gate = host.hangNextList()
  await waitFor(() => gate.waiting())
  const cleanup = cleanups.pop()
  assert.ok(cleanup !== undefined)
  const cleanupDone = cleanup()
  gate.release()
  await cleanupDone

  assert.equal(host.activePluginTransforms(), 0)
  const listCalls = registry.listCallCount()
  await settle(1300, () => assert.equal(registry.listCallCount(), listCalls))
})

test("cleanup while a re-registration is in flight leaves no leaks", async () => {
  trackWarnings()
  const { project, projectFile } = await testProject()
  await writeOverrides(projectFile, { Format: { description: "overridden" } })
  const registry = createSequentialRegistry()
  const host = createPluginHost(registry, project)
  const source = await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await startPlugin(host)
  await waitFor(() => registry.visible().get("fmt")?.description === "overridden")
  const attemptsBefore = host.createAttempts()

  const gate = host.hangNextDispose()
  await source.dispose()
  await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await waitFor(() => gate.waiting())
  const cleanup = cleanups.pop()
  assert.ok(cleanup !== undefined)
  const cleanupDone = cleanup()
  gate.release()
  await cleanupDone

  assert.equal(host.activePluginTransforms(), 0)
  const attempts = host.createAttempts()
  assert.equal(attempts - attemptsBefore, 1)
  await settle(1300, () => assert.equal(host.createAttempts(), attempts))
})

test("dispose failures across ticks warn once, keep the handle, and converge after recovery", async () => {
  const warnings = trackWarnings()
  const { project, projectFile } = await testProject()
  await writeOverrides(projectFile, { Format: { description: "overridden" } })
  const registry = createSequentialRegistry()
  const host = createPluginHost(registry, project)
  const source = await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await startPlugin(host)
  await waitFor(() => registry.visible().get("fmt")?.description === "overridden")

  host.failDispose(new Error("dispose boom"))
  await source.dispose()
  await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await waitFor(() => warnings.some((line) => line.includes("transform dispose failed") && line.includes("dispose boom")))
  await settle(1300, () => assert.equal(warnings.filter((line) => line.includes("dispose boom")).length, 1))
  assert.equal(host.activePluginTransforms(), 1)
  assert.equal(host.createAttempts(), 1)
  assert.equal(registry.visible().get("fmt")?.description, "original")

  host.healDispose()
  await waitFor(() => registry.visible().get("fmt")?.description === "overridden")
  assert.equal(host.activePluginTransforms(), 1)
  assert.equal(host.createAttempts(), 2)
  const attemptsAfter = host.createAttempts()
  await settle(1300, () => assert.equal(host.createAttempts(), attemptsAfter))
  assert.equal(warnings.filter((line) => line.includes("dispose boom")).length, 1)
})

test("list failures across ticks warn once and reconcile after recovery", async () => {
  const warnings = trackWarnings()
  const { project, projectFile } = await testProject()
  await writeOverrides(projectFile, { Format: { description: "overridden" } })
  const registry = createSequentialRegistry()
  const host = createPluginHost(registry, project)
  const source = await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await startPlugin(host)
  await waitFor(() => registry.visible().get("fmt")?.description === "overridden")

  host.failList(new Error("list boom"))
  await source.dispose()
  await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await waitFor(() => warnings.some((line) => line.includes("skill list failed") && line.includes("list boom")))
  await settle(1300, () => assert.equal(warnings.filter((line) => line.includes("list boom")).length, 1))
  assert.equal(registry.visible().get("fmt")?.description, "original")
  assert.equal(host.createAttempts(), 1)

  host.healList()
  await waitFor(() => registry.visible().get("fmt")?.description === "overridden")
  assert.equal(host.activePluginTransforms(), 1)
  assert.equal(warnings.filter((line) => line.includes("list boom")).length, 1)
})

test("a transform that was added but rejected stops creation without accumulating", async () => {
  const warnings = trackWarnings()
  const { project, projectFile } = await testProject()
  await writeOverrides(projectFile, { Format: { description: "overridden" } })
  const registry = createSequentialRegistry()
  const host = createPluginHost(registry, project)
  await startPlugin(host)
  const source = await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await waitFor(() => registry.visible().get("fmt")?.description === "overridden")

  host.failNextCreate()
  await source.dispose()
  const movedSource = await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await waitFor(() => warnings.some((line) => line.includes("overrides paused until the plugin is reloaded")))
  const attempts = host.createAttempts()
  assert.equal(host.activePluginTransforms(), 0)

  await movedSource.dispose()
  await sourceSkill(registry, makeSkill("fmt", "Format", { description: "original" }))
  await settle(1300, () => assert.equal(host.createAttempts(), attempts))
  assert.equal(warnings.filter((line) => line.includes("overrides paused until the plugin is reloaded")).length, 1)
})
