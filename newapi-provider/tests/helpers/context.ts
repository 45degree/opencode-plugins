import type { Plugin } from "@opencode/plugin"

export interface RecordedModel {
  id: string
  providerID: string
  name: string
  capabilities: { tools: boolean; input: string[]; output: string[]; temperature?: boolean }
  limit: { context: number; output: number; input?: number }
  cost: unknown[]
  variants: unknown[]
  time: { released: number }
  status: string
  enabled: boolean
  type?: string
  family?: string
  package?: string
}

export interface RecordedProvider {
  id: string
  name: string
  activation: string
  package: string
  integrationID?: string
  settings?: Record<string, unknown>
}

export interface RecordedIntegration {
  id: string
  name: string
}

export interface RecordedMethod {
  integrationID: string
  method: { type: string; label?: string }
}

export interface RecordedCommand {
  name: string
  description?: string
  execute: (input: { sessionID: unknown; prompt: unknown; delivery: unknown }) => Promise<void>
}

export interface RecordedDrafts {
  providers: Map<string, { provider: RecordedProvider; models: Map<string, RecordedModel> }>
  integrations: Map<string, RecordedIntegration>
  methods: RecordedMethod[]
  commands: Map<string, RecordedCommand>
  providerTransforms: number
  integrationTransforms: number
  commandTransforms: number
  removedProviders: string[]
  setModelCalls: Array<{ providerID: string; modelIDs: string[] }>
  reloadCalls: number
  /** Every connection status handed to the host, in order. */
  statusReports: Array<{ integrationID: string; connection: unknown; status: unknown }>
  /** How often the plugin subscribed to host events, and how often that subscription was cancelled. */
  eventSubscriptions: number
  subscriptionAborts: number
}

/** In-memory stand-in for the host's plugin-scoped JSON storage; share one across setups to model restarts. */
export interface StorageStub {
  /** Raw stored values as the host keeps them; tests may corrupt an entry directly. */
  data: Map<string, unknown>
  reads: string[]
  /** Writes that landed, in landing order. */
  writes: Array<{ key: string; value: unknown }>
  /** Runs before a write lands: reject to fail the write, stay pending to hold it. */
  beforeWrite?: (key: string, value: unknown) => Promise<void>
  /** Runs before a read is answered: stay pending to hold it. */
  beforeRead?: (key: string) => Promise<void>
}

export function makeStorage(initial: Record<string, unknown> = {}): StorageStub {
  return { data: new Map(Object.entries(initial)), reads: [], writes: [] }
}

export interface ConnectionStub {
  /** Credential returned for every integration (single-provider stubs). */
  credential?: { type: string; key?: string }
  /** Credential per integration id; overrides `credential` when present. */
  credentialsByIntegration?: Record<string, { type: string; key?: string } | undefined>
  id?: string
  failActive?: boolean
  /** Message thrown by `connection.active`; simulates internal host errors. */
  activeError?: string
  failResolve?: boolean
}

export interface ContextStubOptions {
  options?: Record<string, unknown>
  connection?: ConnectionStub
  /** Events delivered by `event.subscribe` after setup. */
  events?: Array<{ type: string; data?: Record<string, unknown> }>
  /** Pre-registered providers, standing in for host-native catalog sources (models-dev transforms). */
  seedProviders?: Array<{ id: string; name?: string; models: Array<Record<string, unknown>> }>
  /** Plugin storage; pass the same stub to several setups to model a restart. */
  storage?: StorageStub
}

