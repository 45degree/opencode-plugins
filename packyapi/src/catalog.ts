import { fuzzy } from "fast-fuzzy"
import { Integration, Model, Provider } from "@opencode/plugin"
import type { Types } from "effect"
import { protocolFor, PROTOCOL_PACKAGES, protocolReason, type ModelProtocol, type UpstreamModel } from "./upstream.ts"

export interface DisabledModel {
  readonly id: string
  readonly reason: string
}

/**
 * Split a discovered upstream catalog by known protocol markers. Protocol selection
 * only depends on upstream data, so it happens at refresh time; the selected half
 * stays as raw upstream entries and becomes Model.Info records only when the host
 * rebuilds provider state (with the freshest native catalog).
 */
export function selectKnownProtocolModels(models: readonly UpstreamModel[]): {
  readonly selected: readonly { model: UpstreamModel; protocol: ModelProtocol }[]
  readonly disabled: readonly DisabledModel[]
} {
  const selected: Array<{ model: UpstreamModel; protocol: ModelProtocol }> = []
  const disabled: DisabledModel[] = []
  for (const model of models) {
    const protocol = protocolFor(model.endpointTypes)
    if (protocol !== undefined) {
      selected.push({ model, protocol })
    } else {
      disabled.push({ id: model.id, reason: protocolReason(model) })
    }
  }
  return { selected, disabled }
}

export interface NativeCandidate {
  readonly sourceProviderID: string
  readonly model: Model.Info
}

/** Full-string edit similarity: no substring bonus, symbols kept, case ignored. */
const FUZZY_OPTIONS = { useSellers: false, ignoreSymbols: false, ignoreCase: true } as const

/** Minimum similarity for metadata inheritance; below it the model keeps host defaults. */
const MATCH_SCORE_THRESHOLD = 0.8

export interface BuiltModels {
  readonly models: readonly Model.Info[]
  readonly warnings: readonly string[]
}

/**
 * Build host Model.Info records from the raw upstream catalog. Each upstream id is
 * fuzzy-scored against every native catalog candidate (the host's whole catalog,
 * this plugin's own providers excluded) and the highest score wins; equal scores
 * break by source providerID:modelID in dictionary order, never by iteration order.
 */
export interface GatewayRoots {
  readonly apiRoot: string
  readonly geminiRoot: string
}

export function buildModelInfos(
  providerID: string,
  entries: readonly { model: UpstreamModel; protocol: ModelProtocol }[],
  candidates: readonly NativeCandidate[],
  roots: GatewayRoots,
): BuiltModels {
  const models: Model.Info[] = []
  const warnings: string[] = []
  for (const entry of entries) {
    const upstream = entry.model
    let best: { candidate: NativeCandidate; score: number; key: string } | undefined
    for (const candidate of candidates) {
      const score = fuzzy(upstream.id, candidate.model.id, FUZZY_OPTIONS)
      const key = `${candidate.sourceProviderID}:${candidate.model.id}`
      if (best === undefined || score > best.score || (score === best.score && key < best.key)) {
        best = { candidate, score, key }
      }
    }
    if (best === undefined) {
      models.push(buildModelInfo(providerID, upstream, undefined, entry.protocol, roots))
      continue
    }
    if (best.score < MATCH_SCORE_THRESHOLD) {
      warnings.push(
        `model \`${upstream.id}\` best native match \`${best.candidate.sourceProviderID}/${best.candidate.model.id}\` score ${best.score.toFixed(3)} is below the ${MATCH_SCORE_THRESHOLD} inheritance threshold; using host defaults`,
      )
      models.push(buildModelInfo(providerID, upstream, undefined, entry.protocol, roots))
      continue
    }
    warnings.push(
      `model \`${upstream.id}\` matched native source \`${best.candidate.sourceProviderID}/${best.candidate.model.id}\` (score ${best.score.toFixed(3)}); inherited metadata is not a guarantee of actual channel capabilities`,
    )
    models.push(buildModelInfo(providerID, upstream, best.candidate.model, entry.protocol, roots))
  }
  return { models, warnings }
}

/**
 * Copy only safe metadata from a native catalog entry. Cost stays absent (unknown,
 * never inherited), identity and routing fields stay PackyAPI's own, and `enabled`
 * always comes from the protocol filter rather than the source.
 */
function buildModelInfo(
  providerID: string,
  upstream: UpstreamModel,
  meta: Model.Info | undefined,
  protocol: ModelProtocol,
  roots: GatewayRoots,
): Model.Info {
  const info = Model.Info.default(Provider.ID.make(providerID), Model.ID.make(upstream.id)) as Types.DeepMutable<Model.Info>
  // The display name is ALWAYS the upstream's own: source names (preview labels,
  // vendor branding) must never leak onto PackyAPI models.
  info.name = upstream.displayName ?? upstream.id
  // Every model carries its explicit protocol route so mixed protocols under one
  // provider each reach their own endpoint of the shared gateway.
  info.package = PROTOCOL_PACKAGES[protocol]
  info.settings = { baseURL: protocol === "gemini" ? roots.geminiRoot : roots.apiRoot }
  if (meta === undefined) return info
  if (meta.family !== undefined) info.family = meta.family
  if (meta.type !== undefined) info.type = meta.type
  info.limit = {
    context: meta.limit.context,
    output: meta.limit.output,
    ...(meta.limit.input !== undefined ? { input: meta.limit.input } : {}),
  }
  info.capabilities = {
    tools: meta.capabilities.tools,
    input: [...meta.capabilities.input],
    output: [...meta.capabilities.output],
    ...(meta.capabilities.temperature !== undefined ? { temperature: meta.capabilities.temperature } : {}),
  }
  info.time = { released: meta.time.released }
  info.status = meta.status
  return info
}

export function buildProviderInfo(provider: { id: string; name: string }, apiRoot: string): Provider.Info {
  const info = Provider.Info.empty(Provider.ID.make(provider.id)) as Types.DeepMutable<Provider.Info>
  info.name = provider.name
  info.activation = "auto"
  info.package = "@opencode/ai/providers/openai-compatible/responses"
  info.integrationID = Integration.ID.make(provider.id)
  info.settings = { baseURL: apiRoot }
  return info
}
