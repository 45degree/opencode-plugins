// Model metadata comes from the host's ENTIRE native catalog: every instance model
// id is fuzzy-scored against all source models (all providers, including inactive,
// excluding this plugin's own providers). The highest score wins; equal scores break
// by source providerID:modelID in dictionary order. Expected winners below are
// pinned from a one-off precomputation with the same library version - the tests
// assert the selected candidate, they never rescore.
//
// The user's own provider list stays the only configuration; defaults/overrides are
// removed and must fail loudly.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { makeContext, stubModelsFetch } from "./helpers/context.js"
import newapiProvider from "../src/index.js"

const RESPONSES_MODEL = (id: string) => ({ id, supported_endpoint_types: ["openai-response"] })

function sourceProvider(id: string, modelIds: string[], extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    models: modelIds.map((modelId) => ({
      id: modelId,
      name: modelId,
      providerID: id,
      status: "active",
      ...extra,
    })),
  }
}

function namedSourceProvider(id: string, models: Array<{ id: string; name: string }>, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    models: models.map((model) => ({
      providerID: id,
      status: "active",
      ...extra,
      id: model.id,
      name: model.name,
    })),
  }
}

const OWN_OPTIONS = { providers: [{ base_url: "https://newapi.example.com", groups: [{ id: "packy-work", name: "Packy Work" }] }] }

async function setupWith(seedProviders: unknown[], payload: unknown, options: Record<string, unknown> = OWN_OPTIONS) {
  const { context, drafts } = makeContext({
    options,
    connection: { credential: { type: "key", key: "sk-fake-work" } },
    seedProviders: seedProviders as never,
  })
  const { restore } = stubModelsFetch(payload)
  const cleanup = await newapiProvider.setup(context)
  restore()
  return { drafts, cleanup: typeof cleanup === "function" ? cleanup : undefined, context }
}

