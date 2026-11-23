import type { SourceIdentity } from "./identity.ts"
import type { UpstreamModel } from "./upstream.ts"

/** Bumped when the record layout changes; a record of another version is ignored. */
export const CACHE_VERSION = 1

/**
 * One group's catalog as stored for the next start. It names exactly what the
 * list is valid for: the instance address, the group, the connection and a
 * one-way fingerprint of the key. The key itself is never part of it.
 */
export interface CacheRecord {
  readonly version: typeof CACHE_VERSION
  readonly gatewayRoot: string
  readonly group: string
  readonly connection: string
  readonly keyFingerprint: string
  /** `ok`: the list may start the next instance. `rejected`: the instance refused this credential, so the next instance starts online. */
  readonly state: "ok" | "rejected"
  readonly models: readonly UpstreamModel[]
  readonly updatedAt: number
}

export function cacheRecord(
  gatewayRoot: string,
  group: string,
  source: SourceIdentity,
  state: CacheRecord["state"],
  models: readonly UpstreamModel[],
): CacheRecord {
  return {
    version: CACHE_VERSION,
    gatewayRoot,
    group,
    connection: source.connection,
    keyFingerprint: source.keyFingerprint,
    state,
    models: models.map((model): UpstreamModel => {
      // A field that is absent stays absent, so the stored JSON reads back the same.
      const stored: { id: string; displayName?: string; endpointTypes?: string[] } = { id: model.id }
      if (model.displayName !== undefined) stored.displayName = model.displayName
      if (model.endpointTypes !== undefined) stored.endpointTypes = [...model.endpointTypes]
      return stored as UpstreamModel
    }),
    updatedAt: Date.now(),
  }
}

/** Read a record back from storage; anything short of a complete, well-formed record yields undefined. */
export function decodeCacheRecord(value: unknown): CacheRecord | undefined {
  if (!isRecord(value)) return undefined
  const gatewayRoot = value["gatewayRoot"]
  const group = value["group"]
  const connection = value["connection"]
  const keyFingerprint = value["keyFingerprint"]
  const state = value["state"]
  if (value["version"] !== CACHE_VERSION || typeof gatewayRoot !== "string" || typeof group !== "string") return undefined
  if (typeof connection !== "string" || typeof keyFingerprint !== "string") return undefined
  if (state !== "ok" && state !== "rejected") return undefined
  const models = decodeModels(value["models"])
  if (models === undefined) return undefined
  const updatedAt = value["updatedAt"]
  return {
    version: CACHE_VERSION,
    gatewayRoot,
    group,
    connection,
    keyFingerprint,
    state,
    models,
    updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : 0,
  }
}

function decodeModels(value: unknown): UpstreamModel[] | undefined {
  if (!Array.isArray(value)) return undefined
  const models: UpstreamModel[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || entry["id"] === "") return undefined
    const displayName = entry["displayName"]
    const endpointTypes = entry["endpointTypes"]
    if (displayName !== undefined && typeof displayName !== "string") return undefined
    if (endpointTypes !== undefined && (!Array.isArray(endpointTypes) || endpointTypes.some((type) => typeof type !== "string"))) {
      return undefined
    }
    models.push({
      id: entry["id"],
      displayName,
      endpointTypes: endpointTypes as readonly string[] | undefined,
    })
  }
  return models
}

/** A record may start an instance only when it is the list of this very address, group, connection and key, and the instance did not reject it. */
export function isReusableRecord(record: CacheRecord, gatewayRoot: string, group: string, source: SourceIdentity): boolean {
  return (
    record.state === "ok" &&
    record.gatewayRoot === gatewayRoot &&
    record.group === group &&
    record.connection === source.connection &&
    record.keyFingerprint === source.keyFingerprint
  )
}

/** The slice of the host's plugin storage the cache uses. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

const keyFor = (group: string): string => `catalog:${group}`

/**
 * Catalog records in the host's plugin storage. Writes of one group are queued
 * behind each other, so whichever round finished last owns the record.
 */
export class CatalogStore {
  private readonly queue = new Map<string, Promise<void>>()

  constructor(
    private readonly storage: KeyValueStore,
    private readonly report: (message: string) => void,
  ) {}

  async read(group: string): Promise<CacheRecord | undefined> {
    let value: unknown
    try {
      value = await this.storage.get(keyFor(group))
    } catch {
      this.report(`provider \`${group}\`: cached catalog could not be read (unexpected error); fetching online`)
      return undefined
    }
    const record = decodeCacheRecord(value)
    if (record === undefined) this.report(`provider \`${group}\`: cached catalog is missing or malformed; fetching online`)
    return record
  }

  /**
   * Write the record for the next start, behind earlier writes of the same group.
   * A round superseded before its turn does not write, so a late result never
   * becomes the current record. A failed write is reported and leaves the stored
   * record as it was.
   */
  save(group: string, isCurrent: () => boolean, record: CacheRecord): Promise<void> {
    if (!isCurrent()) return Promise.resolve()
    const previous = this.queue.get(group) ?? Promise.resolve()
    const write = previous
      .catch(() => {})
      .then(async () => {
        if (!isCurrent()) return
        try {
          await this.storage.set(keyFor(group), record)
        } catch {
          this.report(`provider \`${group}\`: cached catalog could not be written (unexpected error); the previous record is kept`)
        }
      })
    this.queue.set(group, write)
    return write
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
