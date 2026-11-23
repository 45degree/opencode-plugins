import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

interface StdioServer {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  cwd: string;
}

interface RemoteServer {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
}

type MCPServer = StdioServer | RemoteServer;

interface MCPServerEditor {
  get(name: string): MCPServer | undefined;
  set(name: string, server: MCPServer): void;
}

interface PluginContext {
  readonly options: Record<string, unknown>;
  readonly location: { readonly directory: string };
  readonly mcp: { transform(callback: (editor: MCPServerEditor) => void): Promise<unknown> };
}

interface Options {
  readProject: boolean;
  globalDirectories: string[];
}

type Logger = (source: string, service: string, reason: string) => void;

function resolveOptions(input: Record<string, unknown>): Options {
  const readProject = input.readProject === undefined ? true : input.readProject;
  const globalDirectories = input.globalDirectories === undefined ? [] : input.globalDirectories;
  if (typeof readProject !== "boolean") {
    throw new TypeError('Invalid option "readProject": expected a boolean.');
  }
  if (!Array.isArray(globalDirectories) || globalDirectories.some((item) => typeof item !== "string")) {
    throw new TypeError('Invalid option "globalDirectories": expected an array of strings.');
  }
  return { readProject, globalDirectories: [...globalDirectories] };
}

function expandVariables(value: string, source: string, logger: Logger, service: string): string {
  return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (placeholder, name: string, fallback?: string) => {
    const value = process.env[name];
    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback;
    logger(source, service, "missing environment variable");
    return placeholder;
  });
}

function expandRecord(record: Record<string, string>, source: string, logger: Logger, service: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) result[key] = expandVariables(value, source, logger, service);
  return result;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === "string");
}

function convertServer(name: string, raw: unknown, directory: string, source: string, logger: Logger): MCPServer | undefined {
  const warn = (reason: string): undefined => {
    logger(source, name, reason);
    return undefined;
  };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return warn("invalid server entry");
  const server = raw as Record<string, unknown>;
  const type = server.type;
  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "streamable-http") {
    return warn("unsupported transport type");
  }
  if (type === "http" || type === "streamable-http") {
    if (typeof server.url !== "string") return warn("invalid url field");
    if (server.headers !== undefined && !isStringRecord(server.headers)) return warn("invalid headers field");
    const url = expandVariables(server.url, source, logger, name);
    try {
      const parsed = new URL(url);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "") {
        return warn("invalid url field");
      }
    } catch {
      return warn("invalid url field");
    }
    return {
      type: "remote",
      url,
      ...(server.headers === undefined ? {} : { headers: expandRecord(server.headers as Record<string, string>, source, logger, name) }),
    };
  }
  if (typeof server.command !== "string") return warn("invalid command field");
  if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((item) => typeof item !== "string"))) {
    return warn("invalid args field");
  }
  if (server.env !== undefined && !isStringRecord(server.env)) return warn("invalid env field");
  const command = [server.command, ...((server.args as string[] | undefined) ?? [])]
    .map((part) => expandVariables(part, source, logger, name));
  const environment = server.env === undefined ? undefined : expandRecord(server.env as Record<string, string>, source, logger, name);
  return {
    type: "local",
    command,
    ...(environment === undefined ? {} : { environment }),
    cwd: directory,
  };
}

function resolveDirectory(directory: string, base: string): string {
  const home = process.env.HOME || homedir();
  const expanded = directory === "~" ? home : directory.startsWith("~/") ? resolve(home, directory.slice(2)) : directory;
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

async function readServers(
  filePath: string,
  directory: string,
  logger: Logger,
): Promise<Map<string, MCPServer>> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    logger(filePath, "", "file read failed");
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    logger(filePath, "", "invalid JSON");
    return new Map();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    || (parsed as Record<string, unknown>).mcpServers === null
    || typeof (parsed as Record<string, unknown>).mcpServers !== "object"
    || Array.isArray((parsed as Record<string, unknown>).mcpServers)) {
    logger(filePath, "", "invalid mcpServers field");
    return new Map();
  }
  const result = new Map<string, MCPServer>();
  for (const [name, raw] of Object.entries((parsed as { mcpServers: Record<string, unknown> }).mcpServers)) {
    const converted = convertServer(name, raw, directory, filePath, logger);
    if (converted !== undefined) result.set(name, converted);
  }
  return result;
}

const plugin = {
  id: "claude-mcp",
  setup: async (context: PluginContext): Promise<void> => {
    const options = resolveOptions(context.options);
    const log: Logger = (source, service, reason) => {
      console.warn("[claude-mcp]", source, service, reason);
    };
    const directory = context.location.directory;
    const sources: Array<{ file: string; cwd: string }> = [];
    for (const configuredDirectory of options.globalDirectories) {
      const globalDirectory = resolveDirectory(configuredDirectory, directory);
      sources.push({ file: resolve(globalDirectory, "mcp.json"), cwd: directory });
    }
    if (options.readProject) sources.push({ file: resolve(directory, ".mcp.json"), cwd: directory });
    const merged = new Map<string, MCPServer>();
    for (const source of sources) {
      const servers = await readServers(source.file, source.cwd, log);
      for (const [name, server] of servers) merged.set(name, server);
    }
    await context.mcp.transform((editor) => {
      for (const [name, server] of merged) {
        if (editor.get(name) === undefined) editor.set(name, server);
      }
    });
  },
};

export default plugin;
