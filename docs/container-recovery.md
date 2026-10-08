# Container corruption and terminal indexes

Index finality and source integrity are separate. `indexState: complete` means
there is no more indexing work; `indexIntegrity` describes the retained data:

| Integrity | Timeline |
| --- | --- |
| `complete` | No structural loss was reported by this container's indexer. This is not an exhaustive bitstream or pixel audit. |
| `recovered` | Valid material was retained after safely skipping damaged or extraneous data. |
| `prefix` | Recovery stopped. Duration and seeking end at the retained prefix. |

Both damaged states carry `indexWarning`. A prefix also carries
`indexTruncatedAt`, the start of discarded data. Playback reaches a normal
terminal boundary rather than turning a late data error into a failed track.
Analysis keeps the warning and cannot report full-file coverage from a prefix.
Read progress describes work performed, not proof of valid media coverage.

## Format adapters

- FLV uses the shared bounded scanner on the client and server. After a gap,
  dependent pictures are discarded until a verified closed random access point.
  Exhausting recovery budgets terminates with the previously validated prefix.
- MPEG-TS, PS, Matroska/WebM and AVI share the FFmpeg core's demux-only scanner.
  Recognized invalid data, a TS resynchronization failure, or a corrupt video
  packet may finish a prefix. The last GOP is discarded, and all retained PTS
  and DTS must be known with a monotonic decode order. When no complete GOP can
  be confirmed, the error remains fatal. Recovery does not guess a new segment
  from an arbitrary container key flag. Already-published decoder-backed
  progressive scans retain their hard-error contract rather than retracting
  published records. The Web local and server paths use demux-only scans.
- MP4's packet adapter tolerates invalid trailing bytes only after finding a
  complete `moov` and `mdat`, then validating every referenced sample against
  its declared media extent. Structural boxes and nested tables remain strict.
  A truncated `mdat` keeps complete samples from full preceding GOPs; it drops
  the final potentially dependent GOP. Fragmented and unsupported MP4 shapes
  remain on the shared FFmpeg adapter.

Input/IO failures, premature EOF from a short range response, changed resource
versions, cancellation, unsupported codec/configuration and resource limits
remain failures. No blanket catch converts them into a cacheable damaged file.
Damage unreported by the demuxer can still fail decoding; this policy cannot
reconstruct missing frames or guarantee arbitrary corrupted payloads are valid.

## Cache and transport

The additive core recovery ABI is version 1; packet records remain ABI v3,
48 bytes, with the same original ordinal identities. Prefix metadata preserves
`indexEndDts` in the stream's original time base. The decoder drains at that
decode boundary and never submits the discarded GOP. Both streamed and legacy
cache imports apply this boundary; invalid bounds or timestamps are rejected.

The server persists final integrity metadata with its completed manifest and
publishes that manifest before `complete`, including on a cold request that
already received the building manifest. A warm reopen preserves the same
boundary and duration. The exact core commit is pinned in
`scripts/release-core.json`; the new build identity separates old cache entries.
Deploy frontend, server and both core variants together.

## Verification

The core's `test-corrupt-prefix.mjs` compares every retained MPEG-2 B picture
against undamaged pixels, then exports/imports the index and checks backwards
and terminal seeks. It also verifies that premature IO EOF stays fatal. Core
CI runs this for single and MT variants, plus existing 70-second seek tests.

Web regressions cover TS with MPEG-2/H.264/HEVC, FLV gap/IDR recovery,
Matroska/WebM/AVI/PS appended tails, MP4 appended garbage and truncated B-frame
recordings, recovery cache rejection and cold/warm server import identity.
These tests establish behavior for their fixtures, not universal codec damage
recovery. Existing browser/container playback checks remain required in CI.
