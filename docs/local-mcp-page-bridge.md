# Temporary stdio page bridge

This optional source-checkout bridge is disabled on ordinary deployments. No
persistent authorization or MCP application configuration is installed. Ordinary
HTTP scoring remains a separate service capability. The bridge-owned host has
empty media roots and temporary storage; it does not advertise durable scoring
jobs and never registers a selected File as a backend source.

From this source checkout with Node 24+ and the built frontend:

```sh
npm run build
node scripts/mcp-page-bridge.ts
```

The MCP client launches this command with stdin/stdout pipes. Open the localhost
page URL printed on stderr. This process owns that page host, with empty media
roots; it cannot attach to an arbitrary already-open player. The user selects
local files in this page, opens MCP, reviews the self-declared client (not an
authenticated identity), workspace and scopes, then explicitly connects.
Read is mandatory; view control and annotation creation are separate opt-ins.
Closing the panel is not revocation; use Revoke. No reconnect/tab following is
automatic. Reload/close loses the document credential. Bridge credentials are
random process/document-memory capabilities, never URLs, logs, browser storage,
accounts, API keys, OAuth, extensions or startup services. Same-origin code and
the local OS account are trusted; this is not isolation from hostile local
processes with access to the host/browser. Host/Origin checks and client labels
are not authentication.

Only the five explicitly listed session tools are forwarded through the page's
existing Agent/session facade. No arbitrary script, filesystem path, File/log
upload, library loader, background job command or full-tool passthrough exists.
Each call explicitly carries the current page epoch; each mutation additionally
carries an operationId. Process-lifetime receipts are bounded and never evicted
to permit a duplicate execution. Unknown/dispatched/cancelled mutations are
never automatically replayed. A repeated confirmed call returns the original
receipt/result, while different inputs under the same operationId conflict.
Cancellation/revocation is not rollback of an operation already in progress.

The MCP transport is stdio only. The page uses a separate same-origin bounded
HTTP channel on the owned page host, with document bootstrap and grant bearer
capabilities, strict Host/Origin/fetch metadata, no CORS and no framing. There is
no network MCP endpoint. The document credential is removed from the DOM by the
page adapter and never exposed in stdio responses.

Protocol checked against official sources on 2026-10-27:

- [Current 2026-07-28 stdio binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio): newline UTF-8 JSON-RPC; stdout contains only protocol; EOF closes the process.
- [Current versioning/compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning): per-request version/capability metadata, server/discover and explicit application handles.
- [Legacy 2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle): initialize then notifications/initialized; no invented shutdown RPC.

Both eras are implemented explicitly, with bounded messages, queue, deadlines,
poll/lease and receipt history. Read-only grants reject view/write tools.
The page closes its grant on context/actor/source changes; an old in-progress
operation may finish, but reconnect is disabled until it settles. Late replies
are fenced by document, grant epoch and command correlation. Backend HTTP jobs
do not depend on this page channel, and revoking it never cancels such jobs.

## Executable checks and support evidence

The independent client in `scripts/testing/mcp-client.mjs` launches the real CLI
and speaks only stdin/stdout JSON-RPC. It never imports bridge execution code.
The browser test only selects actual Files, clicks consent/revoke UI and observes
DOM/network. All Agent reads, pauses, seeks and annotations go through MCP.
Controlled real browser response gates cover late replies and an ACK delayed
after domain completion; waiting for delivery must not be mistaken for active
business work. The original optional drawing-ID contract is retained; id-less
ROI drawings must remain visible rather than be mistaken for the editing ID.

```sh
node --test test/unit/mcp-page-bridge.test.mjs \
  test/unit/agent-http.test.ts test/unit/agent-tool-contract.test.ts
node --test test/media/quality-jobs-http.test.ts
npm run build
node scripts/check-mcp-page-bridge-browser.mjs
```

For a Mac with Node 24+, installed Google Chrome and the existing Playwright
project dependency (no persistent app configuration or extension):

