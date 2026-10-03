# Ugoira WebP memory-pressure investigation

## Purpose

This note preserves the evidence and working theory from a production browser lockup so the investigation can continue across multiple sessions without relying on chat history.

It intentionally omits account names, tab titles, artwork IDs, and Pixiv URLs. The useful evidence is the conversion shape: frame dimensions, frame counts, allocation sizes, concurrency, process state, and conversion stage.

## Current goal

Make Ugoira conversion memory-bounded enough that a few large animations cannot push a Chromium renderer into swap thrash or the container memory limit.

The immediate PR goals are:

1. Stop WebP from materialising a second complete raw-RGBA frame set before encoding starts.
2. Apply explicit backpressure: hand one raw frame to the worker, wait for acknowledgement, then read the next frame.
3. Temporarily serialize WebP conversions even when the general Ugoira conversion setting allows more concurrency.
4. Add an inactivity timeout that terminates a stuck WebP worker and releases its conversion slot.
5. Preserve enough stage/frame/dimension metadata on WebP failures to diagnose future incidents without a debugger attached.
6. Keep a clear path toward a more general memory-admission/budget system for WebP/GIF/APNG.

## Incident shape

Chromium was running inside a memory-limited container. The normal configured limit was approximately 12 GiB RAM plus a 14 GiB RAM+swap ceiling. During diagnosis the limit was temporarily raised to create headroom, then restored after recovery.

One renderer became the dominant consumer. Its `/proc/<pid>/smaps_rollup` showed approximately:

- RSS: 5.11 GB decimal / about 4.87 GiB
- PSS: essentially identical to RSS
- `Private_Dirty`: essentially the entire RSS
- `Anonymous`: essentially the entire RSS
- file-backed PSS: zero
- shared memory: negligible
- swap: small at the first snapshot

This ruled out filesystem cache, mapped downloads, shared Chromium libraries, and shared-memory accounting. The memory belonged almost entirely to private anonymous allocations in one renderer.

## Allocation fingerprint

The renderer contained three dominant families of page-sized anonymous mappings. Their sizes matched raw 32-bit RGBA frames from three concurrently converting Ugoira works.

### Work A

- actual decoded frame size: 720 x 1080
- source frame count: 150
- raw bytes per frame: `720 * 1080 * 4 = 3,110,400`
- raw size per frame: 3037.5 KiB
- observed allocation size after page rounding: about 3040 KiB
- one complete raw set: about 444.95 MiB
- two complete raw sets: about 889.89 MiB
- observed mapping count at the main freeze point: approximately 301 mappings of this size

`301` is consistent with two 150-frame pixel sets plus a canvas-sized allocation.

### Work B

- actual decoded frame size: 1350 x 1080
- source frame count: 144
- raw bytes per frame: `1350 * 1080 * 4 = 5,832,000`
- raw size per frame: 5695.3125 KiB
- observed allocation size after page rounding: about 5696 KiB
- one complete raw set: about 800.90 MiB
- two complete raw sets: about 1601.81 MiB
- observed mapping count after the controlled probe: 288 mappings of this size

`288` is exactly two 144-frame sets.

### Work C

- actual decoded frame size: 1920 x 1080
- source frame count: 150
- raw bytes per frame: `1920 * 1080 * 4 = 8,294,400`
- raw size per frame: exactly 8100 KiB
- one complete raw set: about 1186.52 MiB
- two complete raw sets: about 2373.05 MiB
- observed mapping families after the controlled probe: 150 x about 8100 KiB and 150 x about 8104 KiB

These are effectively two complete 150-frame raw pixel sets.

Together the three works explain almost all of the runaway renderer RSS. This is much stronger evidence than a generic "Chromium leak" hypothesis because both the mapping sizes and mapping counts match the real Ugoira frame geometry.

## Controlled freeze/thaw experiment

The affected renderer was frozen with `SIGSTOP` to preserve the failure state.

At the initial freeze, Work C had one complete 150-frame family and only about 96 frames in the second 1920x1080-sized family.

A deliberately bounded resume was then performed:

- renderer resumed for roughly 0.75 seconds
- an independent timer forced `SIGSTOP` again
- renderer RSS increased by roughly 1.5 GB during that sub-second interval
- the incomplete 1920x1080 allocation family advanced from about 96 frames to 150 frames
- no new DedicatedWorker appeared during that interval

This is direct behavioral evidence that the renderer was actively running a full-frame pixel-copy loop when frozen. The size of each new mapping matched one 1920x1080 RGBA frame.

The renderer did not become responsive enough during the short thaw to return page-level diagnostics. The memory delta itself was more useful than the attempted diagnostic call.

