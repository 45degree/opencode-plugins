import assert from "node:assert/strict"
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "node:test"
import { HOOK_NAMES } from "../src/entry.js"

// Structural shape of the public entry contract; declared locally so the test
// depends on neither src/ nor any node_modules package.
interface PluginModule {
  default: {
    id: string
    setup: (context: unknown) => Promise<() => Promise<void>>
  }
}

// The bundle is copied alone into a bare directory and imported from there, so
// the test fails if dist/index.js still reaches src/ or any dependency file —
// the bundle must be self-contained, including the template engine.
test("dist bundle exposes the plugin contract standalone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-aware-system-prompts-dist-"))
  const bundle = join(directory, "index.js")
  await copyFile(new URL("../dist/index.js", import.meta.url), bundle)
  // Non-literal specifier keeps TypeScript from demanding declarations for the
  // minified artifact, which intentionally ships without .d.ts files.
  const imported: PluginModule = await import(pathToFileURL(bundle).href)
  const plugin = imported.default
  assert.equal(plugin.id, "model-aware-system-prompts")
  assert.equal(typeof plugin.setup, "function")

  const registrations: string[] = []
  const callbacks = new Map<string, (event: unknown) => Promise<void>>()
  await plugin.setup({
    session: {
      hook: async (name: string, callback: (event: unknown) => Promise<void>) => {
        registrations.push(name)
        callbacks.set(name, callback)
        return { dispose: async () => {} }
      },
    },
  })
  assert.deepEqual([...registrations].sort(), [...HOOK_NAMES].sort())

  // Render through the bundled engine to prove nunjucks is inlined: the bare
  // directory has no node_modules to resolve it from.
  const render = callbacks.get("context")!
  const event = {
    model: { providerID: "acme", id: "gpt-x" },
    agent: "build",
    system: [{ type: "text", text: '<!-- {% if matches(model, "^gpt") %} -->\n命中\n<!-- {% endif %} -->' }],
  }
  await render(event)
  assert.equal(event.system[0]!.text, "\n命中\n")

  await rm(directory, { recursive: true, force: true })
})
