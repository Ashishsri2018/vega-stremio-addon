#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const REQUIRED_MODULES = ["posts", "meta", "stream"];
const OPTIONAL_MODULES = ["episodes", "settings"];
const MAX_MODULE_BYTES = 2 * 1024 * 1024;
const HEADER_SCAN_LINES = 10;
const SAFE_SHA = /^[A-Za-z0-9][A-Za-z0-9_.-]{6,79}$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeSegment(segment) {
  return /^[A-Za-z0-9_.-]+$/.test(segment) && segment !== "." && segment !== "..";
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function stampValue(lines, stamp) {
  const pattern = new RegExp(`^\\s*//\\s*@${stamp}\\s+(\\S+)\\s*$`);
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function validateModuleHeader(text, entry, moduleName) {
  const lines = stripBom(text).split(/\r?\n/).slice(0, HEADER_SCAN_LINES);
  const provider = stampValue(lines, "vega-provider");
  if (provider !== entry.value) {
    throw new Error(
      `${moduleName}.js for ${entry.value} has @vega-provider ${provider ?? "(missing)"}, expected ${entry.value}`,
    );
  }
  const version = stampValue(lines, "vega-version");
  if (version !== entry.version) {
    throw new Error(
      `${moduleName}.js for ${entry.value} has @vega-version ${version ?? "(missing)"}, expected ${entry.version}`,
    );
  }
}

export function parseManifest(text) {
  let parsed;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("manifest.json must contain an array");

  const entries = [];
  const seen = new Set();
  for (const raw of parsed) {
    if (!isRecord(raw)) throw new Error("manifest.json contains a non-object entry");
    if (raw.disabled !== false) continue;
    if (typeof raw.value !== "string" || !/^[A-Za-z0-9_.-]+$/.test(raw.value)) {
      throw new Error("manifest.json contains an enabled provider with an invalid value");
    }
    if (typeof raw.version !== "string" || raw.version.length === 0) {
      throw new Error(`manifest.json entry ${raw.value} has an invalid version`);
    }
    if (seen.has(raw.value)) {
      throw new Error(`manifest.json contains duplicate provider ${raw.value}`);
    }
    if (raw.path !== undefined && (typeof raw.path !== "string" || raw.path.length === 0)) {
      throw new Error(`manifest.json entry ${raw.value} has an invalid path`);
    }
    seen.add(raw.value);
    entries.push(raw);
  }
  if (entries.length === 0) throw new Error("manifest.json has no enabled providers");
  return entries;
}

export function parseUrls(text) {
  let parsed;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch {
    throw new Error("urls.json is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("urls.json must contain an object");
  for (const [key, value] of Object.entries(parsed)) {
    if (!isRecord(value) || typeof value.url !== "string" || value.url.length === 0) {
      throw new Error(`urls.json entry ${key} is invalid`);
    }
  }
  return parsed;
}

function providerSourceDir(entry) {
  const value = entry.path?.trim() || entry.value;
  const segments = value.split("/");
  if (segments.length === 0 || !segments.every(isSafeSegment)) {
    throw new Error(`Invalid provider path for ${entry.value}`);
  }
  return segments.join("/");
}

async function copyModule(sourceFile, destinationFile, entry, moduleName, required) {
  let content;
  try {
    content = await fs.readFile(sourceFile);
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return 0;
    if (error?.code === "ENOENT") {
      throw new Error(`${entry.value} is missing required module ${moduleName}.js`);
    }
    throw error;
  }
  if (content.length < 1 || content.length > MAX_MODULE_BYTES) {
    throw new Error(`${moduleName}.js for ${entry.value} has invalid size (${content.length} bytes)`);
  }
  validateModuleHeader(content.toString("utf8"), entry, moduleName);
  await fs.writeFile(destinationFile, content);
  return content.length;
}

export async function buildSnapshot({ extractedRoot, sha, outDir }) {
  if (!SAFE_SHA.test(sha)) throw new Error(`Refusing unsafe snapshot sha: ${sha}`);

  const [manifestText, urlsText] = await Promise.all([
    fs.readFile(path.join(extractedRoot, "manifest.json"), "utf8"),
    fs.readFile(path.join(extractedRoot, "urls.json"), "utf8"),
  ]);
  const entries = parseManifest(manifestText);
  parseUrls(urlsText);

  const snapshotDir = path.join(outDir, sha);
  await fs.mkdir(snapshotDir, { recursive: true });
  await fs.writeFile(path.join(snapshotDir, "manifest.json"), manifestText);
  await fs.writeFile(path.join(snapshotDir, "urls.json"), urlsText);

  let bytes = 0;
  const providers = {};
  for (const entry of entries) {
    const sourceDir = providerSourceDir(entry);
    const destinationDir = path.join(snapshotDir, entry.value);
    await fs.mkdir(destinationDir, { recursive: true });
    for (const moduleName of REQUIRED_MODULES) {
      bytes += await copyModule(
        path.join(extractedRoot, "dist", ...sourceDir.split("/"), `${moduleName}.js`),
        path.join(destinationDir, `${moduleName}.js`),
        entry,
        moduleName,
        true,
      );
    }
    for (const moduleName of OPTIONAL_MODULES) {
      bytes += await copyModule(
        path.join(extractedRoot, "dist", ...sourceDir.split("/"), `${moduleName}.js`),
        path.join(destinationDir, `${moduleName}.js`),
        entry,
        moduleName,
        false,
      );
    }
    providers[entry.value] = {
      sha,
      version: entry.version,
      installedAt: new Date().toISOString(),
      status: "active",
      error: null,
    };
  }

  const now = new Date().toISOString();
  const state = {
    activeSha: sha,
    previousSha: null,
    headEtag: null,
    lastCheck: now,
    lastSuccess: now,
    // Past due on purpose: a freshly seeded container refreshes in the
    // background as soon as the updater starts, without blocking the listener.
    nextCheck: now,
    lastError: null,
    providers,
  };
  await fs.writeFile(path.join(outDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);

  return { sha, providers: entries.length, bytes };
}

async function extractTarball(source, sha, destination) {
  const url = `https://codeload.github.com/${source}/tar.gz/${sha}`;
  const response = await fetch(url, {
    headers: { "user-agent": "vega-stremio-addon-baseline" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  }

  const child = spawn("tar", ["-xzf", "-", "-C", destination], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}`));
    });
  });
  try {
    await pipeline(Readable.fromWeb(response.body), child.stdin);
    await exited;
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

async function findExtractedRoot(directory) {
  const names = await fs.readdir(directory);
  const directories = [];
  for (const name of names) {
    const stat = await fs.stat(path.join(directory, name));
    if (stat.isDirectory()) directories.push(name);
  }
  if (directories.length !== 1) {
    throw new Error(`expected exactly one directory in the tarball, found ${directories.length}`);
  }
  return path.join(directory, directories[0]);
}

function parseArgs(argv) {
  const options = { source: "Zenda-Cross/vega-providers", sha: "", out: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--sha") options.sha = value ?? "";
    else if (arg === "--source") options.source = value ?? "";
    else if (arg === "--out") options.out = value ?? "";
    else throw new Error(`unknown argument: ${arg}`);
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.out) throw new Error("--out is required");

  await fs.mkdir(options.out, { recursive: true });
  if (!options.sha) {
    console.log("PROVIDER_SHA is not set; image will start without a baseline snapshot");
    return;
  }
  if (!SAFE_SHA.test(options.sha)) throw new Error(`Refusing unsafe snapshot sha: ${options.sha}`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.source)) {
    throw new Error(`Invalid provider source: ${options.source}`);
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "vega-providers-"));
  try {
    const extracted = path.join(workDir, "extracted");
    await fs.mkdir(extracted, { recursive: true });
    console.log(`downloading ${options.source}@${options.sha}`);
    await extractTarball(options.source, options.sha, extracted);
    const root = await findExtractedRoot(extracted);
    const result = await buildSnapshot({ extractedRoot: root, sha: options.sha, outDir: options.out });
    console.log(
      `wrote baseline snapshot ${result.sha} with ${result.providers} providers (${result.bytes} bytes) to ${options.out}`,
    );
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error(`fetch-provider-snapshot: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
