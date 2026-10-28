import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig, type AppConfig } from "../../src/config.js";
import type {
  KVStoreApi,
  LoggerLike,
  ProviderBundle,
  ProviderContextLike,
  ProviderModules,
  UpstreamManifest,
  UrlsSnapshot,
} from "../../src/types.js";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);

export type FixtureModuleName = "posts" | "meta" | "stream" | "episodes" | "settings";

export interface FixtureProvider {
  value: string;
  version: string;
  disabled?: boolean;
  displayName?: string;
  optional?: boolean;
  modules?: Partial<Record<FixtureModuleName, string | null>>;
}

export interface SnapshotConfig {
  providers: FixtureProvider[];
  urls?: UrlsSnapshot;
  files?: Record<string, string | Buffer | null>;
  failPaths?: Record<string, number>;
}

interface Snapshot {
  files: Map<string, Buffer>;
  failPaths: Map<string, number>;
  etag: string;
}

export interface FixtureCounts {
  commits: number;
  rawFiles: number;
  byPath: Record<string, number>;
}

export function makeFixtureProvider(
  value: string,
  version: string,
  overrides: Partial<Omit<FixtureProvider, "value" | "version">> = {},
): FixtureProvider {
  return { value, version, ...overrides };
}

export function moduleSource(
  value: string,
  version: string,
  moduleName: FixtureModuleName,
): string {
  const header = `// @vega-provider ${value}\n// @vega-version ${version}\n`;
  const quoted = JSON.stringify(value);
  switch (moduleName) {
    case "posts":
      return `${header}async function getSearchPosts(args) {\n  return [{ title: ${quoted} + " " + (args.searchQuery || ""), link: "https://fixture.test/" + ${quoted} + "/post" }];\n}\nmodule.exports = { getSearchPosts };\n`;
    case "meta":
      return `${header}async function getMeta() {\n  return { title: ${quoted}, imdbId: "tt0111161", linkList: [] };\n}\nmodule.exports = { getMeta };\n`;
    case "stream":
      return `${header}async function getStream() {\n  return [{ server: ${quoted}, link: "https://fixture.test/" + ${quoted} + "/stream", type: "direct" }];\n}\nmodule.exports = { getStream };\n`;
    case "episodes":
      return `${header}async function getEpisodes() {\n  return [];\n}\nmodule.exports = { getEpisodes };\n`;
    case "settings":
      return `${header}async function getSettingsSchema() {\n  return [\n    { key: ${quoted} + "_skipTimings", defaultValue: true },\n    { key: ${quoted} + "_quality", defaultValue: "auto" },\n  ];\n}\nmodule.exports = { getSettingsSchema };\n`;
  }
}

function buildFiles(config: SnapshotConfig): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const manifest: UpstreamManifest = config.providers.map((provider) => {
    const entry: UpstreamManifest[number] = {
      display_name: provider.displayName ?? provider.value,
      value: provider.value,
      version: provider.version,
      disabled: provider.disabled ?? false,
    };
    const settings = provider.modules?.settings;
    if (settings !== undefined && settings !== null) entry.hasSettings = true;
    else if (provider.optional) entry.hasSettings = true;
    return entry;
  });
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)));
  const urls = config.urls ?? { fixture: { url: "https://fixture.test" } };
  files.set("urls.json", Buffer.from(JSON.stringify(urls, null, 2)));

  for (const provider of config.providers) {
    for (const name of ["posts", "meta", "stream"] as const) {
      const override = provider.modules?.[name];
      if (override === null) continue;
      files.set(
        `dist/${provider.value}/${name}.js`,
        Buffer.from(override ?? moduleSource(provider.value, provider.version, name)),
      );
    }
    for (const name of ["episodes", "settings"] as const) {
      const override = provider.modules?.[name];
      if (override === null) continue;
      if (override !== undefined) {
        files.set(`dist/${provider.value}/${name}.js`, Buffer.from(override));
      } else if (provider.optional) {
        files.set(
          `dist/${provider.value}/${name}.js`,
          Buffer.from(moduleSource(provider.value, provider.version, name)),
        );
      }
    }
  }

  for (const [relative, content] of Object.entries(config.files ?? {})) {
    if (content === null) files.delete(relative);
    else files.set(relative, Buffer.from(content));
  }
  return files;
}