/** Recording PluginContext stub covering the domains setup touches; cast at the seam. */
export function makeContext(options: ContextStubOptions = {}) {
  const drafts: RecordedDrafts = {
    providers: new Map(),
    integrations: new Map(),
    methods: [],
    commands: new Map(),
    providerTransforms: 0,
    integrationTransforms: 0,
    commandTransforms: 0,
    removedProviders: [],
    setModelCalls: [],
    reloadCalls: 0,
    statusReports: [],
    eventSubscriptions: 0,
    subscriptionAborts: 0,
  }
  const storage = options.storage ?? makeStorage()

  const connection = options.connection ?? {}

  for (const seed of options.seedProviders ?? []) {
    const models = new Map<string, RecordedModel>()
    for (const model of seed.models) {
      const caps = (model["capabilities"] as Record<string, unknown> | undefined) ?? {}
      const base: RecordedModel = {
        id: String(model["id"] ?? ""),
        providerID: seed.id,
        name: String(model["name"] ?? String(model["id"] ?? "")),
        capabilities: {
          tools: Boolean(caps["tools"] ?? model["tools"] ?? true),
          input: ((caps["input"] ?? model["input"] ?? ["text"]) as string[]),
          output: ((caps["output"] ?? model["output"] ?? ["text"]) as string[]),
          ...((caps["temperature"] ?? model["temperature"]) !== undefined
            ? { temperature: Boolean(caps["temperature"] ?? model["temperature"]) }
            : {}),
        },
        limit: (model["limit"] as RecordedModel["limit"]) ?? { context: 128000, output: 8192 },
        cost: (model["cost"] as unknown[]) ?? [],
        variants: (model["variants"] as unknown[]) ?? [],
        time: { released: Number(model["released"] ?? 0) },
        status: String(model["status"] ?? "active"),
        enabled: Boolean(model["enabled"] ?? true),
      }
      for (const [key, value] of Object.entries(model)) {
        if (!(key in base)) (base as unknown as Record<string, unknown>)[key] = value
      }
      models.set(base.id, base)
    }
    drafts.providers.set(seed.id, {
      provider: {
        id: seed.id,
        name: seed.name ?? seed.id,
        activation: "auto",
        package: "@opencode/ai/models-dev",
        settings: { provider: seed.id },
      },
      models,
    })
  }

  let pendingEvents: Array<{ type: string; data?: Record<string, unknown> }> = [...(options.events ?? [])]
  let notifyEvent: (() => void) | undefined
  const emitEvent = (event: { type: string; data?: Record<string, unknown> }) => {
    pendingEvents.push(event)
    notifyEvent?.()
  }

  let providerTransform: ((draft: never) => void) | undefined

  const makeEditor = () => ({
    list: () => Array.from(drafts.providers.values()),
    get: (id: string) => drafts.providers.get(id),
    add: (input: { info: RecordedProvider; models: RecordedModel[]; sourceConnection?: unknown }) => {
      const entry = drafts.providers.get(input.info.id) ?? {
        provider: input.info,
        models: new Map<string, RecordedModel>(),
      }
      entry.provider = input.info
      entry.models = new Map(input.models.map((m) => [m.id, m]))
      drafts.providers.set(input.info.id, entry)
    },
    update: (id: string, update: (p: RecordedProvider) => void) => {
      const entry = drafts.providers.get(id)
      if (entry === undefined) {
        const created = { id, name: "", activation: "auto", package: "" }
        drafts.providers.set(id, { provider: created, models: new Map() })
        update(created)
        return
      }
      update(entry.provider)
    },
    remove: (id: string) => {
      drafts.providers.delete(id)
      drafts.removedProviders.push(id)
    },
    models: {
      set: (providerID: string, models: RecordedModel[]) => {
        const entry = drafts.providers.get(providerID)
        if (entry === undefined) return
        entry.models = new Map(models.map((m) => [m.id, m]))
        drafts.setModelCalls.push({ providerID, modelIDs: models.map((m) => m.id) })
      },
      update: () => {},
      remove: (providerID: string, modelID: string) => {
        drafts.providers.get(providerID)?.models.delete(modelID)
      },
    },
  })

  const context = {
    options: options.options ?? {},
    integration: {
      transform: async (fn: (draft: never) => void) => {
        drafts.integrationTransforms++
        fn({
          update: (id: string, update: (i: RecordedIntegration) => void) => {
            let integration = drafts.integrations.get(id)
            if (integration === undefined) {
              integration = { id, name: "" }
              drafts.integrations.set(id, integration)
            }
            update(integration)
          },
          remove: (id: string) => drafts.integrations.delete(id),
          method: {
            update: (input: RecordedMethod) => drafts.methods.push(input),
            remove: () => {},
          },
        } as never)
        return { dispose: async () => {} }
      },
      connection: {
        active: async (integrationID: string) => {
          if (connection.failActive) throw new Error(connection.activeError ?? "active lookup failed")
          const credential =
            connection.credentialsByIntegration !== undefined
              ? connection.credentialsByIntegration[integrationID]
              : connection.credential
          if (credential === undefined) return undefined
          return {
            type: "credential",
            id: `${connection.id ?? "cred"}-${integrationID}`,
            label: "test",
            method: "key",
            integrationID,
          }
        },
        resolve: async (resolved: { integrationID?: string }) => {
          if (connection.failResolve) throw new Error("resolve failed")
          if (connection.credentialsByIntegration !== undefined) {
            return connection.credentialsByIntegration[resolved.integrationID ?? ""]
          }
          return connection.credential
        },
        status: async (report: { integrationID: string; connection: unknown; status: unknown }) => {
          drafts.statusReports.push(report)
        },
      },
    },
    provider: {
      transform: async (fn: (draft: never) => void) => {
        drafts.providerTransforms++
        providerTransform = fn
        fn(makeEditor() as never)
        return { dispose: async () => {} }
      },
      reload: async () => {
        drafts.reloadCalls++
        providerTransform?.(makeEditor() as never)
      },
    },
    command: {
      transform: async (fn: (draft: never) => void) => {
        drafts.commandTransforms++
        fn({
          add: (definition: RecordedCommand) => drafts.commands.set(definition.name, definition),
        } as never)
        return { dispose: async () => {} }
      },
    },
    event: {
      // Honors the abort signal like the host does: an aborted subscription ends.
      subscribe: (options?: { signal?: AbortSignal }) => {
        const signal = options?.signal
        drafts.eventSubscriptions++
        signal?.addEventListener(
          "abort",
          () => {
            drafts.subscriptionAborts++
            notifyEvent?.()
          },
          { once: true },
        )
        return (async function* eventStream() {
          let resume: (() => void) | undefined
          const promise = () => new Promise<void>((resolve) => (resume = resolve))
          while (true) {
            while (pendingEvents.length > 0) {
              const next = pendingEvents.shift()!
              yield { type: next.type, data: next.data ?? {} }
            }
            if (signal?.aborted) return
            notifyEvent = () => {
              notifyEvent = undefined
              resume?.()
            }
            await promise()
            if (signal?.aborted) return
          }
        })()
      },
    },
    storage: {
      get: async (key: string) => {
        storage.reads.push(key)
        await storage.beforeRead?.(key)
        const value = storage.data.get(key)
        return value === undefined ? undefined : structuredClone(value)
      },
      set: async (key: string, value: unknown) => {
        await storage.beforeWrite?.(key, value)
        const copy = structuredClone(value)
        storage.writes.push({ key, value: copy })
        storage.data.set(key, copy)
      },
      remove: async (key: string) => {
        storage.data.delete(key)
      },
      scan: async () => ({ entries: [] }),
    },
  }

  return { context: context as unknown as Plugin.Context, drafts, emitEvent, connection, storage }
}

