import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  ProviderBundle,
  ProviderModules,
  UpstreamProviderEntry,
} from "../types.js";

export const PROVIDER_MODULES = {
  required: ["posts", "meta", "stream"] as const,
  optional: ["episodes", "settings"] as const,
};

const require = createRequire(import.meta.url);
const MAX_MODULE_BYTES = 2 * 1024 * 1024;
const HEADER_SCAN_LINES = 10;

type ModuleName = (typeof PROVIDER_MODULES.required)[number] | (typeof PROVIDER_MODULES.optional)[number];

const EXPECTED_EXPORTS: Record<ModuleName, string> = {
  posts: "getSearchPosts",
  meta: "getMeta",
  stream: "getStream",
  episodes: "getEpisodes",
  settings: "getSettingsSchema",
};

function stampValue(lines: string[], stamp: string): string | null {
  const pattern = new RegExp(`^\\s*//\\s*@${stamp}\\s+(\\S+)\\s*$`);
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function validateModuleHeader(
  content: Buffer | string,
  entry: UpstreamProviderEntry,
  moduleName: string,
): void {
  const text = typeof content === "string" ? content : content.toString("utf8");
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = withoutBom.split(/\r?\n/).slice(0, HEADER_SCAN_LINES);

  const provider = stampValue(lines, "vega-provider");
  if (provider === null) {
    throw new Error(
      `${moduleName}.js for ${entry.value} is missing the @vega-provider header`,
    );
  }
  if (provider !== entry.value) {
    throw new Error(
      `${moduleName}.js for ${entry.value} has @vega-provider ${provider}, expected ${entry.value}`,
    );
  }

  const version = stampValue(lines, "vega-version");
  if (version === null) {
    throw new Error(
      `${moduleName}.js for ${entry.value} is missing the @vega-version header`,
    );
  }
  if (version !== entry.version) {
    throw new Error(
      `${moduleName}.js for ${entry.value} has @vega-version ${version}, expected ${entry.version}`,
    );
  }
}

async function readAndValidate(
  dir: string,
  entry: UpstreamProviderEntry,
  moduleName: ModuleName,
  required: boolean,
): Promise<{ moduleName: ModuleName; filePath: string; content: Buffer } | null> {
  const filePath = path.join(dir, `${moduleName}.js`);
  let content: Buffer;
  try {
    content = await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (required) {
        throw new Error(
          `${entry.value} is missing required module ${moduleName}.js`,
        );
      }
      return null;
    }
    throw error;
  }
  if (content.length < 1 || content.length > MAX_MODULE_BYTES) {
    throw new Error(
      `${moduleName}.js for ${entry.value} has invalid size (${content.length} bytes)`,
    );
  }
  validateModuleHeader(content, entry, moduleName);
  return { moduleName, filePath, content };
}

export async function loadProviderBundle(
  entry: UpstreamProviderEntry,
  dir: string,
): Promise<ProviderBundle> {
  const resolvedDir = path.resolve(dir);
  const validated = new Map<ModuleName, string>();

  for (const moduleName of PROVIDER_MODULES.required) {
    const result = await readAndValidate(resolvedDir, entry, moduleName, true);
    if (result) validated.set(result.moduleName, result.filePath);
  }
  for (const moduleName of PROVIDER_MODULES.optional) {
    const result = await readAndValidate(resolvedDir, entry, moduleName, false);
    if (result) validated.set(result.moduleName, result.filePath);
  }

  const modules: Partial<Record<ModuleName, unknown>> = {};
  for (const [moduleName, filePath] of validated) {
    // Require is intentionally not wrapped: a top-level provider throw must fail
    // the provider install while leaving previously loaded bundles untouched.
    const exportsValue: unknown = require(filePath);
    const exportName = EXPECTED_EXPORTS[moduleName];
    if (
      !exportsValue ||
      typeof exportsValue !== "object" ||
      typeof (exportsValue as Record<string, unknown>)[exportName] !== "function"
    ) {
      throw new Error(
        `${moduleName}.js for ${entry.value} does not export ${exportName}()`,
      );
    }
    modules[moduleName] = exportsValue;
  }

  return {
    entry,
    dir: resolvedDir,
    modules: modules as unknown as ProviderModules,
  };
}

export function unloadProviderModules(rootDir: string): void {
  const root = path.resolve(rootDir);
  const cache = require.cache as Record<string, NodeModule | undefined>;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  for (const key of Object.keys(cache)) {
    if (key === root || key.startsWith(prefix)) {
      delete cache[key];
    }
  }
}
