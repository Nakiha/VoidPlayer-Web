import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../routes/context.ts";
import { sendJson } from "../http-utils.ts";
import { encryptedRequest } from "../tls.ts";
import type { AnalysisScheduler } from "./scheduler.ts";
import {
  ANALYSIS_RECIPE,
  ANALYZER_VERSION,
} from "../../src/bitstream-analysis/contract.ts";
export async function handleAnalysisRoutes(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  scheduler: AnalysisScheduler,
) {
  const media =
      /^\/api\/media\/([a-f0-9]{24})\/bitstream-analysis\/(capabilities|requests|chunks\/([a-f0-9]{64}))$/.exec(
        url.pathname,
      ),
    request = /^\/api\/bitstream-analysis\/requests\/([a-f0-9-]{36})$/.exec(
      url.pathname,
    );
  if (!media && !request) return false;
  const owner = ctx.actor?.id ?? "anonymous";
  try {
    if (req.method === "POST" || req.method === "DELETE") {
      const origin = req.headers.origin ? URL.parse(req.headers.origin) : null;
      if (
        !origin ||
        origin.host !== req.headers.host ||
        origin.protocol !== (encryptedRequest(req) ? "https:" : "http:") ||
        req.headers["x-voidplayer-action"] !== "bitstream-analysis"
      ) {
        sendJson(res, 403, { error: "Use the player to request analysis" });
        return true;
      }
    }
    if (request) {
      if (req.method === "GET") {
        const value = scheduler.status(request[1], owner);
        sendJson(
          res,
          value ? 200 : 404,
          value ?? { error: "Analysis lease expired" },
        );
      } else if (req.method === "DELETE") {
        scheduler.release(request[1], owner);
        sendJson(res, 200, { ok: true });
      } else sendJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    const version = url.searchParams.get("v");
    if (
      !version ||
      !/^[a-f0-9]{24}$/.test(version) ||
      !(await ctx.library.resolve(media![1], version))
    ) {
      sendJson(res, 409, { error: "Analysis media version changed" });
      return true;
    }
    if (media![2] === "capabilities" && req.method === "GET") {
      sendJson(res, 200, {
        schema: 1,
        analyzerVersion: ANALYZER_VERSION,
        recipe: ANALYSIS_RECIPE,
        codecs: ["h264", "hevc", "vvc"],
        containers: ["mp4"],
        limits: {
          field: "unsupported",
          layer: "unsupported",
          motion: "unsupported",
          vvc: "single-slice",
        },
        execution: "server",
        admission:
          "Declared implementation limits; each requested picture is independently validated",
      });
      return true;
    }
    if (media![3] && req.method === "GET") {
      const release = scheduler.reserveResultRead();
      if (!release) {
        sendJson(res, 429, { error: "Analysis result transport busy" });
        return true;
      }
      res.once("finish", release);
      res.once("close", release);

      const result = await scheduler.store.get(media![3]);
      if (
        !result ||
        result.picture.sourceVersion !== `${media![1]}@${version}`
      ) {
        sendJson(res, 404, { error: "Analysis chunk unavailable" });
        return true;
      }
      const bytes = Buffer.from(JSON.stringify(result));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": bytes.length,
        "cache-control": "private, no-store",
      });
      res.end(bytes);
      return true;
    }
    if (media![2] === "requests" && req.method === "POST") {
      const length = Number(req.headers["content-length"]);
      if (!Number.isSafeInteger(length) || length <= 0 || length > 4096) {
        sendJson(res, 413, { error: "Analysis request too large" });
        return true;
      }
      let body = Buffer.alloc(0);
      for await (const chunk of req) {
        if (body.length + chunk.length > 4096)
          throw new Error("Analysis request too large");
        body = Buffer.concat([body, chunk]);
      }
      const input = JSON.parse(body.toString());
      if (input.version !== version)
        throw new Error("Analysis version mismatch");
      const value = await scheduler.submit(
        media![1],
        version,
        input.target,
        owner,
      );
      sendJson(res, 202, value);
      return true;
    }
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(
      res,
      error instanceof Error && error.message.includes("queue full")
        ? 429
        : 400,
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
  return true;
}
