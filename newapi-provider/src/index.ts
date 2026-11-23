import { Plugin, type Model } from "@opencode/plugin"
import type { ConnectionInfo } from "@opencode/client"
import { parseConfig, type ProviderConfig } from "./options.ts"
import { buildModelInfos, buildProviderInfo, selectKnownProtocolModels, type NativeCandidate } from "./catalog.ts"
import { CatalogStore, isReusableRecord } from "./cache.ts"
import { sourceIdentity } from "./identity.ts"
import {
  CatalogCache,
  lookupCredential,
  outcomeChangedVisibility,
  refreshProvider,
  type RefreshOutcome,
  type RefreshTrigger,
} from "./refresh.ts"
import { TaskPool } from "./tasks.ts"
import { modelsURLFor } from "./upstream.ts"

const PLUGIN_ID = "newapi-provider"
export const REFRESH_COMMAND = "newapi-provider-refresh"

export const newapiProvider = Plugin.define({
  id: PLUGIN_ID,
  setup: async (context) => {
    const config = parseConfig(context.options)
    // What this instance shows.
    const cache = new CatalogCache()
    // Admission for refresh rounds: open until cleanup, which then waits for the
    // rounds that already started.
    const pool = new TaskPool()

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
      console.warn(`[${PLUGIN_ID}] ${message}`)
    }
    // Stored catalogs live in the host's plugin storage; with `cache: false` they
    // are neither read nor written.
    const store = config.cache ? new CatalogStore(context.storage, report) : undefined

    // Ends the credential event subscription when the plugin stops.
    const controller = new AbortController()

    // Asks the host to rebuild the visible models. Never awaited by a refresh
    // round, and never asked for while the plugin unloads: the rebuild needs a
    // host lock, and the unload holds it while it waits for the rounds.
    const publish = (): void => {
      if (!pool.isOpen) return
      void context.provider.reload().catch(() => {
        report("provider reload after a catalog change failed (unexpected error)")
      })
    }
    // Rounds that run before the provider transform exists have nothing to
    // publish: registering the transform shows their result.
    const noPublish = (): void => {}

    const activeConnection = (providerID: string) => context.integration.connection.active(providerID)
    const resolveKey = async (connection: ConnectionInfo) => {
      const credential = await context.integration.connection.resolve(connection)
      const key = credential?.type === "key" ? credential.key : undefined
      return typeof key === "string" && key !== "" ? key : undefined
    }

    const refreshOne = async (provider: ProviderConfig, trigger: RefreshTrigger, notify: () => void): Promise<RefreshOutcome> => {
      const providerID = provider.id
      return refreshProvider({
        providerID,
        trigger,
        // Each group talks to its own instance; the normalized root keeps any proxy prefix.
        modelsURL: modelsURLFor(provider.baseURL.gatewayRoot),
        gatewayRoot: provider.baseURL.gatewayRoot,
        cache,
        store,
        isActive: () => pool.isOpen,
        activeConnection: () => activeConnection(providerID),
        resolveKey,
        reportConnectionStatus: (connection: ConnectionInfo, status) =>
          context.integration.connection.status({ integrationID: providerID, connection, status }),
        report,
        publish: notify,
      })
    }

    /**
     * Start a group from its stored catalog when the record is the list of this
     * very address, connection and key. True when that happened; the group then
     * refreshes in the background once everything is registered.
     */
    const startFromRecord = async (provider: ProviderConfig): Promise<boolean> => {
      if (store === undefined) return false
      const lookup = await lookupCredential({
        providerID: provider.id,
        activeConnection: () => activeConnection(provider.id),
        resolveKey,
        report,
      })
      if (lookup?.key === undefined) return false
      const source = sourceIdentity(lookup.connection, lookup.key)
      const record = await store.read(provider.id)
      if (record === undefined) return false
      if (!isReusableRecord(record, provider.baseURL.gatewayRoot, provider.id, source)) {
        const why = record.state === "rejected" ? "was rejected by the instance" : "does not belong to this address, connection or key"
        report(`provider \`${provider.id}\`: cached catalog ${why}; fetching online`)
        return false
      }
      const { selected, disabled } = selectKnownProtocolModels(record.models)
      cache.seed(provider.id, selected, source, lookup.connection)
      for (const reason of disabled) {
        report(`provider \`${provider.id}\`: model \`${reason.id}\` not enabled: ${reason.reason}`)
      }
      report(`provider \`${provider.id}\`: using the cached catalog (${selected.length} models); refreshing in the background`)
      return true
    }

    // Startup. Every other group than one that started from its record waits here
    // for its online list. Groups are independent: one failing group neither
    // blocks nor pollutes the others.
    const background: ProviderConfig[] = []
    await Promise.all(
      config.providers.map(async (provider) => {
        try {
          if (await startFromRecord(provider)) background.push(provider)
          else await refreshOne(provider, "initial", noPublish)
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
        const built = buildModelInfos(provider.id, entry?.models ?? [], candidates, provider.baseURL)
        for (const warning of built.warnings) {
          report(`provider \`${provider.id}\`: ${warning}`)
        }
        draft.add({
          info: buildProviderInfo(provider, provider.baseURL.apiRoot),
          models: [...built.models],
          ...(entry?.sourceConnection !== undefined ? { sourceConnection: entry.sourceConnection } : {}),
        })
      }
    })

    await context.command.transform((draft) => {
      draft.add({
        name: REFRESH_COMMAND,
        description: "Refresh the New API Provider model catalogs (no model call involved)",
        execute: async () => {
          if (!pool.isOpen) {
            report("the plugin is unloading; refresh skipped")
            return
          }
          const outcomes = await Promise.all(
            config.providers.map(async (provider) => {
              const round = refreshOne(provider, "manual", publish)
              pool.track(round)
              return {
                providerID: provider.id,
                outcome: await round.catch((error) => {
                  report(`provider \`${provider.id}\`: model discovery failed (${unexpectedError()})`)
                  return { status: "kept", message: unexpectedError() } as RefreshOutcome
                }),
              }
            }),
          )
          // Each round already asked for a rebuild when it changed the catalog; this
          // one makes sure the last state is published before the command returns.
          if (pool.isOpen && outcomes.some(({ outcome }) => outcomeChangedVisibility(outcome))) {
            await context.provider.reload()
          }
          if (!pool.isOpen) return
          const problems = outcomes.filter(
            ({ outcome }) =>
              outcome.status === "kept" ||
              outcome.status === "hidden" ||
              (outcome.status === "cleared" && outcome.reason !== "empty-catalog"),
          )
          if (problems.length > 0) {
            const summary = outcomes
              .map(({ providerID, outcome }) => `\`${providerID}\`: ${describeOutcome(outcome)}`)
              .join("; ")
            throw new Error(`${PLUGIN_ID} refresh reported problems: ${summary}`)
          }
        },
      })
    })

    // A credential of one group changed: that group refreshes at once, on its own.
    const eventLoop = (async () => {
      try {
        for await (const event of context.event.subscribe({
          types: ["credential.switched", "credential.updated"],
          signal: controller.signal,
        })) {
          if (!pool.isOpen) break
          if (event.type !== "credential.switched" && event.type !== "credential.updated") continue
          const integrationID = (event.data as { integrationID?: string } | undefined)?.integrationID
          const provider = config.providers.find((candidate) => candidate.id === integrationID)
          if (provider === undefined) continue
          pool.track(
            refreshOne(provider, "manual", publish).catch((error) => {
              report(`provider \`${provider.id}\`: refresh after credential change failed (${unexpectedError()})`)
            }),
          )
        }
      } catch {
        // Subscription ended (cleanup or transport close); no further refreshes.
      }
    })()
    void eventLoop

    // The background refreshes start only now, with every transform in place:
    // setup itself never waits for them.
    for (const provider of background) {
      if (!pool.isOpen) break
      pool.track(
        refreshOne(provider, "background", publish).catch((error) => {
          report(`provider \`${provider.id}\`: background refresh failed (${unexpectedError()})`)
        }),
      )
    }

    return async () => {
      // Nothing new starts once cleanup began: not from an event, the command,
      // or the background refreshes.
      pool.close()
      // The credential subscription ends.
      controller.abort()
      // The rounds that already started finish, their storage writes included.
      // No rebuild is asked for in here (see `publish`).
      await pool.drain()
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
  if (outcome.status === "hidden") return `models hidden (${outcome.message})`
  return "superseded by a newer refresh"
}

export default newapiProvider
