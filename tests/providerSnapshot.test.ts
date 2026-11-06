import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSnapshot,
  parseManifest,
  validateModuleHeader,
} from "../scripts/fetch-provider-snapshot.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function moduleSource(value: string, version: string, moduleName: string): string {
  return [
    `// @vega-provider ${value}`,
    `// @vega-version ${version}`,
    `export function get${moduleName}() { return ${JSON.stringify(moduleName)}; }`,
    "",
  ].join("\n");
}

describe("fetch-provider-snapshot", () => {
  let root: string;
  let extracted: string;
  let outDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-snapshot-test-"));
    extracted = path.join(root, "extracted");
    outDir = path.join(root, "providers", "Zenda-Cross");
    await fs.mkdir(extracted, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeRepoFile(relative: string, content: string): Promise<void> {
    const filePath = path.join(extracted, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }

  async function writeManifest(entries: unknown[]): Promise<void> {
    await writeRepoFile("manifest.json", JSON.stringify(entries));
    await writeRepoFile(
      "urls.json",
      JSON.stringify({ example: { url: "https://example.com", name: "Example" } }),
    );
  }

  async function writeProvider(
    value: string,
    version: string,
    options: { path?: string; modules?: string[] } = {},
  ): Promise<void> {
    const dir = options.path ?? value;
    for (const moduleName of options.modules ?? ["posts", "meta", "stream"]) {
      await writeRepoFile(
        `dist/${dir}/${moduleName}.js`,
        moduleSource(value, version, moduleName),
      );
    }
  }

  it("builds an on-disk snapshot and state file from an extracted repo", async () => {
    await writeManifest([
      { value: "alpha", version: "1.0.0", disabled: false },
      { value: "beta", version: "2.0.0", disabled: false, path: "tools/beta" },
      { value: "gamma", version: "3.0.0", disabled: true },
    ]);
    await writeProvider("alpha", "1.0.0", { modules: ["posts", "meta", "stream", "settings"] });
    await writeProvider("beta", "2.0.0", { path: "tools/beta" });

    const result = await buildSnapshot({ extractedRoot: extracted, sha: SHA, outDir });

    expect(result.providers).toBe(2);
    expect(result.bytes).toBeGreaterThan(0);

    const snapshotDir = path.join(outDir, SHA);
    expect(await fs.readFile(path.join(snapshotDir, "manifest.json"), "utf8")).toContain("alpha");
    expect(await fs.readFile(path.join(snapshotDir, "urls.json"), "utf8")).toContain("example");

    const alphaDir = path.join(snapshotDir, "alpha");
    expect(await fs.readFile(path.join(alphaDir, "posts.js"), "utf8")).toContain(
      "@vega-provider alpha",
    );
    expect(await fs.readFile(path.join(alphaDir, "settings.js"), "utf8")).toContain("settings");
    await expect(fs.access(path.join(alphaDir, "episodes.js"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    expect(
      await fs.readFile(path.join(snapshotDir, "beta", "stream.js"), "utf8"),
    ).toContain("@vega-provider beta");
    await expect(fs.access(path.join(snapshotDir, "gamma"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const state = JSON.parse(await fs.readFile(path.join(outDir, "state.json"), "utf8"));
    expect(state.activeSha).toBe(SHA);
    expect(state.previousSha).toBeNull();
    expect(state.providers.alpha).toMatchObject({
      sha: SHA,
      version: "1.0.0",
      status: "active",
      error: null,
    });
    expect(state.providers.beta.version).toBe("2.0.0");
    expect(state.providers.gamma).toBeUndefined();
  });

  it("rejects a provider whose module header does not match the manifest", async () => {
    await writeManifest([{ value: "alpha", version: "1.0.0", disabled: false }]);
    await writeRepoFile(
      "dist/alpha/posts.js",
      moduleSource("alpha", "0.9.0", "posts"),
    );
    await writeRepoFile("dist/alpha/meta.js", moduleSource("alpha", "1.0.0", "meta"));
    await writeRepoFile("dist/alpha/stream.js", moduleSource("alpha", "1.0.0", "stream"));

    await expect(
      buildSnapshot({ extractedRoot: extracted, sha: SHA, outDir }),
    ).rejects.toThrow(/@vega-version 0\.9\.0, expected 1\.0\.0/);
  });

  it("rejects a provider missing a required module", async () => {
    await writeManifest([{ value: "alpha", version: "1.0.0", disabled: false }]);
    await writeProvider("alpha", "1.0.0", { modules: ["posts", "meta"] });

    await expect(
      buildSnapshot({ extractedRoot: extracted, sha: SHA, outDir }),
    ).rejects.toThrow(/missing required module stream\.js/);
  });

  it("rejects unsafe snapshot shas and empty manifests", async () => {
    await writeManifest([{ value: "alpha", version: "1.0.0", disabled: true }]);
    await expect(
      buildSnapshot({ extractedRoot: extracted, sha: "../escape", outDir }),
    ).rejects.toThrow(/unsafe snapshot sha/);
    await expect(
      buildSnapshot({ extractedRoot: extracted, sha: SHA, outDir }),
    ).rejects.toThrow(/no enabled providers/);
  });

  it("parses only enabled manifest entries", () => {
    const entries = parseManifest(
      JSON.stringify([
        { value: "alpha", version: "1.0.0", disabled: false },
        { value: "beta", version: "2.0.0" },
        { value: "gamma", version: "3.0.0", disabled: true },
      ]),
    );
    expect(entries.map((entry: { value: string }) => entry.value)).toEqual(["alpha"]);
  });

  it("validates module headers like the runtime loader", () => {
    expect(() =>
      validateModuleHeader(
        moduleSource("alpha", "1.0.0", "posts"),
        { value: "alpha", version: "1.0.0" },
        "posts",
      ),
    ).not.toThrow();
    expect(() =>
      validateModuleHeader("export const x = 1;\n", { value: "alpha", version: "1.0.0" }, "posts"),
    ).toThrow(/@vega-provider/);
  });
});
