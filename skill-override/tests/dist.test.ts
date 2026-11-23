import assert from "node:assert/strict"
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "node:test"

// Structural shape of the public entry contract; declared locally so the test
// depends on neither src/ nor any node_modules package.
interface PluginModule {
  default: {
    id: string
    setup: (context: unknown) => Promise<() => Promise<void>>
  }
}

// The bundle is copied alone into a bare directory and imported from there, so
// the test fails if dist/index.js still reaches src/ or any dependency file.
test("dist bundle exposes the plugin contract standalone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-override-dist-"))
  const bundle = join(directory, "index.js")
  await copyFile(new URL("../dist/index.js", import.meta.url), bundle)
  // Non-literal specifier keeps TypeScript from demanding declarations for the
  // minified artifact, which intentionally ships without .d.ts files.
  const imported: PluginModule = await import(pathToFileURL(bundle).href)
  const plugin = imported.default
  assert.equal(plugin.id, "skill-override")
  assert.equal(typeof plugin.setup, "function")

  const previousHome = process.env.HOME
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.HOME = directory
  process.env.XDG_CONFIG_HOME = directory
  let registered = false
  let disposed = false
  let cleanup: (() => Promise<void>) | undefined
  try {
    cleanup = await plugin.setup({
      location: { directory },
      skill: {
        transform: async () => {
          registered = true
          return { dispose: async () => { disposed = true } }
        },
        reload: async () => {},
        list: async () => ({ data: [] }),
      },
    })
    assert.equal(registered, true)
  } finally {
    // Always stop the poller, even when an assertion above fails.
    try {
      await cleanup?.()
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdg
      await rm(directory, { recursive: true, force: true })
    }
  }
  assert.equal(disposed, true)
})
