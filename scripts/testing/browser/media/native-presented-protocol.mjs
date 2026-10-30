import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { cleanupResources } from "../../lifecycle.mjs";
import { demuxFlv } from "../../../../shared/media/containers/flv-demux.ts";
const tag = (body, dts) => {
  const h = Buffer.alloc(11);
  h[0] = 9;
  h.writeUIntBE(body.length, 1, 3);
  h.writeUIntBE(dts & 0xffffff, 4, 3);
  h[7] = dts >>> 24;
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(body.length + 11);
  return Buffer.concat([h, body, tail]);
};
export async function checkNativePresentedProtocol(browser, fixtures, engine) {
  const vite = await createServer({
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "native-presented-test",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__native_presented__") return next();
            res.setHeader("content-type", "text/html");
            res.end(
              "<!doctype html><body>Native presented identity test</body>",
            );
          });
        },
      },
    ],
  });
  const reports = [];
  let context, failure;
  try {
    await vite.listen();
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
    // One controlled page owns the matrix. Each probe creates and closes its own
    // decoder, source frames and presenter; no case needs another browser context.
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(base + "/__native_presented__");
    for (const s of fixtures.samples) {
      const input = Buffer.from(s.flv, "base64"),
        index = await demuxFlv({
          size: input.length,
          read: async (o, n) => input.subarray(o, o + n),
        });
      for (const variant of [
        "original",
        "negative",
        "drain",
        "duplicate-clock",
        "multiple-pictures",
      ]) {
        const head = (type, key, cts) =>
          s.codec === "hevc"
            ? Buffer.concat([
                Buffer.from([(key ? 0x90 : 0xa0) | type]),
                Buffer.from("hvc1"),
                ...(type === 1 ? [cts] : []),
              ])
            : Buffer.concat([Buffer.from([key ? 0x17 : 0x27, type]), cts]);
        const tags = [
            tag(
              Buffer.concat([
                head(0, true, Buffer.alloc(3)),
                index.description,
              ]),
              0,
            ),
          ],
          packets = index.packets.slice(
            0,
            ["drain", "duplicate-clock", "multiple-pictures"].includes(variant)
              ? 2
              : undefined,
          );
        if (variant === "multiple-pictures") {
          const p = packets[0],
            cts = Buffer.alloc(3);
          cts.writeUIntBE(((p.pts - p.dts) / 1000) & 0xffffff, 0, 3);
          tags.push(
            tag(
              Buffer.concat([
                head(1, true, cts),
                ...packets.map((p) =>
                  input.subarray(p.offset, p.offset + p.size),
                ),
              ]),
              p.dts / 1000,
            ),
          );
        } else
          for (const p of packets) {
            const cts = Buffer.alloc(3),
              clock =
                variant === "drain"
                  ? 0
                  : variant === "duplicate-clock"
                    ? (index.packets[0].pts - p.dts) / 1000
                    : (p.pts - p.dts) / 1000 -
                      (variant === "negative" ? 2000 : 0);
            cts.writeUIntBE(clock & 0xffffff, 0, 3);
            tags.push(
              tag(
                Buffer.concat([
                  head(1, p.key, cts),
                  input.subarray(p.offset, p.offset + p.size),
                ]),
                p.dts / 1000,
              ),
            );
          }
        const flv = Buffer.concat([
          Buffer.from("464c5601010000000900000000", "hex"),
          ...tags,
        ]);
        assert.equal(
          await page.locator("canvas").count(),
          0,
          "previous probe released its presentation canvas",
        );
        {
          let result;
          try {
            result = await page.evaluate(
              async ({ encoded, barcode }) => {
                const { probe } = await import(
                  "/scripts/testing/browser/media/native-presented-probe.ts"
                );
                return probe(encoded, barcode);
              },
              { encoded: flv.toString("base64"), barcode: s.barcode },
            );
          } catch (error) {
            assert.ok(
              variant === "multiple-pictures" &&
                /EncodingError/.test(String(error)),
              String(error),
            );
            reports.push({
              codec: s.codec,
              depth: s.depth,
              variant,
              state: "decoder-rejected",
            });
            continue;
          }
          if (result.unsupported) {
            assert.ok(
              engine === "chromium" && s.codec === "hevc",
              "required native H264/WebKit HEVC must execute",
            );
            reports.push({
              codec: s.codec,
              depth: s.depth,
              variant,
              state: "platform-native-unavailable",
            });
            continue;
          }
          if (["duplicate-clock", "multiple-pictures"].includes(variant))
            assert.ok(
              result.rows.every((r) => r.identity === null),
              "ambiguous real output cannot acquire an identity",
            );
          else {
            assert.equal(result.rows.length, packets.length);
            for (const row of result.rows) {
              assert.ok(row.identity);
              assert.ok(row.commit > 0);
              assert.equal(
                row.code,
                s.barcode.displayCodes[
                  s.displayAuOrder.indexOf(row.identity.au)
                ],
              );
              if (variant === "negative") assert.ok(row.identity.pts < 0);
            }
            if (variant === "drain")
              assert.ok(result.rows.every((r) => r.phase === "drain"));
          }
          reports.push({
            codec: s.codec,
            depth: s.depth,
            variant,
            state: "passed",
            outputs: result.rows.length,
            drain: result.rows.filter((r) => r.phase === "drain").length,
          });
        }
      }
    }
    const field = fixtures.field;
    assert.ok(field?.interlacedSps);
    assert.equal(
      createHash("sha256")
        .update(Buffer.from(field.flv, "base64"))
        .digest("hex"),
      field.sha256,
    );
    assert.equal(
      await page.locator("canvas").count(),
      0,
      "previous probe released its presentation canvas",
    );
    {
      const result = await page.evaluate(
        async ({ encoded, barcode }) => {
          const { probe } = await import(
            "/scripts/testing/browser/media/native-presented-probe.ts"
          );
          return probe(encoded, barcode);
        },
        { encoded: field.flv, barcode: fixtures.samples[0].barcode },
      );
      assert.ok(
        result.unsupported || result.rows.every((r) => r.identity === null),
      );
      reports.push({
        codec: "h264",
        variant: "actual-interlaced-sps",
        state: "identity-rejected",
      });
    }
    assert.equal(
      await page.locator("canvas").count(),
      0,
      "final probe released its presentation canvas",
    );
    return reports;
  } catch (error) {
    failure = { error };
  } finally {
    await cleanupResources(
      [
        ["native protocol context", () => context?.close()],
        ["native protocol server", () => vite.close()],
      ],
      failure,
    );
  }
}
