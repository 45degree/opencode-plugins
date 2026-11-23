import { Plugin, type Model } from "@opencode/plugin"
import type { ConnectionInfo } from "@opencode/client"
import { parseConfig } from "./options.ts"
import { buildModelInfos, buildProviderInfo, type NativeCandidate } from "./catalog.ts"
import { CatalogCache, refreshProvider, type RefreshOutcome } from "./refresh.ts"
import { modelsURLFor } from "./upstream.ts"

const PLUGIN_ID = "packyapi"
export const REFRESH_COMMAND = "packyapi-refresh"

export const packyapi = Plugin.define({
  id: PLUGIN_ID,
  setup: async (context) => {
    const config = parseConfig(context.options as Record<string, unknown>)
    const cache = new CatalogCache()

    await context.integration.transform((draft) => {
      for (const provider of config.providers) {
        draft.update(provider.id, (integration) => {
          integration.name = provider.name
        })
        draft.method.update({
          integrationID: provider.id,
          method: { type: "key", label: `${provider.name} API Key` },
        })
      }
    })

    const report = (message: string): void => {
      console.warn(`[packyapi] ${message}`)
    }

    // One signal for the plugin instance: cleanup aborts in-flight discovery and
    // ends the event subscription together.
    const controller = new AbortController()

    const modelsURL = modelsURLFor(config.baseURL.gatewayRoot)

    const refreshOne = async (providerID: string): Promise<RefreshOutcome> => {
      return refreshProvider({
        providerID,
        modelsURL,
        cache,
        activeConnection: () => context.integration.connection.active(providerID),
        resolveKey: async (connection) => {
          const credential = await context.integration.connection.resolve(connection)
          const key = credential?.type === "key" ? credential.key : undefined
          return typeof key === "string" && key !== "" ? key : undefined
        },
        reportConnectionStatus: (connection: ConnectionInfo, status) =>
          context.integration.connection.status({ integrationID: providerID, connection, status }),
        report,
        onCacheInvalidated: () => context.provider.reload(),
        signal: controller.signal,
      })
    }

    // Initial discovery. Providers refresh independently: one failing provider
    // neither blocks nor pollutes the others.
    await Promise.all(
      config.providers.map(async (provider) => {
        try {
          await refreshOne(provider.id)
        } catch (error) {
          report(`provider \`${provider.id}\`: model discovery failed (${unexpectedError()})`)
        }
      }),
    )

    // One persistent transform per domain: every host state rebuild replays the
    // callback against the current cache, and unloading the plugin removes it.
    await context.provider.transform((draft) => {
      // Collect the WHOLE native catalog first (all providers, including inactive),
      // excluding this plugin's own providers so self-derived metadata can never
      // pollute the matching pool; only then write our own records.
      const ownProviderIDs = new Set(config.providers.map((provider) => provider.id))
      const candidates: NativeCandidate[] = []
      for (const record of draft.list()) {
        if (ownProviderIDs.has(record.provider.id)) continue
        for (const model of record.models.values()) {
          candidates.push({ sourceProviderID: record.provider.id, model })
        }
      }
      for (const provider of config.providers) {
        const entry = cache.catalog(provider.id)
        const built = buildModelInfos(provider.id, entry?.models ?? [], candidates, {
          apiRoot: config.baseURL.apiRoot,
          geminiRoot: config.baseURL.geminiRoot,
        })
        for (const warning of built.warnings) {
          report(`provider \`${provider.id}\`: ${warning}`)
        }
        draft.add({
          info: buildProviderInfo(provider, config.baseURL.apiRoot),
          models: [...built.models],
          ...(entry?.sourceConnection !== undefined ? { sourceConnection: entry.sourceConnection } : {}),
        })
      }
    })

    await context.command.transform((draft) => {
      draft.add({
        name: REFRESH_COMMAND,
        description: "Refresh the PackyAPI model catalogs (no model call involved)",
        execute: async () => {
          const outcomes = await Promise.all(
            config.providers.map(async (provider) => ({
              providerID: provider.id,
              outcome: await refreshOne(provider.id).catch((error) => {
                report(`provider \`${provider.id}\`: model discovery failed (${unexpectedError()})`)
                return { status: "kept", message: unexpectedError() } as RefreshOutcome
              }),
            })),
          )
          const hasLiveResult = outcomes.some(({ outcome }) => outcome.status !== "stale")
          if (hasLiveResult) {
            await context.provider.reload()
          }
          const problems = outcomes.filter(({ outcome }) => outcome.status === "kept" || (outcome.status === "cleared" && outcome.reason !== "empty-catalog"))
          if (problems.length > 0) {
            const summary = outcomes
              .map(({ providerID, outcome }) => `\`${providerID}\`: ${describeOutcome(outcome)}`)
              .join("; ")
            throw new Error(`packyapi refresh reported problems: ${summary}`)
          }
        },
      })
    })

    const eventLoop = (async () => {
      try {
        for await (const event of context.event.subscribe({
          types: ["credential.switched", "credential.updated"],
          signal: controller.signal,
        })) {
          if (event.type !== "credential.switched" && event.type !== "credential.updated") continue
          const integrationID = (event.data as { integrationID?: string } | undefined)?.integrationID
          const provider = config.providers.find((candidate) => candidate.id === integrationID)
          if (provider === undefined) continue
          void refreshOne(provider.id)
            .then((outcome) => {
              // A refresh superseded before it finished must not trigger a rebuild.
              return outcome.status === "stale" ? undefined : context.provider.reload()
            })
            .catch((error) => {
              report(`provider \`${provider.id}\`: refresh after credential change failed (${unexpectedError()})`)
            })
        }
      } catch {
        // Subscription ended (cleanup or transport close); no further refreshes.
      }
    })()
    void eventLoop

    return () => {
      controller.abort()
      // Supersede every in-flight refresh so late results are dropped and
      // never reach the host state.
      cache.invalidateAll()
    }
  },
})

/**
 * Unknown internal errors (host or library failures) can embed sensitive details in
 * their messages, so they are reported with a fixed classification and never passed
 * through to logs, diagnostics or command errors.
 */
function unexpectedError(): string {
  return "unexpected error"
}

function describeOutcome(outcome: RefreshOutcome): string {
  if (outcome.status === "applied") return `catalog updated (${outcome.count} models)`
  if (outcome.status === "kept") return outcome.message
  if (outcome.status === "cleared") return `no catalog (${outcome.reason})`
  return "superseded by a newer refresh"
}

export default packyapi
