# Diagnostics hardening and PR #3 triage — 29 October 2026

## Scope and disposition

This is a source candidate, **not deployed**. Baseline reviewed: `824256f9`.
The active EU reverse walk, its settings, downloads and checkpoint are unchanged.
Both requested skip controls remain ON; the hourly continuation task stays disabled.

The initial parallel development attempt exhausted resources on the small jump
box. Its incomplete run is not validation evidence. Parent validation was rerun
serially with `NODE_OPTIONS=--max-old-space-size=512` and `--test-concurrency=1`.

| Existing PR #3 finding | Current-source evidence | Disposition |
| --- | --- | --- |
| Competing following listener swallows worker reply | `ManageFollowing` used an async outer listener for unrelated `msg` objects | Fixed in candidate: synchronous exact-name routing; 4 tests cover delayed diagnostic reply, null/malformed payloads and native following reservation/set/reset |
| Diagnostic snapshots/retention unbounded by bytes | Full controller arrays/task map and report count alone did not constrain serialized size | Fixed in candidate: sampled details plus totals, bounded deep copy, per-report/collection/retention byte budgets and bounded persistence backlog |
| Captured timeline copied by reference | Page snapshot's task spread retained live nested timeline references | Fixed in candidate: bounded deep copy before worker await; mutation-during-await regression |
| Global worker task IDs collide between tabs | Active map used only `taskBatch:index:sequence` | Fixed in candidate: worker map key includes tab ID; equal IDs in different tabs survive independent completion |
| Conversion failure task never finishes | `Download.ts` conversion-error cancellation returns after conversion-complete without terminal finish | Confirmed static path remains; defer to PPBD-03 with a native conversion-error regression |
| Skip diagnostics finished before advancement | `Download.skipDownload` finishes before `EVT.fire('skipDownload')` | Confirmed static path remains; need controller acknowledgement/error regression before changing lifecycle |
| Worker task finishes before result delivery | `background.ts` finishes at browser-complete/error or simulated completion before sendMessage promise settles | Confirmed static path remains; test pending/rejected delivery, then retain task through handoff |
| Error completion precedes retry/skip | `DownloadControl` calls finish in download_err before USER_CANCELED advance or delayed retry | Confirmed static path remains; test actual advancement failure and retry acknowledgement |
| Terminal lease loss retains stale diagnostics | Lease retry-max records stage, raises downloadError, returns without finish | Confirmed static path remains; test terminal vs retry transitions and avoid hiding a real stalled handoff |

Static confirmation is not a live-browser reproduction. None of these nine old
review threads is marked resolved merely because this note exists. Resolve only
with a merged regression-backed fix or evidence that the finding is superseded.
The five terminal lifecycle findings deliberately remain a separate change, so
this instrumentation pass does not casually rewrite native download progression.

## Bounded report contract

Full diagnostic reports use `schemaVersion=2` and
`diagnosticsVersion=download-hang-v2-bounded`. This labels the shape change rather
than pretending sampled details are the old complete arrays. The lightweight
`__PBD_AUTOMATION_STATUS__` / automationSnapshot polling contract is unchanged.
Dotfiles current diagnostics helpers preserve the full report and have no direct
consumers of controller.taskList/downloadStates; future readers must inspect the
version and truncation metadata rather than assuming complete queue coverage.

Controller `downloadStates` and `taskList` now contain indexed sampled detail
entries, with total/omitted counts and a full scalar state summary. Active entries
are preferred, then recent entries. Full capture scans the queue but does not
clone an entire thousands-item batch; normal polling never invokes this path.

UTF-8 JSON budgets: detail2 KiB, entry4 KiB, collection24 KiB, page96 KiB,
worker96 KiB, combined/persisted report200 KiB, retained storage object512 KiB.
Retention also stays at most20 reports. Keys, JSON wrappers and multibyte text are
counted. Records expose truncation/serialization-error metadata, avoid custom
toJSON execution, catch throwing accessors, and bound nesting/nodes/strings.
Active diagnostic records are capped at256; worker event tabs at32; queued
persistence requests at8. Diagnostic eviction never cancels an actual download.

The serializer detaches page timelines and worker bookkeeping before awaits.
Worker tasks are tab-scoped. Storage failures return explicit unavailable/false
status without rejecting the native download operation; the serialized persistence
queue recovers for later reports. The change does not request unlimitedStorage.

## Validation and remaining acceptance

Focused parent test run:23/23 tests passed. Initial full parent run:273/273 tests
passed, TypeScript noEmit, formatting, webpack and packaging passed. A final
validation after the explicit report-version marker and current-master integration
must be recorded in the PR before merge. Build generated bundles normally and
verify ZIP/dist/source-worker parity; never copy only content.js.

Production acceptance is still pending. Require exact-head review and an owned
idle page boundary, then bounded diagnostic capture and paired-bundle verification.
Do not reload the active downloader merely to validate this candidate.

References: merged PR #3 review threads; MDN runtime.onMessage guidance on async
listeners; Chrome storage.local serialized-value/key quota documentation. The
new tests model competing Promise responses rather than merely asserting source text.


### Final integrated validation

After integrating merged distinct-overlap PR #24 and the roadmap, the combined
candidate passed 285/285 serial Node tests, TypeScript noEmit, webpack, packaging
and git diff checks. The generated source-map conflict was resolved by rebuilding
from merged TypeScript, not hand-editing generated output. ZIP/dist/source-worker
bytes match for all six core bundles/workers. Runtime deployment remains pending.
