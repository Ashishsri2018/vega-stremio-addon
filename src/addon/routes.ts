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
import { nativeFetch } from "../util/nativeFetch.js";
import { createProxyHandler } from "../proxy/server.js";
import { createProxyToken } from "../proxy/sign.js";
import { renderConfigurePage } from "./configure.js";
import { getManifest } from "./manifest.js";
import { parseStreamId } from "./parseId.js";
import { filterStreams, parseUserConfig } from "./userConfig.js";

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
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "HEAD") {
    res.status(200).end();
    return;
  }

  const request = parseStreamId(req.params.type ?? "", req.params.id ?? "");
  if (!request) {
    res.status(200).json({ streams: [] });
    return;
  }

  const controller = new AbortController();
  const onClose = (): void => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", onClose);

  let streams: StremioStream[] = [];
  try {
    const result = await deps.pipeline.handle(request, controller.signal);
    streams = Array.isArray(result) ? result : [];
  } catch (error) {
    deps.logger.error("stream_request_failed", {
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

  if (res.writableEnded || res.destroyed) return;

  streams = filterStreams(streams, parseUserConfig(req.params.config));

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
}

function createStreamHandler(deps: AddonRoutesDeps): RequestHandler {
  return (req, res): void => {
    void runStreamRequest(req, res, deps);
  };
}

export function createApp(deps: AddonRoutesDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges",
    );
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  const serveManifest: RequestHandler = (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(getManifest());
  };
  app.get("/manifest.json", serveManifest);
  app.get("/:config/manifest.json", serveManifest);

  const serveConfigure: RequestHandler = (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("html").send(renderConfigurePage());
  };
  app.get("/configure", serveConfigure);
  app.get("/:config/configure", serveConfigure);

  const streamHandler = createStreamHandler(deps);
  for (const prefix of ["", "/:config"]) {
    app.get(`${prefix}/stream/:type/:id.json`, streamHandler);
    app.get(`${prefix}/stream/:type/:id`, streamHandler);
  }

  if (deps.config.proxyEnabled && deps.config.proxySecret) {
    const proxyHandler = createProxyHandler({
      secret: deps.config.proxySecret,
      logger: deps.logger,
      fetchImpl: nativeFetch,
    });
    app.all("/proxy/:token", proxyHandler);
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
      reason: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ error: "internal error" });
  };
  app.use(errorHandler);

  return app;
}
