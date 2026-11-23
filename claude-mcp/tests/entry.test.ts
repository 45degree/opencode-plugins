import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import plugin from "../src/entry.js";

const temporaryDirectories: string[] = [];
const originalHome = process.env.HOME;
const originalEnv = { ...process.env };

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  process.env = { ...originalEnv };
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "claude-mcp-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeConfig(directory: string, value: unknown, fileName: ".mcp.json" | "mcp.json" = ".mcp.json"): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, fileName), JSON.stringify(value));
}

async function load(options: Record<string, unknown>, directory: string, initial: Map<string, unknown> = new Map()) {
  const registered = new Map(initial);
  const warnings: string[] = [];
  const context = {
    options,
    location: { directory },
    mcp: {
      transform: async (callback: (editor: { get: (name: string) => unknown; set: (name: string, value: unknown) => void }) => void) => {
        callback({
          get: (name) => registered.get(name),
          set: (name, value) => { registered.set(name, value); },
        });
      },
    },
  };
  const warningMock = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.join(" "));
  });
  try {
    await plugin.setup(context as Parameters<typeof plugin.setup>[0]);
  } finally {
    warningMock.mock.restore();
  }
  return { registered, warnings };
}

test("defaults, project toggle, and native names including disabled entries", async () => {
  const directory = await temporaryDirectory();
  await writeConfig(directory, { mcpServers: { project: { command: "run" }, occupied: { command: "not-run" } } });
  const { registered } = await load({}, directory, new Map([["occupied", { disabled: true }]]));
  assert.deepEqual(registered.get("project"), { type: "local", command: ["run"], cwd: directory });
  assert.deepEqual(registered.get("occupied"), { disabled: true });

  const skipped = await load({ readProject: false }, directory);
  assert.equal(skipped.registered.size, 0);
  await assert.rejects(load({ readProject: "yes" }, directory), /readProject.*boolean/);
  await assert.rejects(load({ readProject: null }, directory), /readProject.*boolean/);
  await assert.rejects(load({ globalDirectories: [2] }, directory), /globalDirectories.*strings/);
  await assert.rejects(load({ globalDirectories: null }, directory), /globalDirectories.*strings/);
});

test("global order, project precedence, and whole-service replacement", async () => {
  const directory = await temporaryDirectory();
  const first = join(directory, "first");
  const second = join(directory, "second");
  await writeConfig(first, { mcpServers: { shared: { command: "first", args: ["old"] }, earlier: { command: "a" } } }, "mcp.json");
  await writeConfig(second, { mcpServers: { shared: { command: "second" } } }, "mcp.json");
  await writeConfig(directory, { mcpServers: { shared: { command: "project" } } });
  const { registered } = await load({ globalDirectories: ["first", second] }, directory);
  assert.deepEqual(registered.get("shared"), { type: "local", command: ["project"], cwd: directory });
  assert.deepEqual(registered.get("earlier"), { type: "local", command: ["a"], cwd: directory });
});

test("expands home and relative paths, variables, empty values and defaults", async () => {
  const directory = await temporaryDirectory();
  const home = join(directory, "home");
  process.env.HOME = home;
  process.env.PRESENT = "value";
  process.env.EMPTY = "";
  delete process.env.MISSING;
  await writeConfig(join(home, "global"), { mcpServers: { home: { command: "${PRESENT}", env: { X: "${EMPTY}", Y: "${MISSING:-fallback}", Z: "${MISSING}" } } } }, "mcp.json");
  const { registered, warnings } = await load({ globalDirectories: ["~/global"] }, directory);
  assert.deepEqual(registered.get("home"), {
    type: "local", command: ["value"], cwd: directory,
    environment: { X: "", Y: "fallback", Z: "${MISSING}" },
  });
  assert.ok(warnings.some((line) => line.includes("missing environment variable")));
  assert.ok(warnings.every((line) => !line.includes("fallback") && !line.includes("MISSING")));
});

test("global directories read mcp.json only and the project reads .mcp.json only", async () => {
  const directory = await temporaryDirectory();
  const globalDirectory = join(directory, "global");
  await writeConfig(globalDirectory, { mcpServers: { fromGlobal: { command: "global" } } }, "mcp.json");
  await writeConfig(globalDirectory, { mcpServers: { wrongGlobalName: { command: "ignored" } } });
  await writeConfig(directory, { mcpServers: { fromProject: { command: "project" } } });
  await writeConfig(directory, { mcpServers: { wrongProjectName: { command: "ignored" } } }, "mcp.json");
  const { registered } = await load({ globalDirectories: [globalDirectory] }, directory);
  assert.deepEqual(registered.get("fromGlobal"), { type: "local", command: ["global"], cwd: directory });
  assert.deepEqual(registered.get("fromProject"), { type: "local", command: ["project"], cwd: directory });
  assert.equal(registered.has("wrongGlobalName"), false);
  assert.equal(registered.has("wrongProjectName"), false);
});