export interface RecordedRequest {
  url: string
  method?: string
  authorization?: string
}

/** Install a recording global fetch replying with the given /v1/models payload. */
export function stubModelsFetch(payload: unknown, status = 200): {
  requests: RecordedRequest[]
  restore: () => void
} {
  const requests: RecordedRequest[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    requests.push({
      url: String(input),
      method: init?.method,
      authorization: headers["authorization"] ?? headers["Authorization"],
    })
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof globalThis.fetch
  return { requests, restore: () => (globalThis.fetch = original) }
}

/** Install a recording global fetch whose status and payload are decided per request. */
export function stubRoutedFetch(
  respond: (request: RecordedRequest) => { payload: unknown; status?: number },
): {
  requests: RecordedRequest[]
  restore: () => void
} {
  const requests: RecordedRequest[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method,
      authorization: headers["authorization"] ?? headers["Authorization"],
    }
    requests.push(request)
    const { payload, status = 200 } = respond(request)
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof globalThis.fetch
  return { requests, restore: () => (globalThis.fetch = original) }
}

/** Yields to the event loop until `condition` holds; fails instead of hanging when it never does. */
export async function until(condition: () => boolean, what: string, budgetMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > budgetMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** True once `promise` settled, whatever it did. */
export function settled(promise: Promise<unknown>): () => boolean {
  let done = false
  void promise.then(
    () => (done = true),
    () => (done = true),
  )
  return () => done
}

export interface GatedRequest {
  readonly request: RecordedRequest
  /** Answers the request. False when it was already answered or aborted. */
  answer: (payload: unknown, status?: number) => boolean
}

/**
 * Install a recording fetch that answers nothing until the test does. Like the real
 * fetch, a request whose signal aborts rejects and can no longer be answered.
 */
export function stubGatedFetch(): {
  /** Every request in arrival order, answered or not. */
  requests: RecordedRequest[]
  /** Requests not answered yet, in arrival order. */
  pending: () => GatedRequest[]
  answer: (index: number, payload: unknown, status?: number) => void
  restore: () => void
} {
  const requests: RecordedRequest[] = []
  const open: GatedRequest[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method,
      authorization: headers["authorization"] ?? headers["Authorization"],
    }
    requests.push(request)
    return new Promise<Response>((resolve, reject) => {
      const gated: GatedRequest = {
        request,
        answer: (payload: unknown, status = 200) => {
          const at = open.indexOf(gated)
          if (at < 0) return false
          open.splice(at, 1)
          resolve(new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }))
          return true
        },
      }
      open.push(gated)
      init?.signal?.addEventListener("abort", () => {
        const at = open.indexOf(gated)
        if (at >= 0) open.splice(at, 1)
        reject(new Error("The operation was aborted due to timeout"))
      })
    })
  }) as unknown as typeof globalThis.fetch
  return {
    requests,
    pending: () => [...open],
    answer: (index, payload, status) => {
      const gated = open[index]
      if (gated === undefined) throw new Error(`no pending request at index ${index}`)
      gated.answer(payload, status)
    },
    restore: () => (globalThis.fetch = original),
  }
}
