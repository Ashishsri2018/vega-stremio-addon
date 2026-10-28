import path from "node:path";
import type {
  LoggerLike,
  ProviderInstallStatus,
  ProviderStateEntry,
  UpdateState,
} from "../types.js";
import { readJsonFile, writeJsonAtomic } from "../util/fs.js";

const STATE_FILE = "state.json";

export function providerRootDir(dataDir: string, repo: string): string {
  const owner = repo.split("/")[0]?.trim();
  if (!owner) {
    throw new Error("Provider source must be in owner/repo form");
  }
  return path.join(dataDir, "providers", owner);
}

export function emptyState(): UpdateState {
  return {
    activeSha: null,
    previousSha: null,
    headEtag: null,
    lastCheck: null,
    lastSuccess: null,
    nextCheck: null,
    lastError: null,
    providers: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNullableString(
  value: Record<string, unknown>,
  key: keyof UpdateState,
): string | null {
  const field = value[key];
  if (field === undefined || field === null) return null;
  if (typeof field !== "string") {
    throw new Error(`state.${key} must be a string or null`);
  }
  return field;
}

function parseProviderEntry(value: unknown): ProviderStateEntry {
  if (!isRecord(value)) {
    throw new Error("state provider entry must be an object");
  }
  if (typeof value.sha !== "string" || value.sha.length === 0) {
    throw new Error("state provider sha must be a string");
  }
  if (typeof value.version !== "string") {
    throw new Error("state provider version must be a string");
  }
  if (typeof value.installedAt !== "string") {
    throw new Error("state provider installedAt must be a string");
  }
  const status = value.status;
  if (status !== "active" && status !== "pending") {
    throw new Error("state provider status must be active or pending");
  }
  if (value.error !== undefined && value.error !== null && typeof value.error !== "string") {
    throw new Error("state provider error must be a string or null");
  }
  return {
    sha: value.sha,
    version: value.version,
    installedAt: value.installedAt,
    status: status as ProviderInstallStatus,
    error: value.error ?? null,
  };
}

function parseState(value: unknown): UpdateState {
  if (!isRecord(value)) throw new Error("state file must contain an object");
  const state = emptyState();
  state.activeSha = readNullableString(value, "activeSha");
  state.previousSha = readNullableString(value, "previousSha");
  state.headEtag = readNullableString(value, "headEtag");
  state.lastCheck = readNullableString(value, "lastCheck");
  state.lastSuccess = readNullableString(value, "lastSuccess");
  state.nextCheck = readNullableString(value, "nextCheck");
  state.lastError = readNullableString(value, "lastError");

  if (value.providers !== undefined) {
    if (!isRecord(value.providers)) {
      throw new Error("state.providers must be an object");
    }
    for (const [key, entry] of Object.entries(value.providers)) {
      state.providers[key] = parseProviderEntry(entry);
    }
  }
  return state;
}

export class StateStore {
  private readonly providerRoot: string;
  private readonly logger: LoggerLike;
  private readonly filePath: string;
  private state: UpdateState = emptyState();

  constructor(options: { providerRoot: string; logger: LoggerLike }) {
    this.providerRoot = options.providerRoot;
    this.logger = options.logger;
    this.filePath = path.join(this.providerRoot, STATE_FILE);
  }

  get(): UpdateState {
    return this.state;
  }

  async load(): Promise<UpdateState> {
    let raw: unknown;
    try {
      raw = await readJsonFile<unknown>(this.filePath);
    } catch (error) {
      this.logger.error("state_load_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.state = emptyState();
      return this.state;
    }
    if (raw === null) {
      this.state = emptyState();
      return this.state;
    }
    try {
      this.state = parseState(raw);
    } catch (error) {
      this.logger.error("state_parse_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.state = emptyState();
    }
    return this.state;
  }

  async save(state: UpdateState): Promise<void> {
    await writeJsonAtomic(this.filePath, state);
    this.state = state;
  }

  async update(mutator: (draft: UpdateState) => void): Promise<UpdateState> {
    const draft = structuredClone(this.state);
    mutator(draft);
    await this.save(draft);
    return draft;
  }
}
