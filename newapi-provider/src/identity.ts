import { createHash } from "node:crypto"
import type { ConnectionInfo } from "@opencode/client"

/**
 * Who a catalog belongs to: the host connection plus a one-way fingerprint of
 * the API key. The fingerprint is what lets a rotated key under the SAME
 * credential id invalidate the old list, and what the persistent cache records
 * instead of the key.
 */
export interface SourceIdentity {
  /** `credential:<id>` for a stored credential, `env:<name>` for an environment connection. */
  readonly connection: string
  /** SHA-256 of the API key as hex. The key itself is never kept or persisted. */
  readonly keyFingerprint: string
}

/** Stable identity of a host connection; credential and environment connections differ in shape. */
export function connectionKey(connection: ConnectionInfo): string {
  return connection.type === "credential" ? `credential:${connection.id}` : `env:${connection.name}`
}

export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex")
}

export function sourceIdentity(connection: ConnectionInfo, key: string): SourceIdentity {
  return { connection: connectionKey(connection), keyFingerprint: keyFingerprint(key) }
}

export function sameSource(a: SourceIdentity, b: SourceIdentity): boolean {
  return a.connection === b.connection && a.keyFingerprint === b.keyFingerprint
}