## Establishing the conversion stage

The source format and converted-file download history were compared for the three matching works.

For all three works:

- source ZIP output had completed
- `.ugoira` output had completed
- WebP output had **not** completed
- later formats had not started for those works

Other nearby, smaller Ugoira jobs had successfully produced WebP and then proceeded to WebM/GIF/APNG.

The downloader processes formats sequentially for each work in this order:

1. ZIP
2. Ugoira
3. WebP
4. WebM
5. GIF
6. APNG

Therefore the three large jobs were all in the WebP conversion stage when the renderer exhausted memory.

This corrected the initial APNG suspicion. APNG remains memory-heavy and deserves separate hardening, but it was not the immediate stage responsible for this incident.

## Concurrency evidence

The browser configuration allowed three Ugoira conversions concurrently (`convertUgoiraThread = 3`).

The renderer contained exactly three large raw-frame allocation cohorts corresponding to three different Ugoira works. This matches the configured conversion concurrency.

DedicatedWorker creation times also aligned with the start of the large conversion wave. Worker presence alone is not enough to map every worker to a specific work, but it is consistent with the WebP worker architecture and the conversion timeline.

An older long-lived worker was consistent with the reusable APNG worker introduced by earlier diagnostics work; it was not necessary to explain the three large WebP raw-frame cohorts.

## Why the old WebP architecture peaks so high

Before this PR, `PPDWebP.encode()` did the following:

1. `ConvertUgoira` decoded every ZIP frame to an `ImageBitmap`.
2. The full `ImageBitmap[]` was cached so subsequent output formats could reuse the decode.
3. WebP created a canvas and called `getImageData()` for **every bitmap**.
4. Every `getImageData()` result was retained in `rgbaList`.
5. Only after the entire second frame set existed did the code create the WebP worker.
6. The whole `rgbaList` was transferred to that DedicatedWorker.
7. The worker retained the complete list while encoding frames one by one.
8. The original `ImageBitmap[]` remained cached in the same renderer for later formats.

Using a transfer list avoids copying an `ArrayBuffer` between JavaScript realms, but it does **not** make the memory leave the Chromium renderer process when the target is a DedicatedWorker in that renderer. Ownership moves; RSS does not.

With three large conversions active, the process therefore held approximately:

- one complete decoded bitmap set per work; plus
- one complete raw RGBA set per work; plus
- canvas/encoder/compressed-frame working memory.

The incident's mapping geometry is exactly what this architecture predicts.

## Old WebP liveness gap

The previous WebP helper had no inactivity timeout and no per-frame progress protocol.

A worker that stopped making progress could retain its transferred RGBA list indefinitely. Because the outer conversion slot remained occupied, retry/recovery behavior could make the situation difficult to distinguish from a generic browser hang.

APNG already had significantly better diagnostics: worker start/progress stages, request IDs, timeouts, frame progress and structured failure information. WebP lacked equivalent observability.

## Changes in this PR

### One-frame-at-a-time WebP handoff

The WebP protocol is changed from one message containing `rgbaList[]` to an acknowledged stream:

1. main thread sends `start` metadata
2. main thread draws one `ImageBitmap`
3. main thread calls `getImageData()` for that one frame
4. that frame's `ArrayBuffer` is transferred to the worker
5. worker reconstructs the frame, copies it to its OffscreenCanvas and encodes it
6. worker sends `frame-complete`
7. only then does the main thread read the next bitmap
8. after all frames are acknowledged, main thread sends `finish`
9. worker assembles the animated WebP and returns the result

This deliberately trades some throughput for a bounded raw-pixel working set.

The original decoded `ImageBitmap[]` is still retained because later formats currently reuse it. The important change is that WebP no longer creates a second complete raw RGBA set beside it.

### Explicit backpressure

The main thread will not call `getImageData()` for frame N+1 until the worker acknowledges frame N. This is the core memory-safety property and has a dedicated unit test.

### Conservative WebP serialization

Even though `convertUgoiraThread` may be greater than one, this PR initially allows only one WebP conversion to enter its pixel-materialization/encoding path at a time.

This is intentionally conservative. Once real-world measurements show the streaming protocol has a safe and predictable peak, the dedicated WebP limit can be revisited or replaced with a byte-based admission budget.

### Worker inactivity timeout

WebP now has a worker inactivity timeout. Progress or frame acknowledgements reset the timer. A timeout terminates the dedicated worker, rejects the conversion and releases the conversion slot.

A stuck worker should no longer retain a raw frame or compressed-frame state indefinitely.

### Failure context

