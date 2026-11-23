import { createRenderer } from "./render.js"
import { HOOK_NAMES, type HookEvent, type HookName } from "./types.js"
import type { Plugin as SdkPlugin } from "@opencode/plugin/promise/plugin"
import type { SessionHooks } from "@opencode/plugin/promise/session"

export { HOOK_NAMES } from "./types.js"
export type { HookEvent, HookName, SystemPart } from "./types.js"

// Compile-time guarantees, both checked by `pnpm typecheck`:
// 1. The native v2.3.2 session hook events satisfy the structural shape this
//    plugin renders.
// 2. The exported definition matches the SDK's Plugin interface. The SDK's
//    Plugin.define is an identity function, so the plain object ships without
//    a runtime dependency on the SDK package and the bundle stays
//    self-contained.
type _SdkHooksAreRenderable = SessionHooks[HookName] extends HookEvent ? true : never
const _sdkCompatible: _SdkHooksAreRenderable = true
void _sdkCompatible

// Loaded means active: the four hooks are registered during setup and there is
// no separate enable switch. The context hook also covers tool-driven
// continuations, so every request kind re-renders its own system prompt. Hook
// registrations are scoped to this plugin instance and disposed by the host on
// unload, so setup returns no cleanup of its own.
const plugin: SdkPlugin = {
  id: "model-aware-system-prompts",
  setup: async (context) => {
    const renderer = createRenderer()
    // Diagnostics name only the request kind, segment index and, when
    // Nunjucks reports one, a template-relative line number. Prompt text and
    // template bodies never reach the log.
    const render = (kind: HookName) => (event: HookEvent): void => {
      for (const diagnostic of renderer.renderEvent(kind, event)) {
        const line = diagnostic.line === undefined ? "" : ` line=${diagnostic.line}`
        console.error(`[model-aware-system-prompts] render failed kind=${diagnostic.kind} segment=${diagnostic.segment}${line}`)
      }
    }
    for (const name of HOOK_NAMES) {
      await context.session.hook(name, render(name))
    }
  },
}

export default plugin