describe("catalog reuse: whole-catalog fuzzy matching", () => {
  it("enables Responses models without any hand-written parameters", async () => {
    const { drafts } = await setupWith(
      [sourceProvider("openai", ["gpt-5.1"])],
      { object: "list", data: [RESPONSES_MODEL("gpt-5.1")] },
    )
    const model = drafts.providers.get("packy-work")!.models.get("gpt-5.1")
    assert.ok(model, "registered without defaults/overrides")
    assert.equal(model!.enabled, true)
  })

  it("matches an exact id across the whole catalog (google gemini-4-carbon, score 1)", async () => {
    const { drafts } = await setupWith(
      [sourceProvider("google", ["gemini-4-carbon"], { limit: { context: 1048576, output: 32768 } })],
      { object: "list", data: [RESPONSES_MODEL("gemini-4-carbon")] },
    )
    const model = drafts.providers.get("packy-work")!.models.get("gemini-4-carbon")!
    assert.deepEqual(model.limit, { context: 1048576, output: 32768 }, "exact source limits are inherited")
    assert.equal(model.name, "gemini-4-carbon", "the display name stays the upstream id")
  })

  it("never inherits the source name, even on an exact match", async () => {
    const { drafts } = await setupWith(
      [namedSourceProvider("google", [{ id: "gemini-4-carbon", name: "Google Gemini 4 Carbon Preview" }], { limit: { context: 1048576, output: 32768 } })],
      { object: "list", data: [RESPONSES_MODEL("gemini-4-carbon")] },
    )
    const model = drafts.providers.get("packy-work")!.models.get("gemini-4-carbon")!
    assert.equal(model.name, "gemini-4-carbon", "the upstream name always wins over the source name")
    assert.deepEqual(model.limit, { context: 1048576, output: 32768 })
  })

  it("does not inherit when the best score is below the 0.8 threshold (alias)", async () => {
    // fast-fuzzy 1.12.0 precomputation for 'gpt-5.1-high':
    // gpt-4.1-mini 0.667 > gpt-5.1-codex 0.615 > gpt-5.1 0.583 > o3 0.
    const { drafts } = await setupWith(
      [sourceProvider("openai", ["gpt-4.1-mini", "gpt-5.1-codex", "gpt-5.1", "o3"], { limit: { context: 400000, output: 32000 } })],
      { object: "list", data: [RESPONSES_MODEL("gpt-5.1-high")] },
    )
    const model = drafts.providers.get("packy-work")!.models.get("gpt-5.1-high")!
    assert.equal(model.limit.context, 200000, "below-threshold best candidates fall back to host defaults")
    assert.equal(model.limit.output, 32000)
    assert.equal(model.name, "gpt-5.1-high", "the upstream name survives a below-threshold match")
  })

  it("reports below-threshold best candidates with their score (real symptom: codex-auto-review/Step5Preview)", async () => {
    // live evidence: upstream id codex-auto-review, native candidate Step5Preview, score 0.411.
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
    const { drafts } = await setupWith(
      [namedSourceProvider("openai", [{ id: "Step5Preview", name: "Step5Preview" }], { limit: { context: 999999, output: 99999 } })],
      { object: "list", data: [RESPONSES_MODEL("codex-auto-review")] },
    )
    console.warn = originalWarn
    const model = drafts.providers.get("packy-work")!.models.get("codex-auto-review")!
    assert.equal(model.name, "codex-auto-review", "the misleading source name must not overwrite the upstream id")
    assert.equal(model.limit.context, 200000, "low-score matches do not inherit limits")
    const diagnostics = warnings.join("\n")
    assert.match(diagnostics, /codex-auto-review/, "the model is named in the diagnostic")
    assert.match(diagnostics, /below/i, "the below-threshold outcome is reported")
    assert.match(diagnostics, /0\.4\d\d/, "the insufficient score is recorded")
    assert.doesNotMatch(diagnostics, /999999/, "no below-threshold values leak into metadata")
  })

  it("inherits limits at score >= 0.8 through the real library (spelling drift)", async () => {
    // fast-fuzzy 1.12.0 precomputation for 'grok4fast':
    // grok-4-fast 0.818 (>= 0.8) > grok-3 0.444 = grok-4 0.444 (tie broken by dictionary order: grok-3 first).
    const { drafts } = await setupWith(
      [sourceProvider("xai", ["grok-4-fast", "grok-3", "grok-4"], { limit: { context: 256000, output: 32000 } })],
      { object: "list", data: [RESPONSES_MODEL("grok4fast")] },
    )
    const model = drafts.providers.get("packy-work")!.models.get("grok4fast")!
    assert.deepEqual(model.limit, { context: 256000, output: 32000 }, "the highest-scoring candidate at or above 0.8 is inherited")
    assert.equal(model.name, "grok4fast", "the name stays the upstream id even for above-threshold matches")
  })

  it("inherits at exactly the 0.8 threshold (>= rule)", async () => {
    // fast-fuzzy 1.12.0 precomputation: 'abcd' vs 'abcde' scores exactly 0.8.
    const { drafts } = await setupWith(
      [sourceProvider("openai", ["abcde"], { limit: { context: 777777, output: 32000 } })],
      { object: "list", data: [RESPONSES_MODEL("abcd")] },
    )
    const model = drafts.providers.get("packy-work")!.models.get("abcd")!
    assert.equal(model.limit.context, 777777, "a score of exactly 0.8 still inherits")
    assert.equal(model.name, "abcd", "the name stays the upstream id")
  })

  it("breaks score ties by source providerID:modelID dictionary order", async () => {
    // 'gpt-x' scores equally against 'alpha' and 'beta' only if the strings tie;
    // use the same id on two providers: identical scores, dictionary order decides.
    const { drafts } = await setupWith(
      [sourceProvider("zzz-late", ["shared-model"]), sourceProvider("aaa-early", ["shared-model"])],
      { object: "list", data: [RESPONSES_MODEL("shared-model")] },
    )
    const model = drafts.providers.get("packy-work")!.models.get("shared-model")!
    assert.equal(model.providerID, "packy-work", "identity stays the group's provider")
    // aaa-early sorts before zzz-late: its name (the model id here) is inherited.
    assert.equal(model.name, "shared-model")
    assert.ok(model.limit, "metadata from the dictionary-first source is used deterministically")
  })

  it("breaks score ties deterministically between providers with different metadata", async () => {
    const sources = [
      {
        id: "zzz-late",
        name: "zzz-late",
        models: [{ id: "shared-model", name: "from-zzz", providerID: "zzz-late", limit: { context: 111111, output: 1111 }, status: "active" }],
      },
      {
        id: "aaa-early",
        name: "aaa-early",
        models: [{ id: "shared-model", name: "from-aaa", providerID: "aaa-early", limit: { context: 222222, output: 2222 }, status: "active" }],
      },
    ]
    const { drafts } = await setupWith(sources, { object: "list", data: [RESPONSES_MODEL("shared-model")] })
    const model = drafts.providers.get("packy-work")!.models.get("shared-model")!
    assert.deepEqual(model.limit, { context: 222222, output: 2222 }, "aaa-early wins the tie by dictionary order")
    assert.equal(model.name, "shared-model", "the name stays the upstream id regardless of tie outcome")
  })

  it("excludes this plugin's own providers from the matching pool", async () => {
    const selfProvider = {
      id: "packy-work",
      name: "Packy Work",
      models: [{ id: "gpt-5.1", name: "SELF-DERIVED gpt-5.1", providerID: "packy-work", limit: { context: 1, output: 1 }, status: "active" }],
    }
    const { drafts } = await setupWith(
      [selfProvider, sourceProvider("openai", ["gpt-5.1"], { limit: { context: 400000, output: 128000 } })],
      { object: "list", data: [RESPONSES_MODEL("gpt-5.1")] },
    )
    const model = drafts.providers.get("packy-work")!.models.get("gpt-5.1")!
    assert.equal(model.name, "gpt-5.1", "self-derived metadata never feeds back into matching")
    assert.deepEqual(model.limit, { context: 400000, output: 128000 }, "limits come from the real native source")
  })

  it("falls back to host defaults when the source catalog is empty", async () => {
    const { drafts } = await setupWith([], { object: "list", data: [RESPONSES_MODEL("codex-auto-review")] })
    const model = drafts.providers.get("packy-work")!.models.get("codex-auto-review")!
    assert.ok(model, "still registered without any source")
    assert.equal(model.limit.context, 200000, "host default limits apply")
    assert.equal(model.limit.output, 32000)
  })

  it("records a fixed-format diagnostic naming the source and score, without channel-capability claims", async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
    const { drafts, cleanup } = await setupWith(
      [sourceProvider("openai", ["gpt-5.1"])],
      { object: "list", data: [RESPONSES_MODEL("gpt-5.1")] },
    )
    if (cleanup) await cleanup()
    console.warn = originalWarn
    assert.ok(drafts.providers.get("packy-work")!.models.has("gpt-5.1"))
    const diagnostics = warnings.join("\n")
    assert.match(diagnostics, /gpt-5\.1/, "the matched model is named")
    assert.match(diagnostics, /openai/, "the source provider is named")
    assert.match(diagnostics, /score/i, "the match score is recorded")
    assert.match(diagnostics, /not a guarantee|no guarantee/i, "the diagnostic disclaims channel capability")
    assert.doesNotMatch(diagnostics, /sk-fake-work/, "diagnostics never contain the key")
  })

  it("never inherits identity, routing, price or protocol fields from the source", async () => {
    const evil = {
      id: "openai",
      name: "OpenAI",
      models: [
        {
          id: "gpt-5.1",
          name: "GPT-5.1",
          providerID: "openai",
          limit: { context: 400000, output: 128000 },
          status: "active",
          settings: { baseURL: "https://evil.example.com", apiKey: "sk-evil" },
          headers: { authorization: "Bearer sk-evil" },
          body: { evil: true },
          package: "@evil/package",
          compatibility: { maxTokensField: "max_tokens" },
          variants: [{ id: "evil" }],
          cost: [{ input: 9, output: 9, cache: { read: 9, write: 9 } }],
          enabled: true,
        },
      ],
    }
    const { drafts } = await setupWith([evil], { object: "list", data: [RESPONSES_MODEL("gpt-5.1")] })
    const model = drafts.providers.get("packy-work")!.models.get("gpt-5.1")! as unknown as Record<string, unknown>
    assert.deepEqual(model.cost, [], "price stays unknown, never inherited")
    assert.equal(model.providerID, "packy-work", "identity stays the group's provider")
    assert.equal(model.id, "gpt-5.1", "the model id stays the upstream id")
    assert.equal(model.name, "gpt-5.1", "the display name stays the upstream id, never the source name")
    assert.equal(model.enabled, true, "enablement comes from the protocol filter, not the source")
    assert.deepEqual(model.variants, [], "source route variants are not copied")
    assert.equal(model.compatibility, undefined, "source compatibility is not copied")
    assert.deepEqual(
      model.settings,
      { baseURL: "https://newapi.example.com/v1" },
      "settings are our own derived route, never the source's settings",
    )
    assert.equal(
      model.package,
      "@opencode/ai/providers/openai-compatible/responses",
      "the package is our own protocol route, never the source's package",
    )
    for (const forbidden of ["headers", "body", "canonical"]) {
      assert.equal(model[forbidden] === undefined, true, `${forbidden} must not be inherited from the source`)
    }
    const provider = drafts.providers.get("packy-work")!.provider
    assert.equal(provider.package, "@opencode/ai/providers/openai-compatible/responses")
    assert.equal((provider.settings as Record<string, unknown>)?.baseURL, "https://newapi.example.com/v1")
  })

  it("re-reads sources on every rebuild: host updates change limits without another upstream fetch", async () => {
    const source = sourceProvider("openai", ["gpt-5.1"], { limit: { context: 400000, output: 128000 } })
    const { context, drafts } = makeContext({
      options: OWN_OPTIONS,
      connection: { credential: { type: "key", key: "sk-fake-work" } },
      seedProviders: [source] as never,
    })
    let fetchCount = 0
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      fetchCount++
      return new Response(
        JSON.stringify({ object: "list", data: [RESPONSES_MODEL("gpt-5.1")] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof globalThis.fetch

    let cleanup: (() => Promise<void> | void) | undefined
    try {
      cleanup = normalizeCleanup(await newapiProvider.setup(context))
      const before = drafts.providers.get("packy-work")!.models.get("gpt-5.1")!
      assert.equal(before.limit.context, 400000)

      ;((source.models[0]! as Record<string, unknown>)["limit"] as Record<string, unknown>)["context"] = 111111
      await context.provider.reload()

      const after = drafts.providers.get("packy-work")!.models.get("gpt-5.1")!
      assert.equal(after.limit.context, 111111, "the rebuilt model carries the updated native limit")
      assert.equal(fetchCount, 1, "no additional upstream request was made")
    } finally {
      if (cleanup) await cleanup()
      globalThis.fetch = original
    }
  })
})

function normalizeCleanup(result: Awaited<ReturnType<typeof newapiProvider.setup>>): (() => Promise<void> | void) | undefined {
  return typeof result === "function" ? result : undefined
}
