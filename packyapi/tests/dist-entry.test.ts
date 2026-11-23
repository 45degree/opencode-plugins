// Import smoke + bundle-shape assertions for the built entry: package.json
// main/exports point at dist/, so a real host load resolves this exact file.
// The prebuilt bundle must inline ordinary dependencies (fast-fuzzy) because the
// Bun host resolves bare imports from the plugin directory - which a clean
// machine does not have - while SDK/Effect imports stay external for the host.
// Run after `pnpm run build:dist`.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import entry from "../dist/index.js"
import { REFRESH_COMMAND } from "../dist/index.js"

describe("dist entry", () => {
  it("loads from dist and exposes the plugin contract", () => {
    assert.equal(entry.id, "packyapi")
    assert.equal(typeof entry.setup, "function")
    assert.equal(REFRESH_COMMAND, "packyapi-refresh")
  })

  it("is a self-contained bundle: ordinary dependencies are inlined, host SDK stays external", () => {
    const bundle = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8")
    assert.doesNotMatch(bundle, /from\s*"fast-fuzzy"/, "fast-fuzzy must be inlined, not imported bare")
    assert.doesNotMatch(bundle, /from\s*"(graphemesplit|tiny-inflate|unicode-trie|js-base64)"/, "no ordinary dependency may stay a bare import")
    assert.match(bundle, /from\s*"@opencode\/plugin"/, "the host SDK import stays external")
    assert.doesNotMatch(bundle, /(^|\n)\s*import[^;\n]*from\s*"(effect|effect\/[^"]*|node:[^"]*|bun:[^"]*)"/, "only host-injected SDK imports may remain external")
  })

  it("ships licenses for every inlined third-party package with dist", () => {
    const licenses = readFileSync(new URL("../dist/THIRD-PARTY-LICENSES", import.meta.url), "utf8")
    for (const inlined of ["fast-fuzzy", "graphemesplit", "tiny-inflate", "unicode-trie", "js-base64"]) {
      assert.match(licenses, new RegExp(`^${inlined} v[0-9]`, "m"), `${inlined} license must ship with dist`)
    }
  })
})