```sh
npm run build
MCP_BROWSER_CHANNEL=chrome node scripts/check-mcp-page-bridge-browser.mjs
```

The actual Chrome process is launched on that Mac; the real independent Node
client still owns MCP stdin/stdout. Reports and screenshots are local test
artifacts in `.run/mcp-page-bridge/`, never runtime uploads. Keep failed reports
separate from the final candidate's successful evidence.

| Host | Evidence |
| --- | --- |
| Linux / Node 24.19 / Chromium 153.0.8010.12 | Development real-MCP/browser closure verified; 38 checks including two Files/tabs, read-only denials, visible ROI, exact seek, confirmed receipt deduplication, lost writes, cancellation, delayed ACK/old command, source replacement, reload, close and live-grant EOF. |
| macOS / installed Chrome + Node | Required local verification pending; not certified by the Linux result. |
| Other browsers/platforms and native packaged MCP entry | Not certified by this source-checkout delivery. |

Node protocol tests cover both protocol eras, real EOF/oversized shutdown, exact
Host/Origin plus document credential, untrusted client declarations, fixed schemas,
bounded queue, cancellation without a later response and real 15-second dispatched
deadline. Existing no-frontend HTTP H.2648/HEVC8/HEVC10 jobs verify scoring remains
independent. Broader performance and prior negative results are unchanged.

## Calls and recovery

First perform the supported MCP lifecycle, then tools/list and get_bridge_status.
The page must explicitly grant a scope before any of the following calls. For
example, send a tools/call with name seek_review and arguments:

```json
{"epoch":"EXACT_EPOCH_FROM_STATUS","operationId":"explicit-seek-1","input":{"ptsUs":500000}}
```

For get_review_marks, input accepts limit 1..4 and an exclusive afterId; a removed
cursor requires reading again without it. This host observation does not establish trusted scoring identities or scoring
readiness. No timestamps, file names or similar frames are guessed or aligned. The only write targets are this page's existing
facade operations; annotation creation requires an already paused drawn frame.

- host-unavailable / stale epoch: reopen the owned page, review and explicitly
  reconnect. No automatic reconnect or attachment to another window.
- scope-denied: the call did not run. Change scopes only through user revocation
  and explicit consent; a client label is never permission.
- outcome-unknown: retain the exact operationId/epoch/correlation and inspect
  get_bridge_receipt plus the original page. Do not automatically replay or pick
  a new operationId. Cancellation/revocation does not roll back a started action.
- not-executed: a queued action was never dispatched. Its old receipt remains
  terminal; any new attempt needs an explicit decision, never an automatic loop.
- operation-conflict: the key already binds different input/epoch. Do not use a
  new key to bypass an unknown old action. Confirmed exact calls return the old
  result without running again.
- queue-full / receipt-budget-full: at most 8 pending calls and 64 write receipts.
  Receipts are not evicted to permit duplicate execution. A new process needs
  fresh consent; absence of a receipt after restart does not prove no old effect.
- origin-host-denied: use the exact printed loopback URL in the address bar.
  Do not disable browser/Origin protections, add a proxy or change certificate trust.
- document-credential-required / document-budget: reload for a fresh document;
  inactive document credentials expire after five minutes (8 documents maximum).
  A restored back/forward document is retired and needs a reload, not silent reuse.

The page poll is bounded to 1 second, its lease to 4 seconds and command lifetime
to 15 seconds. Messages are at most 64 KiB inbound, results 48 KiB, stdout frames
128 KiB; outbound buffering is bounded. Legacy request IDs cannot be reused in
one session and their bounded history permits 4096 requests before an explicit
restart. Large read results fail explicitly rather than truncate or upload media.
Closing the panel keeps the grant visible on the MCP indicator; Revoke is the
explicit disconnect. An executing facade operation settles before reconnect is
allowed; waiting for its delivery ACK is fenced separately from physical work.
