# Compare completed XPSNR versions

Open **Technical selection and comparison → Native XPSNR**, select two to four
completed jobs, then choose **Compare selected versions**. Each version must
already have its own explicit reference relation, correspondence plan and completed
XPSNR result. Comparing only reads existing results and candidates; the player is
independent. The raw comparison JSON is kept in a secondary disclosure.

The existing service domain must match exactly: pinned reference source/version/
cache/producer, presentation sequence, reference raw hash, component and recipe.
The caller-declared reference relationship is not content certification. No
perceptual superiority or overall quality score is implied.

The first table shows official pooled Y/U/V and minimum from each native result.
Choose caller order or descending Y/U/V/minimum; ties retain caller order.
Positive infinity is `∞`. Frame dB values are never averaged to reconstruct a pool.
Stored source names identify versions; expandable identities show source ID/version,
original job, attempt and digest.

The frame table reads four common reference presentation positions at a time,
showing index, reference decode-order AU/PTS and each distorted AU/PTS, XPSNR
planes/minimum, companion PSNR and requested SSIM. Reordered AUs are not sorted.
There is no nearest-time join. Unrequested SSIM says **Not requested**; missing
requested facts reject the page.

**Inspect original job** leaves comparison context intact. Candidate receipts and
annotations are checked against the same job/attempt/digest/frame reference before
showing existing original-frame links. The independent shared viewer has a pinned
return link; it does not use another actor's private job to display pixels. No
candidate is created if none exists.

## Restore and refusal

Only identities, domain key, page and sort are saved under the current actor's
local preference key. No scores, pixels or credentials are saved. Refresh/reopen/
reload and viewer return re-read the comparison, owned completed jobs, attempt,
digest, domain and exact companion frame/source witnesses. Missing/reclaimed or
changed facts clear all displayed scores and refuse the view. The old selection
is retained; clearing and selecting new results must be explicit. Newer results
are never substituted. Actor switches and pane closure invalidate late responses;
closing observation does not cancel jobs. Actors remain self-declared identities,
not strong authentication.

The existing `GET /api/quality/xpsnr/compare?ids=ID1,ID2` is still frontend-independent.
Its additive `gui` relative location carries pinned identities only. Opening it
requires the current actor's own successful reads and grants no authorization.

## Validation

```sh
node --test test/unit/xpsnr-comparison.test.ts
node scripts/native/run-xpsnr-tests.mjs node --test test/media/native-xpsnr-http.test.ts
npm run build
node scripts/native/run-xpsnr-tests.mjs node scripts/check-xpsnr-comparison-browser.mjs chromium
node scripts/native/run-xpsnr-tests.mjs node scripts/check-xpsnr-comparison-browser.mjs webkit
```

Fixed public four-version fixtures cover mixed FLV/MP4, infinity, optional SSIM,
paging/reload, job/evidence return, late actor responses and independent playback.
Controlled responses exercise client missing-frame/domain refusal; real HTTP tests
also exercise backend domain mismatch and actual result reclamation. Existing
format, color, sequence and native platform limits remain. This GUI adds neither
subjective blind-test evidence nor performance certification.
