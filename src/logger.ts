import type { LoggerLike, LogLevel } from "./types.js";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY = /token|secret|password|cookie|authorization|api[-_]?key|debrid/i;

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.search) url.search = "?redacted";
    return url.toString();
  } catch {
    return value;
  }
}

export function redactValue(key: string, value: unknown, depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === "string") {
    return /^https?:\/\//i.test(value) ? redactUrl(value) : value;
  }
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (Array.isArray(value)) {
    return depth > 4 ? "[array]" : value.map((item) => redactValue(key, item, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth > 4) return "[object]";
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = redactValue(childKey, childValue, depth + 1);
    }
    return result;
  }
  return value;
}

export interface LoggerOptions {
  level?: LogLevel;
  write?: (line: string, level: LogLevel) => void;
}

export class Logger implements LoggerLike {
  readonly level: LogLevel;
  private readonly fields: Record<string, unknown>;
  private readonly write: (line: string, level: LogLevel) => void;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.fields = {};
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  }

  private withFields(fields: Record<string, unknown>): Logger {
    const child = new Logger({ level: this.level, write: this.write });
    Object.assign(child.fields, this.fields, fields);
    return child;
  }

  child(fields: Record<string, unknown>): Logger {
    return this.withFields(fields);
  }

  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.level];
  }

  private log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    if (!this.isLevelEnabled(level)) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(redactValue("entry", this.fields) as Record<string, unknown>),
    };
    if (fields) Object.assign(entry, redactValue("entry", fields) as Record<string, unknown>);
    this.write(JSON.stringify(entry), level);
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.log("debug", event, fields);
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.log("error", event, fields);
  }
}

export function createLogger(level: LogLevel = "info"): Logger {
  return new Logger({ level });
}
