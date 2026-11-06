import { randomUUID } from "node:crypto";
import compression from "compression";
import express from "express";
import type {
  ErrorRequestHandler,
  Request,
  RequestHandler,
  Response,
} from "express";
import type {
  AddonRoutesDeps,
  HealthReport,
  StremioStream,
} from "../types.js";
import { createProxyHandler } from "../proxy/server.js";
import { createProxyToken } from "../proxy/sign.js";
import { renderConfigurePage } from "./configure.js";
import { getManifest } from "./manifest.js";
import { parseStreamId } from "./parseId.js";
import { RateLimiter } from "./rateLimit.js";
import { filterStreams, parseUserConfig } from "./userConfig.js";

const SLOW_REQUEST_MS = 2000;
const RATE_LIMIT_RETRY_AFTER_SECONDS = 30;

function healthFallback(): HealthReport {
  return {
    status: "error",
    activeSha: null,
    providerCount: 0,
    providers: {},
    lastCheck: null,
    lastSuccess: null,
    nextCheck: null,
    pending: [],
    lastError: "health check failed",
  };
}

function requestIdOf(res: Response): string {
  const value = (res.locals as Record<string, unknown>).requestId;
  return typeof value === "string" ? value : "";
}

function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function acquireRelease(req: Request, res: Response, limiter: RateLimiter): (() => void) | null {
  const lease = limiter.tryAcquire(clientKey(req));
  if (!lease) return null;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    lease.release();
  };
  res.once("close", release);
  res.once("finish", release);
  return release;
}

function wrapStreamForProxy(
  stream: StremioStream,
  baseUrl: string,
  secret: string,
): StremioStream {
  const requestHeaders = stream.behaviorHints?.proxyHeaders?.request;
  if (!requestHeaders || Object.keys(requestHeaders).length === 0) return stream;

  try {
    const target = new URL(stream.url);
    if (target.protocol !== "http:" && target.protocol !== "https:") return stream;
  } catch {
    return stream;
  }

  const token = createProxyToken(stream.url, requestHeaders, secret);
  return { ...stream, url: `${baseUrl}/proxy/${token}` };
}

async function runStreamRequest(
  req: Request,
  res: Response,
  deps: AddonRoutesDeps,
  limiter: RateLimiter,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "HEAD") {
    res.status(200).end();
    return;
  }

  const requestId = requestIdOf(res);
  const startedAt = Date.now();
  let outcome: "ok" | "empty" | "invalid_id" | "error" | "client_aborted" | "rate_limited" =
    "ok";
  let request = parseStreamId(req.params.type ?? "", req.params.id ?? "");
  let streamCount = 0;

  const release = acquireRelease(req, res, limiter);
  if (!release) {
    outcome = "rate_limited";
    deps.logger.debug("pipeline.request_summary", {
      requestId,
      outcome,
      durationMs: Date.now() - startedAt,
    });
    res.setHeader("Retry-After", String(RATE_LIMIT_RETRY_AFTER_SECONDS));
    res.status(200).json({ streams: [] });
    return;
  }

  const userConfig = parseUserConfig(req.params.config);

  if (!request) {
    outcome = "invalid_id";
    res.status(200).json({ streams: [] });
  } else {
    const pipelineRequest =
      userConfig.providers.length > 0 || userConfig.disabledProviders.length > 0
        ? {
            ...request,
            providers: userConfig.providers,
            disabledProviders: userConfig.disabledProviders,
          }
        : request;

    const controller = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", onClose);

    let streams: StremioStream[] = [];
    try {
      const result = await deps.pipeline.handle(pipelineRequest, controller.signal);
      streams = Array.isArray(result) ? result : [];
    } catch (error) {
      outcome = "error";
      deps.logger.error("stream_request_failed", {
        requestId,
        type: request.type,
        imdbId: request.imdbId,
        season: request.season,
        episode: request.episode,
        reason: error instanceof Error ? error.name : "unknown",
      });
      streams = [];
    } finally {
      res.off("close", onClose);
    }

    if (controller.signal.aborted && !res.writableEnded) outcome = "client_aborted";

    streams = filterStreams(streams, userConfig);
    streamCount = streams.length;

    if (!res.writableEnded && !res.destroyed) {
      const secret =
        deps.config.proxyEnabled && deps.config.proxySecret
          ? deps.config.proxySecret
          : null;
      if (secret && streams.length > 0) {
        const baseUrl = (
          deps.config.publicBaseUrl ??
          `${req.protocol}://${req.get("host") ?? "localhost"}`
        ).replace(/\/+$/, "");
        streams = streams.map((stream) => wrapStreamForProxy(stream, baseUrl, secret));
      }

      res.status(200).json({ streams });
      if (outcome === "ok" && streams.length === 0) outcome = "empty";
    }
  }

  release();

  const durationMs = Date.now() - startedAt;
  const fields = {
    requestId,
    type: request?.type ?? null,
    imdbId: request?.imdbId ?? null,
    season: request?.season ?? null,
    episode: request?.episode ?? null,
    streamCount,
    durationMs,
    outcome,
  };
  if (outcome === "error" || durationMs >= SLOW_REQUEST_MS) {
    deps.logger.info("pipeline.request_summary", fields);
  } else {
    deps.logger.debug("pipeline.request_summary", fields);
  }
}

