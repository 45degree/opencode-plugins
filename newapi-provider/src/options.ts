export class ConfigError extends Error {
  constructor(message: string) {
    super(`newapi-provider config error: ${message}`)
    this.name = "ConfigError"
  }
}

/**
 * One Provider group. In OpenCode it is an independent provider bound to the New
 * API instance it was configured under.
 */
export interface ProviderConfig {
  readonly id: string
  readonly name: string
  /** Roots of the instance the group belongs to. */
  readonly baseURL: GatewayRoots
}

export interface GatewayRoots {
  /** Normalized instance root without a version suffix, proxy prefix preserved. */
  readonly gatewayRoot: string
  /** OpenAI-style API root (discovery, Responses, Chat, Anthropic). */
  readonly apiRoot: string
  /** Gemini API root. */
  readonly geminiRoot: string
}

export interface NewAPIConfig {
  /** Every configured group, in configuration order. */
  readonly providers: readonly ProviderConfig[]
  /** Start from the stored catalog and refresh in the background (the default); `false` always starts online. */
  readonly cache: boolean
}

/** Group ids: a letter or digit first, then letters, digits, `-` and `_`. */
const GROUP_ID = /^[a-z0-9][a-z0-9_-]*$/i

/** The options this version reads. */
const SUPPORTED_OPTIONS = new Set(["providers", "cache"])

/** Options of earlier versions, each with the hint that names its replacement. */
const REMOVED_OPTIONS: Readonly<Record<string, string>> = {
  baseURL: "set `base_url` on each entry of `providers` instead",
  // Hand-written model parameters were removed by user decision.
  defaults: "model metadata is inherited from the host's native catalog",
  overrides: "model metadata is inherited from the host's native catalog",
}

/**
 * Normalize a configured instance root: trim trailing slashes, then strip one
 * explicit API version suffix (/v1beta or /v1) so the roots can be derived while
 * keeping any proxy path. Invalid values, and addresses with credentials, a query
 * or a fragment, raise a ConfigError naming `field` that never echoes the input.
 */
