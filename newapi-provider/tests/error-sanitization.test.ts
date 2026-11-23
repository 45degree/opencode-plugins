// Internal errors from the host or libraries can carry sensitive details in their
// messages, so they are reported as a fixed classification and never passed through.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { makeContext, stubModelsFetch } from "./helpers/context.js"
import newapiProvider from "../src/index.js"

const OPTIONS = {
  providers: [{ base_url: "https://newapi.example.com", groups: [{ id: "packy-work", name: "Packy Work" }] }],
}

describe("lifecycle: internal error classification", () => {
  it("reports an unknown connection error as a classified failure without its message", async () => {
    const { context, drafts } = makeContext({
      options: OPTIONS,
      connection: { failActive: true, activeError: "boom for sk-fake-secret-value" },
    })
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
    const { restore } = stubModelsFetch({ object: "list", data: [] })
    let cleanup: (() => Promise<void> | void) | undefined
    try {
      cleanup = normalizeCleanup(await newapiProvider.setup(context))
    } finally {
      console.warn = originalWarn
      restore()
    }

    const diagnostics = warnings.join("\n")
    assert.match(diagnostics, /unexpected error/, "the unknown failure is reported with a fixed classification")
    assert.doesNotMatch(diagnostics, /sk-fake-secret-value/, "the raw error message never reaches the output")
    if (cleanup) await cleanup()
  })

  it("keeps the classified form on the manual refresh path", async () => {
    const { context, drafts } = makeContext({
      options: OPTIONS,
      connection: { failActive: true, activeError: "boom for sk-fake-secret-value" },
    })
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
    const { restore } = stubModelsFetch({ object: "list", data: [] })
    let cleanup: (() => Promise<void> | void) | undefined
    try {
      cleanup = normalizeCleanup(await newapiProvider.setup(context))
      const command = drafts.commands.get("newapi-provider-refresh")!
      await assert.rejects(() =>
        command.execute({ sessionID: "ses_test" as never, prompt: {} as never, delivery: {} as never }),
      )
    } finally {
      console.warn = originalWarn
      restore()
    }

    const diagnostics = warnings.join("\n")
    assert.doesNotMatch(diagnostics, /sk-fake-secret-value/, "the refresh path never leaks the raw message")
    if (cleanup) await cleanup()
  })
})

function normalizeCleanup(result: Awaited<ReturnType<typeof newapiProvider.setup>>): (() => Promise<void> | void) | undefined {
  return typeof result === "function" ? result : undefined
}
