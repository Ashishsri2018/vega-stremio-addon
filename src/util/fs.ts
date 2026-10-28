import path from "node:path";
import { promises as fs } from "node:fs";

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function fsyncDir(dir: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch {
    // Directory fsync is best effort; some filesystems reject opening dirs.
  } finally {
    await handle?.close();
  }
}

export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  const handle = await fs.open(tmpPath, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, filePath);
  await fsyncDir(dir);
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return JSON.parse(raw) as T;
}

export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