export function normalizeGatewayRoot(raw: string, field: string): GatewayRoots {
  const trimmed = raw.trim()
  // Only the explicit `scheme://host` spelling is accepted. The URL parser would
  // also take "http:host" or "https:/host" as absolute, which reads like a typo.
  const scheme = /^(https?):\/\//i.exec(trimmed)
  let url: URL
  if (scheme === null) {
    throw new ConfigError(`\`${field}\` must be a valid absolute http(s) URL`)
  }
  try {
    url = new URL(trimmed)
  } catch {
    throw new ConfigError(`\`${field}\` must be a valid absolute http(s) URL`)
  }
  const rest = trimmed.slice(scheme[0].length)
  // The API key is the only credential, and OpenCode manages it per connection:
  // the instance address must carry none. The parser keeps no trace of an empty
  // userinfo ("https://@host"), so the marker is looked for in the input itself.
  if (url.username !== "" || url.password !== "" || (rest.split(/[/?#]/, 1)[0] ?? "").includes("@")) {
    throw new ConfigError(`\`${field}\` must not contain a username or password`)
  }
  // A query or fragment would be dropped when the roots are derived from origin
  // and path, so it is rejected instead of being silently ignored. The delimiters
  // are read from the input: the parser drops a bare "?" without a trace.
  const queryAt = rest.indexOf("?")
  const fragmentAt = rest.indexOf("#")
  if (queryAt >= 0 && (fragmentAt < 0 || queryAt < fragmentAt)) {
    throw new ConfigError(`\`${field}\` must not contain query parameters`)
  }
  if (fragmentAt >= 0) {
    throw new ConfigError(`\`${field}\` must not contain a fragment`)
  }
  let path = url.pathname.replace(/\/+$/, "")
  if (path.endsWith("/v1beta")) path = path.slice(0, -"/v1beta".length)
  else if (path.endsWith("/v1")) path = path.slice(0, -"/v1".length)
  // Stripping the suffix can expose another trailing slash ("/proxy//v1"); the
  // derived roots must not end up with "//v1".
  path = path.replace(/\/+$/, "")
  return { gatewayRoot: url.origin + path, apiRoot: url.origin + path + "/v1", geminiRoot: url.origin + path + "/v1beta" }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function quoted(keys: readonly string[]): string {
  return keys.map((key) => `\`${key}\``).join(" and ")
}

/** Reject every key outside `allowed`, naming the first offender, so a typo or an old-format leftover is never ignored. */
function rejectUnknownFields(record: Record<string, unknown>, field: string, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`${field} has an unknown field \`${key}\`; expected ${quoted(allowed)}`)
    }
  }
}

/**
 * Parse and validate the plugin options; throws ConfigError on invalid configuration.
 * Every check runs offline, so a bad option is reported before any discovery request.
 */
export function parseConfig(options: Record<string, unknown>): NewAPIConfig {
  // Nothing outside the supported options is read, and nothing is silently
  // ignored either: a leftover from an earlier version or a typo fails loudly.
  for (const key of Object.keys(options)) {
    if (SUPPORTED_OPTIONS.has(key)) continue
    const hint = Object.hasOwn(REMOVED_OPTIONS, key) ? REMOVED_OPTIONS[key] : undefined
    if (hint !== undefined) {
      throw new ConfigError(`option \`${key}\` was removed; ${hint}`)
    }
    throw new ConfigError(`unknown option \`${key}\`; supported options: ${quoted([...SUPPORTED_OPTIONS])}`)
  }
  const cacheRaw = options["cache"]
  if (cacheRaw !== undefined && typeof cacheRaw !== "boolean") {
    throw new ConfigError("`cache` must be a boolean (`true` to start from the stored catalog, `false` to always fetch online)")
  }
  const raw = options["providers"]
  if (raw === undefined) {
    throw new ConfigError("missing required option `providers` (array of { base_url, groups: [{ id, name }] })")
  }
  if (!Array.isArray(raw)) {
    throw new ConfigError("`providers` must be an array of { base_url, groups: [{ id, name }] }")
  }
  if (raw.length === 0) {
    throw new ConfigError("`providers` must list at least one New API instance")
  }
  const seen = new Set<string>()
  const providers: ProviderConfig[] = []
  raw.forEach((entry, index) => {
    const field = `providers[${index}]`
    if (!isRecord(entry)) {
      throw new ConfigError(`${field} must be an object with \`base_url\` and \`groups\``)
    }
    rejectUnknownFields(entry, field, ["base_url", "groups"])
    const rawBaseURL = entry["base_url"]
    if (typeof rawBaseURL !== "string") {
      throw new ConfigError(`${field}.base_url is required and must be a string (an absolute http(s) URL)`)
    }
    const baseURL = normalizeGatewayRoot(rawBaseURL, `${field}.base_url`)
    const rawGroups = entry["groups"]
    if (!Array.isArray(rawGroups)) {
      throw new ConfigError(`${field}.groups must be an array of { id, name }`)
    }
    if (rawGroups.length === 0) {
      throw new ConfigError(`${field}.groups must list at least one group`)
    }
    rawGroups.forEach((group, groupIndex) => {
      const groupField = `${field}.groups[${groupIndex}]`
      if (!isRecord(group)) {
        throw new ConfigError(`${groupField} must be an object with \`id\` and \`name\``)
      }
      rejectUnknownFields(group, groupField, ["id", "name"])
      const { id, name } = group
      if (typeof id !== "string" || !GROUP_ID.test(id)) {
        throw new ConfigError(`${groupField}.id must be a non-empty identifier (letters, digits, - and _)`)
      }
      // Group ids name OpenCode providers and hold their credentials, so they are
      // unique across the whole configuration, not only inside one instance.
      if (seen.has(id)) {
        throw new ConfigError(`duplicate group id \`${id}\` at ${groupField}; group ids must be unique across all providers`)
      }
      seen.add(id)
      if (typeof name !== "string" || name.trim() === "") {
        throw new ConfigError(`${groupField}.name (\`${id}\`) must be a non-empty string`)
      }
      providers.push({ id, name: name.trim(), baseURL })
    })
  })
  return { providers, cache: cacheRaw ?? true }
}
