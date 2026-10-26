# Native VMAF sequence work package (#122, work in progress)

This branch implements one complete Linux x64 server workflow, not an advertised
placeholder. Until the real HTTP/GUI/compiled tests pass, capability stays unavailable.

The source is official Netflix/vmaf v3.0.0, revision
`17a67b238ce0539bdeafdc95961abac64fa16ea8`. The explicit models are v0.6.1 SDR
and optional v0.6.1 NEG, with SHA256 in `scripts/native/vmaf.lock.json`; v0.6.1 is
not called the newest model. Current official `models_v0.md` describes that family;
at this fixed revision its authoritative document is `resource/doc/models.md`.
The HDTV model describes 1080p/3H viewing conditions; no implicit rescale, phone,
4K/HDR model, transformation, score enhancement option or Gaussian pooling is added.

Build source and install tools are separate from runtime PATH. Build the official
CLI and the small Linux resource/lifetime supervisor, retain BSD-2-Clause-Patent
and LIBSVM notices, and produce a manifest recording actual binary hashes, model
hashes, compiler, source and build options. Service configuration must explicitly
pin the installed directory and manifest digest. HTTP never selects an executable,
model path, command line or environment. Other platforms are component-unavailable.

The frozen C plan is the only mapping input; VMAF does not redo alignment. Admission
must establish all samples/no holes, unique presentation order, verified continuous
CFR clocks, same full unrotated/uncropped square-pixel geometry, limited BT.709 SDR
8/10-bit planar YUV420, and no stride, negative PTS or unverified VFR. No nearest
matching, silent conversion, container expansion or content authentication.

A single owned execution slot covers bounded WASM raw decode and native sequence
execution. Raw files, retained frames, index/input/pre-roll/post-target/drain work,
temporary disk, stdout/stderr/result, native threads/CPU/address space and elapsed
budget are charged. Native CLI reads the entire ordered sequence once and flushes
its temporal features at the defined clip boundary; per-frame runs averaged later
are not VMAF. Joint PSNR/SSIM and VMAF retain separate outcomes. Cancellation stops
native processes and drains file IO/Workers before releasing the slot; restart
retains history as interrupted, never automatically recomputes. A full-frame VMAF
score is never a heatmap or a spatially calibrated defect box.

Planned acceptance: actual installation/capability, committed C→VMAF HTTP/GUI and
compiled Bun positive path, fixed official recipe frame/pool comparisons on real
8/10-bit same/distorted temporal clips, invalid component/model/source/clock/color
negatives, lost responses, cancellation/timeout/process crash/restart and resource
measurements. Existing playback/performance failures remain negative evidence.