WebP errors now carry small scalar diagnostics on `error.ppdWebP`, including:

- stage
- current frame index
- total frame count
- width / height
- raw bytes per frame
- timeout
- elapsed time

No image pixels, ZIP data, account identity, tab title or page URL are retained in this diagnostic object.

## Tests added

The PR adds tests for these properties:

1. only one frame is read/transferred before worker acknowledgement
2. the next frame is not materialised until the previous frame completes
3. all frames eventually produce a final `finish` message and result
4. inactivity timeout terminates the worker
5. timeout errors contain frame geometry/memory context
6. coordinator-level WebP serialization holds even when general conversion concurrency is configured above one

## Acceptance criteria before considering the incident fixed

At minimum:

- a 150-frame 1920x1080 Ugoira must not produce a second 150-frame 8100-KiB allocation family in the page renderer
- three concurrent Ugoira jobs must not create three simultaneous full WebP raw-frame sets
- a stalled WebP worker must terminate and release its slot after bounded inactivity
- failed WebP conversion logs must identify stage/frame geometry without requiring DevTools to respond
- existing WebP output must remain decodable and preserve frame timing
- normal ZIP/Ugoira/WebM/GIF/APNG behavior must remain unchanged
- the browser must recover from a failed large WebP conversion without restarting the entire container

## Validation still needed

The unit tests prove protocol/backpressure behavior but do not prove browser-level peak RSS.

A follow-up browser smoke should measure:

- renderer RSS before decode
- RSS after bitmap cache creation
- RSS during each WebP frame acknowledgement
- peak RSS during final WebP assembly
- RSS after WebP completion and after bitmap-cache cleanup
- behavior with `convertUgoiraThread` set above one
- timeout/retry behavior with a deliberately stalled worker

Synthetic large-frame tests are preferable to relying on a particular live work.

## Production smoke findings after the initial WebP fix

The streaming WebP protocol fixed the original whole-animation RGBA duplication pattern and produced fresh WebP outputs successfully in repeated production-like smokes. High-frequency instrumentation then exposed a broader admission-control problem.

The smoke environment used the normal 12 GiB Chromium container with `memory.swap.max=0`, one-second cgroup sampling, structured conversion-stage telemetry, and an automatic 95% memory guardrail. With WebP limited to one slot and GIF/APNG sharing one heavy slot:

- a 150-frame 1920x1080 WebP completed successfully without the original runaway allocation signature
- a later run still reached 99.99% of the container limit during a single large APNG conversion
- a fully autonomous run subsequently crossed the 95% guardrail while a 150-frame 1920x1080 WebM was still active and a 144-frame 1350x1080 WebP had just started
- the guardrail paused the downloader without OOM-killing Chromium; no conversion-stage failure was reported before the pause

This changes the containment conclusion. The remaining production risk is not specific to WebP or APNG: different full-frame conversion formats may overlap while decoded/cached frame sets from several works are still resident. A format-specific slot cannot express the actual renderer memory budget.

As an immediate conservative containment, all WebM/WebP/GIF/APNG conversions now share one full-frame conversion slot. This intentionally trades throughput for a deterministic upper bound on cross-format overlap. A future byte-aware admission controller can recover safe concurrency once peak-memory accounting is understood well enough.

A subsequent autonomous smoke proved that serialization alone is not sufficient for the largest GIF case. With only one heavy conversion active, a 150-frame 1920x1080 GIF still drove the 12 GiB no-swap container to 99.30% before the 95% guardrail paused the downloader. `gif.js` retains the copied `ImageData` for every frame until `render()`, while the downloader was also retaining the full decoded `ImageBitmap[]`. That recreates two full frame sets inside one conversion even without cross-work overlap.

GIF and APNG now take ownership of their decoded bitmap list when they begin full-RGBA materialisation. The coordinator evicts that work from the bitmap cache, and each encoder closes an `ImageBitmap` immediately after copying its pixels. If APNG follows GIF, it deliberately re-decodes the ZIP rather than reusing closed bitmaps. This trades decode time for roughly one full raw-frame set of peak-memory headroom and keeps retry/cache semantics explicit.

A further smoke then crossed the 95% guardrail during the next 1920x1080 WebP before GIF began. The encoder itself was serialized, but the coordinator still retained completed works' decoded bitmap caches for ten seconds so another format of the same work could reuse them. With several download tasks interleaving their format sequences, those delayed caches overlapped the next work's decode and defeated the single-heavy-slot bound.

