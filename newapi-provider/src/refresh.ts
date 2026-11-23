import type { ConnectionInfo } from "@opencode/client"
import { type CacheRecord, cacheRecord, type CatalogStore } from "./cache.ts"
import { selectKnownProtocolModels } from "./catalog.ts"
import { sameSource, sourceIdentity, type SourceIdentity } from "./identity.ts"
import { fetchModels, type ModelProtocol, type UpstreamModel } from "./upstream.ts"

export interface CatalogEntry {
  /** Raw upstream catalog (protocol-filtered); Model.Info records are built per host rebuild. */
  models: Array<{ model: UpstreamModel; protocol: ModelProtocol }>
  /** Connection and key fingerprint the models were served to; undefined until a key has been used. */
  source: SourceIdentity | undefined
  sourceConnection: ConnectionInfo | undefined
  token: number
}

/**
 * In-memory catalog state per provider: what this instance shows. A monotonically
 * increasing token marks the newest refresh round per provider; a result carrying
 * an older token is discarded, so a slow response from a replaced key can never
 * overwrite the newer catalog.
 */
export class CatalogCache {
  private readonly entries = new Map<string, CatalogEntry>()

  catalog(providerID: string): CatalogEntry | undefined {
    return this.entries.get(providerID)
  }

  /** Open a refresh round; its token identifies the round until the next one starts. */
  begin(providerID: string): number {
    const entry = this.ensure(providerID)
    entry.token += 1
    return entry.token
  }

  isCurrent(providerID: string, token: number): boolean {
    return this.ensure(providerID).token === token
  }

  /** Show a catalog that was read from the stored record at startup. */
  seed(providerID: string, models: readonly { model: UpstreamModel; protocol: ModelProtocol }[], source: SourceIdentity, sourceConnection: ConnectionInfo): void {
    const entry = this.ensure(providerID)
    entry.models = [...models]
    entry.source = source
    entry.sourceConnection = sourceConnection
  }

  /** Make a fetched catalog visible. False when a newer round superseded this one. */
  apply(
    providerID: string,
    token: number,
    models: readonly { model: UpstreamModel; protocol: ModelProtocol }[],
    source: SourceIdentity,
    sourceConnection: ConnectionInfo,
  ): boolean {
    const entry = this.ensure(providerID)
    if (entry.token !== token) return false
    entry.models = [...models]
    entry.source = source
    entry.sourceConnection = sourceConnection
    return true
  }

  /** Show no models for the provider, on behalf of `source` when a credential was in play. */
  clear(providerID: string, token: number, source?: SourceIdentity, sourceConnection?: ConnectionInfo): boolean {
    const entry = this.ensure(providerID)
    if (entry.token !== token) return false
    entry.models = []
    entry.source = source
    entry.sourceConnection = sourceConnection
    return true
  }

  private ensure(providerID: string): CatalogEntry {
    let entry = this.entries.get(providerID)
    if (entry === undefined) {
      entry = { models: [], source: undefined, sourceConnection: undefined, token: 0 }
      this.entries.set(providerID, entry)
    }
    return entry
  }
}

/**
 * What a round does with a fetched list.
 * - `initial`: the group has no usable record; the list is shown as soon as it arrives.
 * - `manual`: the user asked, or the credential changed; the list is shown at once.
 * - `background`: the group started from its record; the list is only written for the next start.
 */
export type RefreshTrigger = "initial" | "manual" | "background"

export type RefreshOutcome =
  | { readonly status: "applied"; readonly count: number }
  | { readonly status: "stored"; readonly count: number }
  | { readonly status: "cleared"; readonly reason: "empty-catalog" | "no-active-key" | "no-key" | "no-catalog" }
  | { readonly status: "kept"; readonly message: string }
  | { readonly status: "hidden"; readonly message: string }
  | { readonly status: "stale" }

/** True when the round changed what the host should show, so the models need a rebuild. */
export function outcomeChangedVisibility(outcome: RefreshOutcome): boolean {
  return outcome.status === "applied" || outcome.status === "cleared" || outcome.status === "hidden"
}

/** The group's active connection with its API key, or with no usable key. */
export type CredentialLookup =
  | { readonly connection: ConnectionInfo; readonly key: string }
  | { readonly connection: ConnectionInfo; readonly key: undefined }

export interface RefreshProviderDeps {
  readonly providerID: string
  readonly cache: CatalogCache
  readonly trigger: RefreshTrigger
  /** Normalized instance root; part of what a stored record has to match. */
  readonly gatewayRoot: string
  /** Stored catalogs for the next start; undefined when the cache is disabled. */
  readonly store: CatalogStore | undefined
  /** False once the plugin began unloading. */
  readonly isActive: () => boolean
  readonly activeConnection: () => Promise<ConnectionInfo | undefined>
  readonly resolveKey: (connection: ConnectionInfo) => Promise<string | undefined>
  readonly reportConnectionStatus: (
    connection: ConnectionInfo,
    status: { readonly status: "needs_auth"; readonly message: string } | undefined,
  ) => Promise<void>
  readonly report: (message: string) => void
  readonly fetch?: typeof fetchModels
  /** Discovery URL of the group's instance, derived from its configured `base_url`. */
  readonly modelsURL: string
  /**
   * Asks the host to rebuild the visible models after the round changed them.
   * Never awaited: a round must not wait on a host lock, least of all while the plugin unloads.
   */
  readonly publish: () => void
}