test("converts remote services and skips unsupported transports and invalid entries safely", async () => {
  const directory = await temporaryDirectory();
  await writeConfig(directory, { mcpServers: {
    remote: { type: "http", url: "https://example.test/${TOKEN}", headers: { Authorization: "${TOKEN}" } },
    streamable: { type: "streamable-http", url: "https://example.test" },
    validStdio: { command: "allowed" },
    sse: { type: "sse", url: "https://secret.invalid" },
    websocket: { type: "ws", url: "wss://secret.invalid" },
    broken: { command: 4, env: { SECRET: "secret-value" } },
  } });
  process.env.TOKEN = "top-secret";
  const { registered, warnings } = await load({}, directory);
  assert.deepEqual(registered.get("remote"), { type: "remote", url: "https://example.test/top-secret", headers: { Authorization: "top-secret" } });
  assert.deepEqual(registered.get("streamable"), { type: "remote", url: "https://example.test" });
  assert.deepEqual(registered.get("validStdio"), { type: "local", command: ["allowed"], cwd: directory });
  assert.equal(registered.has("sse"), false);
  assert.equal(registered.has("websocket"), false);
  assert.equal(registered.has("broken"), false);
  assert.ok(warnings.every((line) => !line.includes("top-secret") && !line.includes("secret.invalid") && !line.includes("secret-value")));
});

test("validates expanded HTTP URLs and skips invalid values without logging them", async () => {
  const directory = await temporaryDirectory();
  delete process.env.CLAUDE_MCP_SECRET_ENDPOINT;
  await writeConfig(directory, { mcpServers: {
    empty: { type: "http", url: "" },
    relative: { type: "http", url: "/relative/path" },
    malformed: { type: "http", url: "not-a-url-secret" },
    unsupportedScheme: { type: "http", url: "ftp://private.example/path" },
    missingExpansion: { type: "http", url: "${CLAUDE_MCP_SECRET_ENDPOINT}" },
    valid: { type: "http", url: "https://valid.example/mcp" },
  } });
  const { registered, warnings } = await load({}, directory);
  assert.equal(registered.size, 1);
  assert.deepEqual(registered.get("valid"), { type: "remote", url: "https://valid.example/mcp" });
  assert.equal(warnings.filter((line) => line.endsWith("invalid url field")).length, 5);
  assert.ok(warnings.some((line) => line.endsWith("missing environment variable")));
  assert.ok(warnings.every((line) => !line.includes("not-a-url-secret")
    && !line.includes("private.example") && !line.includes("CLAUDE_MCP_SECRET_ENDPOINT")));
});

test("isolates malformed files and invalid entries, and safely handles prototype names", async () => {
  const directory = await temporaryDirectory();
  await writeFile(join(directory, ".mcp.json"), "{broken-secret");
  const malformed = await load({}, directory);
  assert.equal(malformed.registered.size, 0);
  assert.ok(malformed.warnings.every((line) => !line.includes("broken-secret")));

  await writeFile(join(directory, ".mcp.json"), '{"mcpServers":{"__proto__":{"command":"safe"},"valid":{"command":"ok"},"invalid":null}}');
  const { registered } = await load({}, directory);
  assert.equal(registered.get("__proto__") !== undefined, true);
  assert.equal(registered.has("invalid"), false);
  assert.equal(registered.has("valid"), true);
});

test("replayed transform keeps existing names, even when disabled", async () => {
  const directory = await temporaryDirectory();
  await writeFile(join(directory, ".mcp.json"), '{"mcpServers":{"native":{"command":"plugin"},"__proto__":{"command":"injected"}}}');
  const replayed: Map<string, unknown>[] = [];
  const context = {
    options: {},
    location: { directory },
    mcp: {
      transform: async (callback: (editor: { get: (name: string) => unknown; set: (name: string, value: unknown) => void }) => void) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const existing = new Map<string, unknown>([["native", { disabled: true }]]);
          callback({ get: (name) => existing.get(name), set: (name, value) => existing.set(name, value) });
          replayed.push(existing);
        }
      },
    },
  };
  await plugin.setup(context as Parameters<typeof plugin.setup>[0]);
  for (const existing of replayed) {
    assert.deepEqual(existing.get("native"), { disabled: true });
    assert.deepEqual(existing.get("__proto__"), { type: "local", command: ["injected"], cwd: directory });
  }
});
