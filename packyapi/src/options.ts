export class ConfigError extends Error {
  constructor(message: string) {
    super(`packyapi config error: ${message}`)
    this.name = "ConfigError"
  }
}

export interface ProviderConfig {
  readonly id: string
  readonly name: string
}

export interface GatewayRoots {
  /** Normalized gateway root without a version suffix, proxy prefix preserved. */
  readonly gatewayRoot: string
  /** OpenAI-style API root (discovery, Responses, Chat, Anthropic). */
  readonly apiRoot: string
  /** Gemini API root. */
  readonly geminiRoot: string
}

export interface PackyConfig {
  readonly baseURL: GatewayRoots
  readonly providers: readonly ProviderConfig[]
}

const DEFAULT_GATEWAY_ROOT = "https://www.packyapi.ai"

/**
 * Normalize a configured gateway root: trim trailing slashes, then strip one
 * explicit API version suffix (/v1beta or /v1) so the roots can be derived while
 * keeping any proxy path. Invalid or non-HTTP(S) values raise a ConfigError that
 * never echoes the input (user URLs can carry credentials in the query).
 */
export function normalizeGatewayRoot(raw: string): GatewayRoots {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError("baseURL must be a valid absolute http(s) URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("baseURL must be a valid absolute http(s) URL")
  }
  let path = url.pathname.replace(/\/+$/, "")
  if (path.endsWith("/v1beta")) path = path.slice(0, -"/v1beta".length)
  else if (path.endsWith("/v1")) path = path.slice(0, -"/v1".length)
  return { gatewayRoot: url.origin + path, apiRoot: url.origin + path + "/v1", geminiRoot: url.origin + path + "/v1beta" }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Parse and validate the plugin options; throws ConfigError on invalid configuration. */
export function parseConfig(options: Record<string, unknown>): PackyConfig {
  // Hand-written per-model parameters were removed by user decision: model metadata
  // now comes from the host's native catalog. Old options must fail loudly.
  if (options["defaults"] !== undefined) {
    throw new ConfigError("`defaults` was removed; model metadata is inherited from the host's native catalog")
  }
  if (options["overrides"] !== undefined) {
    throw new ConfigError("`overrides` was removed; model metadata is inherited from the host's native catalog")
  }
  const raw = options["providers"]
  if (raw === undefined) {
    throw new ConfigError("missing required option `providers` (array of { id, name })")
  }
  if (!Array.isArray(raw)) {
    throw new ConfigError("`providers` must be an array of { id, name }")
  }
  const seen = new Set<string>()
  const providers = raw.map((entry, index): ProviderConfig => {
    if (!isRecord(entry)) {
      throw new ConfigError(`providers[${index}] must be an object with \`id\` and \`name\``)
    }
    const { id, name } = entry
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
      throw new ConfigError(`providers[${index}].id must be a non-empty identifier (letters, digits, - and _)`)
    }
    if (seen.has(id)) {
      throw new ConfigError(`duplicate provider id \`${id}\`; provider ids must be unique`)
    }
    seen.add(id)
    if (typeof name !== "string" || name.trim() === "") {
      throw new ConfigError(`providers[${index}] (\`${id}\`).name must be a non-empty string`)
    }
    return { id, name }
  })
  const baseURLRaw = options["baseURL"]
  if (baseURLRaw !== undefined && typeof baseURLRaw !== "string") {
    throw new ConfigError("`baseURL` must be a string (an http(s) gateway root URL)")
  }
  const baseURL = normalizeGatewayRoot(typeof baseURLRaw === "string" ? baseURLRaw : DEFAULT_GATEWAY_ROOT)
  return { baseURL, providers }
}