/** Look up what the host holds for a group. Host failures are reported and count as "nothing usable". */
export async function lookupCredential(
  deps: Pick<RefreshProviderDeps, "providerID" | "activeConnection" | "resolveKey" | "report">,
): Promise<CredentialLookup | undefined> {
  const label = `provider \`${deps.providerID}\``
  let connection: ConnectionInfo | undefined
  try {
    connection = await deps.activeConnection()
  } catch {
    deps.report(`${label}: connection lookup failed (unexpected error)`)
    connection = undefined
  }
  if (connection === undefined) return undefined
  let key: string | undefined
  try {
    key = await deps.resolveKey(connection)
  } catch {
    deps.report(`${label}: credential resolution failed (unexpected error)`)
    key = undefined
  }
  return { connection, key }
}

/**
 * One discovery round for a provider: look up the active connection and key, fetch
 * the upstream catalog, and apply the result unless a newer round superseded this one.
 *
 * The list belongs to the connection AND the key it was served to. When either
 * changed, the old list is deactivated before this round even fetches and the new
 * key never inherits the old visibility. For an unchanged credential, a network
 * failure keeps the last good catalog, a rejection (HTTP 401/403) hides it, and a
 * legitimate empty catalog clears it.
 */
export async function refreshProvider(deps: RefreshProviderDeps): Promise<RefreshOutcome> {
  const { providerID, cache } = deps
  const token = cache.begin(providerID)
  const label = `provider \`${providerID}\``
  const current = (): boolean => cache.isCurrent(providerID, token)
  // A status update is a host call that may wait on a lock the unload holds, so a
  // round finishing during unload leaves the connection status alone.
  const reportStatus = (connection: ConnectionInfo, status: { readonly status: "needs_auth"; readonly message: string } | undefined): void => {
    if (!deps.isActive()) return
    void deps.reportConnectionStatus(connection, status).catch(() => {})
  }

  const lookup = await lookupCredential(deps)
  if (lookup === undefined) {
    return finishWithoutCatalog(deps, token, "no-active-key", "no active connection; connect a key to list models")
  }
  const { connection } = lookup
  if (lookup.key === undefined) {
    reportStatus(connection, { status: "needs_auth", message: "connect a New API key to list models" })
    return finishWithoutCatalog(deps, token, "no-key", "no usable key on the active connection")
  }

  const source = sourceIdentity(connection, lookup.key)
  const previous = cache.catalog(providerID)?.source
  const changed = previous !== undefined && !sameSource(previous, source)
  if (changed && current()) {
    // The connection or the key behind this group changed: the old list describes
    // what ANOTHER credential may call, so it goes away now, not when the fetch ends.
    cache.clear(providerID, token, source, connection)
    deps.publish()
    deps.report(`${label}: connection or key changed; the previous catalog is no longer shown`)
  }

  const result = await (deps.fetch ?? fetchModels)(lookup.key, { modelsURL: deps.modelsURL })
  if (!current()) {
    return { status: "stale" }
  }
  if (!result.ok) {
    reportStatus(connection, result.kind === "auth" ? { status: "needs_auth", message: result.message } : undefined)
    if (!current()) {
      return { status: "stale" }
    }
    if (result.kind === "auth") {
      // The instance no longer accepts this credential. Keeping the list would keep
      // offering models the key cannot call, so it is hidden until a fetch succeeds.
      // The stored record loses its eligibility for the next start the same way.
      cache.clear(providerID, token, source, connection)
      deps.publish()
      deps.report(`${label}: ${result.message}; models hidden until the instance accepts the key`)
      await deps.store?.save(providerID, current, cacheRecord(deps.gatewayRoot, providerID, source, "rejected", []))
      return { status: "hidden", message: result.message }
    }
    const visible = cache.catalog(providerID)
    if (visible !== undefined && visible.models.length > 0) {
      deps.report(`${label}: ${result.message}; keeping the last good catalog`)
      return { status: "kept", message: result.message }
    }
    deps.report(`${label}: ${result.message}; no models available`)
    return { status: "cleared", reason: "no-catalog" }
  }

  const { selected, disabled } = selectKnownProtocolModels(result.models)
  // A refresh that runs in the background of a start only writes its result for
  // the next start: what this instance shows stays the list it started with.
  const showNow = deps.trigger !== "background" || changed
  if (showNow) {
    if (!cache.apply(providerID, token, selected, source, connection)) {
      return { status: "stale" }
    }
    deps.publish()
  }
  reportStatus(connection, undefined)
  for (const reason of disabled) {
    deps.report(`${label}: model \`${reason.id}\` not enabled: ${reason.reason}`)
  }
  await deps.store?.save(providerID, current, cacheRecord(deps.gatewayRoot, providerID, source, "ok", result.models))
  if (!showNow) {
    return { status: "stored", count: selected.length }
  }
  if (selected.length === 0) {
    return { status: "cleared", reason: "empty-catalog" }
  }
  return { status: "applied", count: selected.length }
}

/** No usable credential: nothing can be fetched, so the provider lists nothing. */
function finishWithoutCatalog(
  deps: RefreshProviderDeps,
  token: number,
  reason: "no-active-key" | "no-key",
  message: string,
): RefreshOutcome {
  if (!deps.cache.clear(deps.providerID, token)) {
    return { status: "stale" }
  }
  deps.publish()
  deps.report(`provider \`${deps.providerID}\`: ${message}`)
  return { status: "cleared", reason }
}
