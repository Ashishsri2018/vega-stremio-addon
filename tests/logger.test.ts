import { describe, expect, it } from "vitest";
import { Logger, redactValue } from "../src/logger.js";

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = new Logger({
    level: "debug",
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe("Logger", () => {
  it("emits JSON lines with bound fields", () => {
    const { logger, lines } = capture();
    const child = logger.child({ component: "test" }) as Logger;
    child.info("hello", { answer: 42 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", event: "hello", component: "test", answer: 42 });
    expect(typeof lines[0]?.ts).toBe("string");
  });

  it("filters by level", () => {
    const lines: Array<Record<string, unknown>> = [];
    const quiet = new Logger({
      level: "warn",
      write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    quiet.debug("nope");
    quiet.info("nope");
    quiet.warn("yes");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("warn");
  });

  it("redacts sensitive fields and query strings", () => {
    const { logger, lines } = capture();
    logger.info("test", {
      apiKey: "abc",
      cookie: "session=1",
      url: "https://example.com/file?token=secret&x=1",
      nested: { debridApiKey: "k" },
    });
    const line = lines[0]!;
    expect(line.apiKey).toBe("[redacted]");
    expect(line.cookie).toBe("[redacted]");
    expect(String(line.url)).toContain("redacted");
    expect((line.nested as Record<string, unknown>).debridApiKey).toBe("[redacted]");
  });

  it("redactValue handles errors and buffers", () => {
    expect(redactValue("error", new Error("boom"))).toEqual({ name: "Error", message: "boom" });
    expect(redactValue("buffer", Buffer.alloc(3))).toBe("[buffer 3 bytes]");
  });
});
