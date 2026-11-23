import type { ConnectionInfo } from "@opencode/client"
import { fetchModels, type ModelProtocol, type UpstreamModel, type UpstreamResult } from "./upstream.ts"
import { selectKnownProtocolModels, type DisabledModel as CatalogDisabled } from "./catalog.ts"

export interface CatalogEntry {
  /** Raw upstream catalog (protocol-filtered); Model.Info records are built per host rebuild. */
  models: Array<{ model: UpstreamModel; protocol: ModelProtocol }>
  disabled: readonly CatalogDisabled[]
  sourceConnection: ConnectionInfo | undefined
  token: number
}

/**
 * In-memory catalog state per provider. A monotonically increasing token marks the
 * newest refresh per provider; a result carrying an older token is discarded, so a
 * slow response from a replaced key can never overwrite the newer catalog.
 */
export class CatalogCache {
  private readonly entries = new Map<string, CatalogEntry>()

  ensure(providerID: string): CatalogEntry {
    let entry = this.entries.get(providerID)
    if (entry === undefined) {
      entry = { models: [], disabled: [], sourceConnection: undefined, token: 0 }
      this.entries.set(providerID, entry)
    }
    return entry
  }

  catalog(providerID: string): CatalogEntry | undefined {
    return this.entries.get(providerID)
  }

  begin(providerID: string): number {
    const entry = this.ensure(providerID)
    entry.token += 1
    return entry.token
  }

  isCurrent(providerID: string, token: number): boolean {
    return this.ensure(providerID).token === token
  }

  /** Supersede every in-flight refresh; used when the plugin stops. */
  invalidateAll(): void {
    for (const providerID of this.entries.keys()) {
      this.begin(providerID)
    }
  }

  apply(
    providerID: string,
    token: number,
    models: readonly { model: UpstreamModel; protocol: ModelProtocol }[],
    disabled: readonly CatalogDisabled[],
    sourceConnection: ConnectionInfo | undefined,
  ): "applied" | "stale" {
    const entry = this.ensure(providerID)
    if (entry.token !== token) return "stale"
    entry.models = [...models]
    entry.disabled = [...disabled]
    entry.sourceConnection = sourceConnection
    return "applied"
  }
}

export type RefreshOutcome =
  | { readonly status: "applied"; readonly count: number }
  | { readonly status: "cleared"; readonly reason: "empty-catalog" | "no-active-key" | "no-key" | "no-catalog" }
  | { readonly status: "kept"; readonly message: string }
  | { readonly status: "stale" }

export interface RefreshProviderDeps {
  readonly providerID: string
  readonly cache: CatalogCache
  readonly activeConnection: () => Promise<ConnectionInfo | undefined>
  readonly resolveKey: (connection: ConnectionInfo) => Promise<string | undefined>
  readonly reportConnectionStatus: (
    connection: ConnectionInfo,
    status: { readonly status: "needs_auth"; readonly message: string } | undefined,
  ) => Promise<void>
  readonly report: (message: string) => void
  readonly fetch?: typeof fetchModels
  /** Aborted together with the plugin cleanup signal so in-flight discovery dies with the plugin. */
  readonly signal?: AbortSignal
  /** Discovery URL derived from the configured gateway root. */
  readonly modelsURL?: string
  /** Called when a changed source identity invalidated the old catalog, so the host can rebuild immediately. */
  readonly onCacheInvalidated?: () => Promise<void> | void
}

/** Stable per-connection identity for cache invalidation; credential and env connections differ in shape. */
function connectionIdentity(connection: ConnectionInfo): string | undefined {
  if (connection.type === "credential") return connection.id
  return `env:${connection.name}`
}

/**
 * One discovery round for a provider: resolve the active key, fetch the upstream
 * catalog, and apply it unless a newer refresh superseded this one. A same-key
 * failure keeps the last good catalog; a legitimate empty catalog clears it.
 */
export async function refreshProvider(deps: RefreshProviderDeps): Promise<RefreshOutcome> {
  const token = deps.cache.begin(deps.providerID)
  let connection: ConnectionInfo | undefined
  try {
    connection = await deps.activeConnection()
  } catch {
    deps.report(`provider \`${deps.providerID}\`: connection lookup failed (unexpected error)`)
    connection = undefined
  }
  if (connection === undefined) {
    return clearAndReport(deps, token, "no-active-key", "no active connection; connect a key to list models")
  }
  let key: string | undefined
  try {
    key = await deps.resolveKey(connection)
  } catch {
    deps.report(`provider \`${deps.providerID}\`: credential resolution failed (unexpected error)`)
    key = undefined
  }
  if (key === undefined) {
    await deps
      .reportConnectionStatus(connection, { status: "needs_auth", message: "connect a PackyAPI key to list models" })
      .catch(() => {})
    return clearAndReport(deps, token, "no-key", "no usable key on the active connection")
  }
  // A different active credential invalidates the old catalog immediately, before
  // this round even fetches: the new key must never inherit the old key's visibility.
  const entry = deps.cache.catalog(deps.providerID)
  if (
    entry !== undefined &&
    entry.models.length > 0 &&
    entry.sourceConnection !== undefined &&
    connectionIdentity(entry.sourceConnection) !== connectionIdentity(connection)
  ) {
    const invalidated = deps.cache.apply(deps.providerID, token, [], [], connection)
    if (invalidated === "applied") {
      await deps.onCacheInvalidated?.()
    }
  }
  const result = await (deps.fetch ?? fetchModels)(key, { signal: deps.signal, modelsURL: deps.modelsURL })
  if (!deps.cache.isCurrent(deps.providerID, token)) {
    return { status: "stale" }
  }
  if (!result.ok) {
    await deps.reportConnectionStatus(
      connection,
      result.kind === "auth" ? { status: "needs_auth", message: result.message } : undefined,
    ).catch(() => {})
    const entry = deps.cache.catalog(deps.providerID)
    if (entry !== undefined && entry.models.length > 0) {
      deps.report(`provider \`${deps.providerID}\`: ${result.message}; keeping the last good catalog`)
      return { status: "kept", message: result.message }
    }
    deps.report(`provider \`${deps.providerID}\`: ${result.message}; no models available`)
    return { status: "cleared", reason: "no-catalog" }
  }
  const { selected, disabled } = selectKnownProtocolModels(result.models)
  const applied = deps.cache.apply(deps.providerID, token, selected, disabled, connection)
  if (applied === "stale") {
    return { status: "stale" }
  }
  await deps.reportConnectionStatus(connection, undefined).catch(() => {})
  for (const reason of disabled) {
    deps.report(`provider \`${deps.providerID}\`: model \`${reason.id}\` not enabled: ${reason.reason}`)
  }
  if (selected.length === 0) {
    return { status: "cleared", reason: "empty-catalog" }
  }
  return { status: "applied", count: selected.length }
}

function clearAndReport(
  deps: RefreshProviderDeps,
  token: number,
  reason: "no-active-key" | "no-key" | "no-catalog",
  message: string,
): RefreshOutcome {
  if (!deps.cache.isCurrent(deps.providerID, token)) {
    return { status: "stale" }
  }
  deps.cache.apply(deps.providerID, token, [], [], undefined)
  deps.report(`provider \`${deps.providerID}\`: ${message}`)
  return { status: "cleared", reason }
}