export class UpdateFixtureServer {
  readonly repo: string;
  readonly branch: string;
  readonly apiBaseUrl: string;
  readonly rawBaseUrl: string;
  readonly counts: FixtureCounts = this.freshCounts();

  private readonly server: Server;
  private readonly snapshots = new Map<string, Snapshot>();
  private headSha: string | null = null;
  private apiStatus: number | null = null;
  private closed = false;

  private constructor(
    server: Server,
    repo: string,
    branch: string,
    port: number,
  ) {
    this.server = server;
    this.repo = repo;
    this.branch = branch;
    const base = `http://127.0.0.1:${port}`;
    this.apiBaseUrl = `${base}/api`;
    this.rawBaseUrl = `${base}/raw`;
  }

  static async start(options: { repo?: string; branch?: string } = {}): Promise<UpdateFixtureServer> {
    const repo = options.repo ?? "fixture/vega-providers";
    const branch = options.branch ?? "main";
    let instance: UpdateFixtureServer;
    const server = createServer((request, response) => {
      void instance.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    instance = new UpdateFixtureServer(server, repo, branch, address.port);
    return instance;
  }

  setHead(sha: string): void {
    this.headSha = sha;
  }

  setApiStatus(status: number | null): void {
    this.apiStatus = status;
  }

  getHead(): string | null {
    return this.headSha;
  }

  setSnapshot(sha: string, config: SnapshotConfig): void {
    const failPaths = new Map(Object.entries(config.failPaths ?? {}));
    this.snapshots.set(sha, {
      files: buildFiles(config),
      failPaths,
      etag: `"fixture-${sha}"`,
    });
  }

  setFile(sha: string, relativePath: string, content: string | Buffer | null): void {
    const snapshot = this.requireSnapshot(sha);
    if (content === null) snapshot.files.delete(relativePath);
    else snapshot.files.set(relativePath, Buffer.from(content));
  }

  setPathStatus(sha: string, relativePath: string, status: number | null): void {
    const snapshot = this.requireSnapshot(sha);
    if (status === null) snapshot.failPaths.delete(relativePath);
    else snapshot.failPaths.set(relativePath, status);
  }

  resetCounts(): void {
    this.counts.commits = 0;
    this.counts.rawFiles = 0;
    this.counts.byPath = {};
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private freshCounts(): FixtureCounts {
    return { commits: 0, rawFiles: 0, byPath: {} };
  }

  private requireSnapshot(sha: string): Snapshot {
    const snapshot = this.snapshots.get(sha);
    if (!snapshot) throw new Error(`Fixture snapshot ${sha} does not exist`);
    return snapshot;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://fixture.local");
      const pathname = decodeURIComponent(url.pathname);

      const commitPrefix = `/api/repos/${this.repo}/commits/`;
      if (pathname.startsWith(commitPrefix)) {
        this.counts.commits += 1;
        if (this.apiStatus !== null) {
          this.send(response, this.apiStatus, "fixture api failure");
          return;
        }
        const branch = pathname.slice(commitPrefix.length);
        if (branch !== this.branch || !this.headSha) {
          this.send(response, 404, "not found");
          return;
        }
        const snapshot = this.snapshots.get(this.headSha);
        if (!snapshot) {
          this.send(response, 404, "not found");
          return;
        }
        if (request.headers["if-none-match"] === snapshot.etag) {
          response.statusCode = 304;
          response.setHeader("ETag", snapshot.etag);
          response.end();
          return;
        }
        this.sendJson(response, 200, { sha: this.headSha }, snapshot.etag);
        return;
      }

      const rawPrefix = `/raw/${this.repo}/`;
      if (pathname.startsWith(rawPrefix)) {
        const rest = pathname.slice(rawPrefix.length);
        let sha: string | null = null;
        let relative: string | null = null;

        const refsPrefix = "refs/heads/";
        if (rest.startsWith(refsPrefix)) {
          const afterRefs = rest.slice(refsPrefix.length);
          const separator = afterRefs.indexOf("/");
          if (separator < 0) {
            this.send(response, 404, "not found");
            return;
          }
          const branch = afterRefs.slice(0, separator);
          if (branch !== this.branch) {
            this.send(response, 404, "not found");
            return;
          }
          sha = this.headSha;
          relative = afterRefs.slice(separator + 1);
        } else {
          const separator = rest.indexOf("/");
          if (separator < 0) {
            this.send(response, 404, "not found");
            return;
          }
          sha = rest.slice(0, separator);
          relative = rest.slice(separator + 1);
        }

        const snapshot = sha ? this.snapshots.get(sha) : undefined;
        if (!snapshot || !relative) {
          this.send(response, 404, "not found");
          return;
        }
        this.counts.rawFiles += 1;
        this.counts.byPath[relative] = (this.counts.byPath[relative] ?? 0) + 1;

        const forcedStatus = snapshot.failPaths.get(relative);
        if (forcedStatus !== undefined) {
          this.send(response, forcedStatus, "fixture failure");
          return;
        }
        const content = snapshot.files.get(relative);
        if (!content) {
          this.send(response, 404, "not found");
          return;
        }
        response.statusCode = 200;
        response.setHeader(
          "Content-Type",
          relative.endsWith(".json") ? "application/json" : "application/javascript",
        );
        response.setHeader("Content-Length", content.length);
        response.end(content);
        return;
      }

      this.send(response, 404, "not found");
    } catch (error) {
      this.send(response, 500, error instanceof Error ? error.message : "fixture error");
    }
  }

  private sendJson(
    response: ServerResponse,
    status: number,
    body: unknown,
    etag?: string,
  ): void {
    const content = Buffer.from(JSON.stringify(body));
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Content-Length", content.length);
    if (etag) response.setHeader("ETag", etag);
    response.end(content);
  }

  private send(response: ServerResponse, status: number, message: string): void {
    const content = Buffer.from(message);
    response.statusCode = status;
    response.setHeader("Content-Type", "text/plain");
    response.setHeader("Content-Length", content.length);
    response.end(content);
  }
}

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields?: Record<string, unknown>;
}

export class MemoryLogger implements LoggerLike {
  readonly entries: LogEntry[] = [];

