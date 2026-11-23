export const HOOK_NAMES = ["context", "title", "compaction", "generate"] as const

export type HookName = (typeof HOOK_NAMES)[number]

// Structural mirror of the pieces of a model request this plugin reads or
// writes. The native hook events satisfy this shape; entry.ts asserts that at
// compile time so the plugin stays aligned with the SDK it declares.
export interface SystemPart {
  readonly type?: string
  text?: string
  readonly metadata?: Record<string, unknown>
}

export interface HookEvent {
  readonly sessionID?: string
  model: { readonly providerID: string; readonly id: string }
  agent?: string
  readonly system: SystemPart[]
  readonly messages?: readonly unknown[]
  readonly options?: Record<string, unknown>
  readonly tools?: Record<string, unknown>
}