The conservative production path therefore no longer retains decoded Ugoira frames across formats at all. Every completed conversion immediately closes/deletes its bitmap cache; the next format for that work re-decodes from the source ZIP. The download loop processes a work's formats sequentially, so this changes throughput rather than output ordering or correctness. It also makes the heavy-slot memory invariant much easier to reason about: one encoder plus one work's decoded frame set, rather than one encoder plus an unbounded tail of recently completed caches.

That change allowed the 150-frame 1920x1080 WebP to complete below the guardrail, but the following WebM still reached 95.28% with no other heavy conversion active. The remaining WebM peak came from `Tools.extractImage()` decoding the entire animation with `Promise.all()` before transferring the complete `ImageBitmap[]` to the Whammy worker. Serialization cannot bound that single-job decoded-frame set.

WebM therefore now uses the same backpressure principle as WebP, but one step earlier in the pipeline: the source ZIP is indexed once, one JPEG frame is sliced and decoded to an `ImageBitmap`, that bitmap is transferred to the Whammy worker, and the next frame is not decoded until the worker acknowledges `frame-complete`. The worker keeps only its compressed WebP frame representation inside Whammy, closes each transferred bitmap after encoding, and compiles the WebM only after an explicit `finish` message. Cancellation and inactivity timeout paths clean up the worker job. The legacy whole-list path remains only as the Worker/OffscreenCanvas fallback.

## Remaining risks and open questions

### Compressed-frame accumulation

The worker still retains encoded WebP chunks for all completed frames until final RIFF assembly. These should be much smaller than raw RGBA but can still become material for unusually incompressible animations. If needed, RIFF assembly may need a chunked output strategy later.

### Original ImageBitmap cache

`ConvertUgoira` intentionally caches every decoded bitmap so several output formats can reuse the decode. For large works, one decoded set alone can exceed 1 GiB.

Possible later approaches:

- byte-aware cache admission instead of count-only conversion concurrency
- release/redecode between expensive formats
- choose format order based on ownership semantics
- transfer bitmaps to a worker once no later format needs them
- make the conversion pipeline own frame decoding instead of caching the whole work

### Cross-format conversion overlap

GIF and APNG call `getImageData()` across full animations, WebM can own a complete decoded frame set while its worker encodes, and WebP still has a substantial decoded/encoded working set even after raw-frame streaming. Production smoke data showed that overlapping different formats can saturate the renderer without any individual encoder failing.

The shared full-frame slot is therefore an intentional safety constraint, not just a WebP workaround. APNG diagnostics remain useful for distinguishing encoder-internal pressure from cross-format overlap.

### Retry amplification

Conversion failures are retried later by the downloader. Any path that fails without releasing bitmaps/workers/slots can amplify memory pressure on retries. Every failure and timeout path should be checked for deterministic cleanup.

### General memory admission

A fixed conversion-thread count is a poor proxy for memory demand. Three tiny animations are cheap; one 150-frame 1920x1080 animation is not.

A future admission controller could estimate at least:

`width * height * 4 * frameCount`

and gate expensive conversions by an estimated byte budget rather than job count alone.

The estimate must account for the fact that the decoded bitmap cache is already resident and that each encoder has different additional working-set characteristics.

## Operational recovery notes

During the incident, freezing the single runaway renderer preserved enough state to inspect its mappings and metadata. Killing only that renderer later reclaimed several GiB without immediately killing the rest of Chromium.

After diagnosis, the browser was eventually restarted cleanly and the temporary higher container memory limit was returned to the normal configured value.

For a future recurrence, if diagnostics are needed before recovery:

1. identify the largest Chromium renderer
2. capture `cmdline` and `smaps_rollup`
3. capture anonymous mapping-size histogram
4. capture active conversion/download stages if the browser still responds
5. freeze the suspect renderer only if preserving the fault is worth disrupting that tab
6. avoid repeated thaws: a sub-second thaw in this incident allocated roughly 1.5 GB
7. after evidence capture, kill the renderer or restart Chromium before swap exhaustion destabilizes the whole container

## Confidence level

High confidence that the immediate incident was WebP conversion memory amplification rather than a generic Chromium leak:

- raw allocation sizes matched actual frame dimensions exactly
- allocation counts matched actual frame counts / duplicate frame sets
- three cohorts matched the configured three conversion slots
- a bounded thaw visibly completed the missing second RGBA set
- source ZIP/Ugoira outputs had completed while WebP outputs had not
- the old WebP implementation explicitly constructed and retained the exact duplicate raw-frame structure observed in memory

The remaining work is not to identify the basic failure mode; it is to prove the new streaming/backpressure implementation preserves output correctness and keeps peak RSS acceptably bounded in real Chromium workloads.
