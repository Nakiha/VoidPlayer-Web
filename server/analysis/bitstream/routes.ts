import { isProduct, encodeProduct, PRODUCT_SCHEMA } from '../../../shared/analysis/bitstream/products.ts';
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../../routes/context.ts";
import { sendJson } from "../../http-utils.ts";
import { encryptedRequest } from "../../tls.ts";
import type { AnalysisScheduler } from "./scheduler.ts";
import {
  AnalysisFailure,
  failureInfo,
} from "../../../shared/analysis/bitstream/failure.ts";
import {
  ANALYSIS_RECIPE,
  ANALYZER_VERSION,
} from "../../../shared/analysis/bitstream/contract.ts";
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
        const after = url.searchParams.get('after');
        if (after !== null && !/^(0|[1-9][0-9]{0,6})$/.test(after))
          throw new AnalysisFailure('invalid-request', 'Invalid stream cursor');
        const value = after === null ? scheduler.status(request[1], owner) : await scheduler.streamStatus(request[1], owner, Number(after));
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
      sendJson(res, 409, {
        error: "Analysis media version changed",
        reason: new AnalysisFailure(
          "source-changed",
          "Analysis media version changed",
        ).info,
      });
      return true;
    }
    if (media![2] === "capabilities" && req.method === "GET") {
      sendJson(res, 200, {
        buildId:await scheduler.buildIdentity(),
        productSchema:PRODUCT_SCHEMA,
        products:{stream:["legacy","summary","blocks"],picture:["legacy","blocks"],range:["legacy"]},
        encodings:["summary-json-v1","blocks-le12-v1"],
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
      const controller = new AbortController();
      const abort = () => controller.abort(new AnalysisFailure('cancelled', 'Analysis result consumer disconnected'));
      res.once('close', abort);
      let release: () => void;
      try { release = await scheduler.waitForResultRead(controller.signal); }
      finally { res.off('close', abort); }
      if (res.destroyed) { release(); return true; }
      let producing=true,responseDone=false;
      const ended=()=>{responseDone=true;if(!producing)release();};
      res.once("finish",ended);res.once("close",ended);
      try {
      const auText=url.searchParams.get('au');
      if (auText !== null && !/^(0|[1-9][0-9]{0,6})$/.test(auText)) throw new AnalysisFailure('invalid-request','Invalid analysis member');
      const result = await scheduler.store.getOutput(media![3],auText === null ? undefined : Number(auText));
      if (
        !result ||
        result.picture.sourceVersion !== `${media![1]}@${version}`
      ) {
        sendJson(res, 404, { error: "Analysis chunk unavailable" });
        return true;
      }
      const bytes = isProduct(result) ? await encodeProduct(result) : Buffer.from(JSON.stringify(result));
      res.writeHead(200, {
        "content-type": isProduct(result) ? "application/vnd.voidplayer.analysis-v1" : "application/json",
        "content-length": bytes.length,
        "cache-control": "private, no-store",
      });
      res.end(bytes);
      return true;
      } finally {producing=false;if(responseDone||res.destroyed)release();}
    }
    if (media![2] === "requests" && req.method === "POST") {
      const length = Number(req.headers["content-length"]);
      if (!Number.isSafeInteger(length) || length <= 0 || length > 4096) {
        sendJson(res, 413, {
          error: "Analysis request too large",
          reason: new AnalysisFailure(
            "resource-limit",
            "Analysis request too large",
          ).info,
        });
        return true;
      }
      let body = Buffer.alloc(0);
      for await (const chunk of req) {
        if (body.length + chunk.length > 4096)
          throw new AnalysisFailure(
            "resource-limit",
            "Analysis request too large",
          );
        body = Buffer.concat([body, chunk]);
      }
      let input;
      try {
        input = JSON.parse(body.toString());
      } catch {
        throw new AnalysisFailure("invalid-request", "Invalid analysis JSON");
      }
      if (input.version !== version)
        throw new AnalysisFailure(
          "source-changed",
          "Analysis version mismatch",
        );
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
    const reason = failureInfo(error);
    sendJson(
      res,
      reason.kind === "limited"
        ? 429
        : reason.code === "source-changed"
          ? 409
          : reason.code === "internal-error"
            ? 500
            : 400,
      {
        error: error instanceof Error ? error.message : String(error),
        reason,
      },
    );
  }
  return true;
}
