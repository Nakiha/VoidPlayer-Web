# Local analysis Worker lifecycle

Picture requests and range/whole-stream requests each own a disposable browser Worker, one terminal promise, an abort listener and an execution/stall timer. They share the analysis cache through their existing service root but do not share Worker instances, playback readers or decoded frames.

| Terminal cause | Owned cleanup / result |
| --- | --- |
| Success | Clear timer, abort listener and three Worker event properties; terminate once; resolve unchanged result |
| `error` / `messageerror` | Same cleanup; reject and expose analysis error; playback remains independent |
| Initial `postMessage` throws | Clean up before rejecting, including the Worker/timer that promise-executor rejection alone previously left behind |
| Snapshot/index provider throws or reply send rejects | Same terminal path, including asynchronous callback send errors; no unhandled rejection |
| Cache reply / chunk ACK send throws | Existing terminal failure policy retained; a validated chunk is consumed before its one ACK; accepted cache records are not rolled back |
| Cancellation / execution or stall timeout | Existing cancelled/resource-limit classification and 30-second limits; terminate once and release listeners |
| Late callback or pending reverse result | Ignore after settlement; do not query a released source or post to the old Worker; later requests own their independent state |

Snapshot/index providers retain their invocation timing; promise chains now observe both provider rejection and send failure. Message layouts, Blob inputs, per-chunk ACK order, progress handling and timer renewal policy are unchanged. No copied payloads, new transfer list, Node adapter or shared transport framework are introduced. Node metadata/decoder Worker cleanup is covered by separate clients/PRs.

`node-bitstream-analysis` adds 30 controlled browser-like transport cases through the public service API, using valid synthetic result/stream metadata and an explicitly opaque snapshot fixture. The old client fails all 30 lifecycle cases; the fixed client passes these plus the existing bitstream/Session cases (131 test cases total) under strict unhandled-rejection handling. Fake Workers do not claim actual demux or corrupted-browser-payload acceptance; real codec/container and stream checks remain in the existing media/browser suites.
