# Temporary stdio page bridge

Work in progress: implementation checkpoint, not yet an accepted browser or
macOS delivery. No persistent authorization or MCP application configuration
is installed. Ordinary HTTP scoring remains a separate service capability.

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

Targeted protocol, security/lifecycle and real-browser tests, operation discovery,
and macOS Chrome/Node validation are still pending at this checkpoint.
