import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

async function isolatedCopy(): Promise<{ directory: string; entry: string }> {
  const directory = await mkdtemp(join(tmpdir(), "claude-mcp-dist-"));
  const entry = join(directory, "index.js");
  await cp(new URL("../dist/index.js", import.meta.url), entry);
  return { directory, entry };
}

test("built artifact exposes the default plugin contract without source or dependencies", async () => {
  const { directory, entry } = await isolatedCopy();
  try {
    const plugin = (await import(pathToFileURL(entry).href)).default;
    assert.equal(plugin.id, "claude-mcp");
    assert.equal(typeof plugin.setup, "function");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("built artifact setup registers project servers through mcp.transform", async () => {
  const { directory, entry } = await isolatedCopy();
  try {
    const project = join(directory, "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { bundled: { command: "run", args: ["--now"] } } }));
    const registered = new Map<string, unknown>();
    const plugin = (await import(pathToFileURL(entry).href)).default;
    await plugin.setup({
      options: {},
      location: { directory: project },
      mcp: {
        transform: async (callback: (editor: { get: (name: string) => unknown; set: (name: string, value: unknown) => void }) => void) => {
          callback({
            get: (name) => registered.get(name),
            set: (name, value) => { registered.set(name, value); },
          });
        },
      },
    });
    assert.deepEqual(registered.get("bundled"), { type: "local", command: ["run", "--now"], cwd: project });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