  private push(
    level: LogEntry["level"],
    event: string,
    fields?: Record<string, unknown>,
  ): void {
    this.entries.push({ level, event, fields });
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.push("debug", event, fields);
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.push("info", event, fields);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.push("warn", event, fields);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.push("error", event, fields);
  }

  child(): LoggerLike {
    return this;
  }

  hasEvent(event: string, level?: LogEntry["level"]): boolean {
    return this.entries.some(
      (entry) => entry.event === event && (level === undefined || entry.level === level),
    );
  }
}

export class MemoryKvStore implements KVStoreApi {
  private readonly values = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async keys(): Promise<string[]> {
    return Array.from(this.values.keys());
  }

  async clear(): Promise<void> {
    this.values.clear();
  }
}

export function createFakeProviderContext(
  kvStore: KVStoreApi = new MemoryKvStore(),
): ProviderContextLike {
  return {
    axios: {} as ProviderContextLike["axios"],
    commonHeaders: {},
    cheerio: {} as ProviderContextLike["cheerio"],
    openWebView: async () => {
      throw new Error("WAF_REQUIRED");
    },
    kvStore,
    getCookies: async () => ({}),
  };
}

export function createTestConfig(
  dataDir: string,
  repo: string,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  const base = loadConfig({
    DATA_DIR: dataDir,
    PROVIDER_SOURCE: repo,
    PROVIDER_BRANCH: "main",
    LOG_LEVEL: "error",
  });
  return { ...base, ...overrides };
}

export function fakeBundle(
  value: string,
  version: string,
  settings: (() => unknown) | null,
): ProviderBundle {
  const modules: Partial<ProviderModules> = {};
  if (settings) {
    modules.settings = {
      getSettingsSchema: settings as () => unknown,
    } as ProviderModules["settings"];
  }
  return {
    entry: {
      display_name: value,
      value,
      version,
      disabled: false,
    },
    dir: `/fixture/${value}`,
    modules: modules as ProviderModules,
  };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

export async function makeTempDir(prefix = "vega-test-"): Promise<string> {
  return fs.mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/${prefix}`);
}
