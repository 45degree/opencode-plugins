import { homedir } from "node:os"
import { readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import {
  applyOverrides,
  mergeTables,
  parseOverridesContent,
  serializeTable,
  type OverrideTable,
  type SkillEditor,
  type SkillInfo,
} from "./overrides.js"
import { startPolling } from "./watcher.js"

export type { SkillInfo, SkillEditor } from "./overrides.js"

export interface Registration {
  dispose(): Promise<void>
}

export interface SkillContext {
  list(): Promise<{ readonly data: readonly SkillInfo[] }>
  transform(callback: (editor: SkillEditor) => void): Promise<Registration>
  reload(): Promise<void>
}

export interface PluginContext {
  readonly location: { readonly directory: string }
  readonly skill: SkillContext
}

const POLL_INTERVAL_MS = 500
const FILE_NAME = "skill-override.json"

// XDG_CONFIG_HOME must be absolute; empty or relative values fall back to the
// $HOME/.config default per the XDG Base Directory Specification.
export function globalConfigDirectory(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) return join(xdg, "opencode")
  return join(process.env.HOME || homedir(), ".config", "opencode")
}

interface FileState {
  readonly path: string
  raw: string | null
  readFailed: boolean
  table: OverrideTable
}

type Observation =
  | { readonly kind: "missing" }
  | { readonly kind: "content"; readonly raw: string }
  | { readonly kind: "error" }

async function observe(path: string): Promise<Observation> {
  try {
    return { kind: "content", raw: await readFile(path, "utf8") }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" }
    return { kind: "error" }
  }
}

// Whole-file atomic validation: any JSON or schema error keeps the previous
// valid table for this file. The raw content is still recorded so identical
// invalid content is reported at most once.
async function refreshFile(state: FileState): Promise<void> {
  const observation = await observe(state.path)
  if (observation.kind === "error") {
    if (!state.readFailed) console.warn("[skill-override]", state.path, "read failed")
    state.readFailed = true
    return
  }
  const raw = observation.kind === "content" ? observation.raw : null
  if (!state.readFailed && raw === state.raw) return
  state.readFailed = false
  state.raw = raw
  if (raw === null) {
    state.table = new Map()
    return
  }
  const outcome = parseOverridesContent(raw)
  if (outcome.status === "error") {
    console.warn("[skill-override]", state.path, outcome.reason)
    return
  }
  state.table = outcome.table
}

const plugin = {
  id: "skill-override",
  setup: async (context: PluginContext): Promise<() => Promise<void>> => {
    const globalState: FileState = {
      path: join(globalConfigDirectory(), FILE_NAME),
      raw: null,
      readFailed: false,
      table: new Map(),
    }
    const projectState: FileState = {
      path: join(context.location.directory, ".opencode", FILE_NAME),
      raw: null,
      readFailed: false,
      table: new Map(),
    }
    const state = { global: globalState, project: projectState }
    const merged = (): OverrideTable => mergeTables([state.global.table, state.project.table])
    // Replayed from the registry's original state on every rebuild, so each
    // replay re-reads the current tables and never permanently rewrites skills.
    const applyTable = (editor: SkillEditor): void => {
      applyOverrides(editor, merged())
    }
    await refreshFile(state.global)
    await refreshFile(state.project)

    let registration: Registration | undefined = await context.skill.transform(applyTable)

    // Advance only after reload succeeds, so a failed reload is retried on the
    // next tick instead of being silently acknowledged. Deduplicate warnings
    // per distinct consecutive error message.
    let synced = serializeTable(merged())
    let reloadError: string | null = null
    let listError: string | null = null
    let disposeError: string | null = null
    let createBroken = false

    const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

    // The registry replays transforms in registration order onto a fresh
    // value, and disk skills are added by transforms registered after plugin
    // setup, so this plugin's transform can end up before the skill sources;
    // its updates are then overwritten during replay. When the final skill
    // values deviate from the configured overrides, move the transform to the
    // tail by dispose + re-register: the next rebuild applies the overrides
    // after every source. This converges eventually; startup is not atomic.
    const reconcile = async (): Promise<void> => {
      const table = merged()
      if (serializeTable(table) === "") return
      let data: readonly SkillInfo[]
      try {
        data = (await context.skill.list()).data
      } catch (error) {
        const message = `skill list failed: ${errorMessage(error)}`
        if (listError !== message) {
          console.warn("[skill-override]", message)
          listError = message
        }
        return
      }
      listError = null
      let deviates = false
      for (const skill of data) {
        const override = table.get(skill.name)
        if (override === undefined) continue
        if (override.description !== undefined && skill.description !== override.description) {
          deviates = true
          break
        }
        if (override.autoinvoke !== undefined && skill.autoinvoke !== override.autoinvoke) {
          deviates = true
          break
        }
      }
      if (!deviates || createBroken) return
      if (registration !== undefined) {
        try {
          await registration.dispose()
        } catch (error) {
          const message = `transform dispose failed: ${errorMessage(error)}`
          if (disposeError !== message) {
            console.warn("[skill-override]", message)
            disposeError = message
          }
          return
        }
        disposeError = null
        registration = undefined
      }
      try {
        registration = await context.skill.transform(applyTable)
      } catch (error) {
        // The host may have added the transform before failing to hand back
        // its handle; retrying would accumulate transforms this plugin cannot
        // dispose, so pause re-creation until the plugin is loaded again.
        createBroken = true
        console.warn("[skill-override]", "skill transform re-registration failed; overrides paused until the plugin is reloaded", errorMessage(error))
      }
    }

    const poller = startPolling(POLL_INTERVAL_MS, async () => {
      await refreshFile(state.global)
      await refreshFile(state.project)
      const current = serializeTable(merged())
      if (current !== synced) {
        try {
          await context.skill.reload()
          synced = current
          reloadError = null
        } catch (error) {
          const message = `skill reload failed: ${errorMessage(error)}`
          if (reloadError !== message) {
            console.warn("[skill-override]", message)
            reloadError = message
          }
          return
        }
      } else {
        reloadError = null
      }
      await reconcile()
    })

    return async () => {
      await poller.stop()
      await registration?.dispose()
    }
  },
}

export default plugin
