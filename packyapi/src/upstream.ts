export const API_ROOT = "https://www.packyapi.ai/v1"
export const MODELS_URL = `${API_ROOT}/models`
const DEFAULT_TIMEOUT_MS = 15_000
/** Discovery URL for a normalized gateway root. */
export function modelsURLFor(gatewayRoot: string): string {
  return `${gatewayRoot}/v1/models`
}

/** Responses takes precedence when the upstream advertises multiple supported protocols. */
export const RESPONSES_ENDPOINT_TYPE = "openai-response"

export type ModelProtocol = "openai-response" | "anthropic" | "gemini" | "openai"

/** Selection priority: responses first, then anthropic, native gemini over openai chat. */
export function protocolFor(endpointTypes: readonly string[] | undefined): ModelProtocol | undefined {
  const has = (type: string): boolean => endpointTypes?.includes(type) ?? false
  if (has(RESPONSES_ENDPOINT_TYPE)) return "openai-response"
  if (has("anthropic")) return "anthropic"
  if (has("gemini")) return "gemini"
  if (has("openai")) return "openai"
  return undefined
}

export const PROTOCOL_PACKAGES: Record<ModelProtocol, string> = {
  "openai-response": "@opencode/ai/providers/openai-compatible/responses",
  anthropic: "@opencode/ai/providers/anthropic",
  gemini: "@opencode/ai/providers/google",
  openai: "@opencode/ai/providers/openai-compatible",
}

export interface UpstreamModel {
  readonly id: string
  readonly displayName: string | undefined
  readonly endpointTypes: readonly string[] | undefined
}

export type UpstreamFailureKind = "auth" | "http" | "network" | "invalid"

export type UpstreamResult =
  | { readonly ok: true; readonly models: readonly UpstreamModel[] }
  | { readonly ok: false; readonly kind: UpstreamFailureKind; readonly message: string }

export interface FetchDeps {
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
  /** Merged into the request signal so plugin cleanup can abort in-flight discovery. */
  readonly signal?: AbortSignal
  /** Discovery URL; defaults to the official PackyAPI endpoint. */
  readonly modelsURL?: string
}

const DEFAULT_GATEWAY_ROOT = "https://www.packyapi.ai"
const DEFAULT_MODELS_URL = MODELS_URL

/** Failure messages name the classification and status only: never the key, headers or raw body. */
function failure(kind: UpstreamFailureKind, message: string): UpstreamResult {
  return { ok: false, kind, message }
}

/** Fetch `GET /v1/models` with Bearer auth and parse it; only a valid success replaces a catalog.
 * The timeout covers the whole body read, not just the response headers. */
export async function fetchModels(key: string, deps: FetchDeps = {}): Promise<UpstreamResult> {
  const doFetch = deps.fetch ?? globalThis.fetch
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const modelsURL = deps.modelsURL ?? DEFAULT_MODELS_URL
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeoutSignal]) : timeoutSignal
  let response: Response
  try {
    response = await doFetch(modelsURL, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal,
    })
  } catch {
    return failure("network", "model discovery request failed (network error or timeout)")
  }
  if (response.status === 401 || response.status === 403) {
    return failure("auth", `model discovery rejected the credential (HTTP ${response.status})`)
  }
  if (!response.ok) {
    return failure("http", `model discovery failed (HTTP ${response.status})`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    if (signal.aborted) {
      return failure("network", "model discovery timed out or was cancelled while reading the response")
    }
    return failure("invalid", "model discovery returned a non-JSON success response")
  }
  if (!isRecord(body) || !Array.isArray(body["data"])) {
    return failure("invalid", "model discovery response is missing a `data` array")
  }
  const models: UpstreamModel[] = []
  for (const entry of body["data"]) {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || entry["id"] === "") {
      return failure("invalid", "model discovery response contains invalid `data` entries")
    }
    const endpointTypes = entry["supported_endpoint_types"]
    models.push({
      id: entry["id"],
      displayName: typeof entry["display_name"] === "string" ? entry["display_name"] : undefined,
      endpointTypes: Array.isArray(endpointTypes)
        ? endpointTypes.filter((t): t is string => typeof t === "string")
        : undefined,
    })
  }
  return { ok: true, models }
}

/** True when the upstream explicitly lists the Responses endpoint type. */
export function supportsResponses(model: UpstreamModel): boolean {
  return model.endpointTypes?.includes(RESPONSES_ENDPOINT_TYPE) ?? false
}

/** Why a model is not enabled, for user-facing diagnostics. */
export function protocolReason(model: UpstreamModel): string {
  if (model.endpointTypes === undefined) return "no `supported_endpoint_types` reported by upstream"
  if (model.endpointTypes.length === 0) return "upstream reports no endpoint types"
  return `upstream protocols [${model.endpointTypes.join(", ")}] do not include a supported marker: openai-response, anthropic, gemini, openai`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
