/** Embedded so the standalone server also serves the guide without dist/. */
export const AGENT_GUIDE = `# VoidPlayer Web

> Search a configured video library and download original media using ordinary HTTP requests. No browser automation or MCP connection is needed for these read operations.

Resolve all paths below against the server origin where you fetched this file.
HTTP and HTTPS both serve these APIs, including the optional companion HTTP port.
Only the remote player page requires HTTPS for browser decoding APIs.
Media listing and downloads do not currently require a user cookie. A deployment
may add authentication at its reverse proxy. Only indexed media in configured
roots is available; this is not an arbitrary filesystem or non-media file server.

## Find media

- [Search all folders](/api/library/browse?recursive=1&limit=100&offset=0): GET JSON; add a URL-encoded search parameter for a case-insensitive substring of the relative filename/path.
- [Browse folders](/api/library/browse): GET JSON; optional root (root ID), directory (relative path), recursive=1, search, limit (1–200, default 100), offset (default 0), revision.
- [Scan status](/api/library/scan): GET JSON; ready, scanning and root errors explain an empty or incomplete listing. While scanning, retry after a short delay rather than starting another scan.
- [Legacy listing](/api/library): GET JSON; limited to 5000 entries. Use browse for pagination; truncated=true means this list is incomplete.

Search example: GET /api/library/browse?search=example.mp4&recursive=1&limit=100&offset=0
The response includes entries, total, nextOffset, revision, ready and scanning.
Each entry includes id, name (relative path), root, rootId, size (bytes),
lastModified (Unix milliseconds), version and state. IDs and versions are opaque;
copy them from the response rather than constructing them from filenames.
Prefer entries with state=ready; other states may describe unavailable files.
Confirm the filename and root when several results match.

Follow nextOffset until null, retaining the same filters and adding the first
page's revision to subsequent requests. On HTTP 409, discard accumulated pages
and restart at offset=0 without revision because the library changed.
For folder browsing, directories and moreDirectories describe the folder page.

## Download original bytes

Construct /api/media/ID?v=VERSION&download=1 using an entry's id and version.
GET returns the original file, not a transcode or preview. download=1 supplies
Content-Disposition with the filename. Save to the user-requested destination;
stream large responses to disk instead of keeping the whole file in memory.

HEAD on the same URL returns Content-Length, Content-Type, ETag and
Accept-Ranges: bytes without downloading the body. A normal GET returns HTTP 200.
For partial reads, send Range: bytes=0-1048575 (inclusive byte offsets); expect
HTTP 206 and Content-Range. Single ranges and suffix ranges are supported,
not multipart ranges. For resume, keep the same version and append only after
checking HTTP 206 and the returned starting offset. Never append a full 200
response to a partial file.

The optional v parameter pins the observed file version. Keep it for downloads
and resumed reads to avoid mixing different versions of a changing recording.
The ETag/version is a file-change identifier, not a content checksum.

## Errors and scope

- 400: invalid query parameters; correct the request.
- 404: unknown, removed or unavailable media; search again.
- 409 on media: file changed; fetch a fresh entry and restart the download.
- 416: unsatisfiable Range; inspect Content-Range and HEAD before retrying.
- TLS trust errors: use the deployment's trusted certificate configuration.

This guide covers read-only media retrieval. It does not expose playback control
over HTTP MCP: the player's WebMCP tools belong to its browser session. Searching
and downloading do not require changing settings, triggering scans, uploading
logs, or clearing server caches.
`;
