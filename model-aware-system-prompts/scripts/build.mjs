import { build } from "esbuild"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "dist")
const external = ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*", "node:*", "bun:*"]

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const result = await build({
  entryPoints: [path.join(root, "entry", "index.ts")],
  outfile: path.join(dist, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  charset: "utf8",
  minify: true,
  external,
  // Nunjucks is CommonJS and requires node builtins at runtime; the banner
  // gives the ESM bundle a real require backed by createRequire.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  // Escape template literals into plain strings so generated lines never
  // carry trailing whitespace that would fail `git diff --check`.
  supported: { "template-literal": false },
  absWorkingDir: root,
  metafile: true,
  logLevel: "silent",
})

writeInlinedLicenses(dist, root, result.metafile)

// Collect the exact applicable license notices for every package that the
// metafile shows as inlined into the bundle. Missing license files fail the
// build instead of shipping an incomplete notice.
function writeInlinedLicenses(distDir, pluginRoot, metafile) {
  const sections = new Map()
  const missing = new Map()
  for (const input of Object.keys(metafile.inputs)) {
    const absolute = path.resolve(pluginRoot, input)
    if (!absolute.includes(`${path.sep}node_modules${path.sep}`)) continue
    const packageRoot = findPackageRoot(absolute, pluginRoot)
    if (packageRoot === undefined || sections.has(packageRoot)) continue
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"))
    const licensePath = findLicenseFile(packageRoot)
    if (licensePath === undefined) {
      missing.set(manifest.name, packageRoot)
      continue
    }
    sections.set(packageRoot, {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? "unknown",
      // Only the file's ends are trimmed; the legal wording is preserved verbatim.
      text: readFileSync(licensePath, "utf8").trim(),
    })
  }
  if (missing.size > 0) {
    console.error(`build failed: no license file found for inlined packages: ${Array.from(missing.keys()).join(", ")}`)
    for (const [name, packageRoot] of missing) console.error(`  ${name}: ${packageRoot}`)
    process.exitCode = 1
    return
  }
  const rollup = Array.from(sections.values(), (section) => `${section.name} v${section.version} (${section.license})\n\n${section.text}`).join("\n\n---\n\n")
  writeFileSync(path.join(distDir, "THIRD-PARTY-LICENSES"), rollup + "\n")
}

function findPackageRoot(fromFile, pluginRoot) {
  let dir = path.dirname(fromFile)
  while (dir.startsWith(pluginRoot) && dir !== pluginRoot) {
    if (existsSync(path.join(dir, "package.json"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

function findLicenseFile(packageDir) {
  const entries = readdirSync(packageDir)
  const found = entries.find((entry) => /^(licen[cs]e|copying|notice)(\.(md|txt|html))?$/i.test(entry))
  return found === undefined ? undefined : path.join(packageDir, found)
}