function createStreamHandler(
  deps: AddonRoutesDeps,
  limiter: RateLimiter,
): RequestHandler {
  return (req, res): void => {
    void runStreamRequest(req, res, deps, limiter);
  };
}

export function createApp(deps: AddonRoutesDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.use((req, res, next) => {
    const incoming = req.get("x-request-id");
    const requestId =
      incoming && /^[A-Za-z0-9._-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    next();
  });

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges, X-Request-Id",
    );
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) => {
        if (req.path.startsWith("/proxy/")) return false;
        return compression.filter(req, res);
      },
    }),
  );

  const serveManifest: RequestHandler = (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(getManifest());
  };
  app.get("/manifest.json", serveManifest);
  app.get("/:config/manifest.json", serveManifest);

  const serveConfigure: RequestHandler = (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res
      .type("html")
      .send(renderConfigurePage({ configuredKeys: deps.settingsKeys?.() ?? [] }));
  };
  app.get("/configure", serveConfigure);
  app.get("/:config/configure", serveConfigure);

  const streamLimiter = new RateLimiter({
    perMinute: deps.config.streamRateLimitPerMin,
    globalPerMinute: deps.config.streamGlobalRateLimitPerMin,
    maxConcurrent: deps.config.streamMaxConcurrent,
  });
  const streamHandler = createStreamHandler(deps, streamLimiter);
  for (const prefix of ["", "/:config"]) {
    app.get(`${prefix}/stream/:type/:id.json`, streamHandler);
    app.get(`${prefix}/stream/:type/:id`, streamHandler);
  }

  if (deps.config.proxyEnabled && deps.config.proxySecret) {
    const proxyHandler = createProxyHandler({
      secret: deps.config.proxySecret,
      logger: deps.logger,
    });
    const proxyLimiter = new RateLimiter({
      perMinute: deps.config.proxyRateLimitPerMin,
      globalPerMinute: deps.config.proxyGlobalRateLimitPerMin,
      maxConcurrent: deps.config.proxyMaxConcurrent,
    });
    app.all("/proxy/:token", (req, res, next) => {
      const release = acquireRelease(req, res, proxyLimiter);
      if (!release) {
        deps.logger.debug("proxy_rate_limited", {
          requestId: requestIdOf(res),
        });
        res.setHeader("Retry-After", String(RATE_LIMIT_RETRY_AFTER_SECONDS));
        res.status(429).type("text/plain").send("Too many requests");
        return;
      }
      proxyHandler(req, res, next);
    });
  }

  app.get("/health", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    let report: HealthReport;
    try {
      report = deps.health();
    } catch (error) {
      deps.logger.error("health_check_failed", {
        reason: error instanceof Error ? error.name : "unknown",
      });
      report = healthFallback();
    }
    const metrics = deps.pipeline.getMetrics?.();
    if (metrics) report = { ...report, pipeline: metrics };
    res.status(200).json(report);
  });

  app.use((req, res) => {
    res.status(404).json({ error: "not found" });
  });

  const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    deps.logger.error("request_failed", {
      requestId: requestIdOf(res),
      reason: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ error: "internal error" });
  };
  app.use(errorHandler);

  return app;
}
