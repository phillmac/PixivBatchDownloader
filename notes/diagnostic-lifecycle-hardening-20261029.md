# Terminal diagnostic lifecycle — 29 October 2026

## Source and scope

Built on merged diagnostics PR #25 (`628b8afc`) and overlap PR #24. This change
finishes the five retained PPBD-03 source paths without changing user filters,
account pacing, native file format selection, queue generations or owned-command
APIs. Candidate only: no production reload, settings change or checkpoint edit.
The EU reverse walk continues with both skip controls ON; hourly task disabled.

## Completion evidence

| Path | Completion evidence and failure behavior |
| --- | --- |
| Conversion error | Native downloadError handoff returns; finish this failed attempt as conversion-error. Do not emit conversion-complete or pretend a file was saved. A throwing handoff remains diagnosable. |
| Skipped file | Existing typed skip event carries diagnosticId; controller finishes only after downloadOrSkipAFile returns true. False/exception/missing listener retains watchdog. Already canceled attempts have no expected advancement and terminate as skip-canceled. |
| Worker result delivery | Keep active task at result-message-pending through the sendMessage promise. Resolution finishes delivered; rejection captures worker evidence before terminal cleanup. Native bookkeeping is not held hostage by pending delivery or telemetry persistence. |
| Browser save failure / retry | USER_CANCELED finishes only after advancement; ordinary retry retains watchdog through original three-second delay and ends only after a new Download instance accepts the handoff. Rejected/delayed/absent handoff stays diagnosable; no extra retry is scheduled. |
| Terminal global lease loss | Existing retry-limit error event returns, then finish the failed attempt once. Nonterminal lease retries stay active; throwing native error handoff does not falsely finish. |

A related retry-max path previously finished before HTTP404/500 skip advancement;
it now follows the same skip acknowledgement rule. Other terminal retry-max paths
retain their native error policy and only finish after that synchronous handoff.

## Regression design

The new test module executes actual TypeScript Download, DownloadControl and
background listener paths in a VM. Browser I/O, UI and timers are fakes; no Pixiv
request, cloud operation or real download occurs. It checks source-level state
advancement, absence of fabricated success, watchdog liveness/removal and worker
report contents—not only source-text patterns.

Coverage includes actual conversion failure/success/no-conversion, missing/false/
throwing skip advancement, USER_CANCELED, delayed/rejected retry, HTTP404/500
retry-max, terminal/nonterminal/failed-handoff lease loss, and pending then resolved
or rejected normal/error/simulated worker result messages. Duplicate browser
completion notification does not cause duplicate delivery. Rejected-delivery
report retains task identity, stage, native error and browser-download evidence.

Initial focused parent run:43/43 diagnostic/lifecycle tests and TypeScript noEmit
passed. Final complete serial suite/build/package/parity results belong in the PR
and final handoff; do not infer them from the implementation worker's exit.

The bounded implementation worker reached its eight-minute stop after writing
source/tests. It did not provide a completed validation report. The parent ran
fresh tests and builds; only those explicit results are release evidence.

## Release

Source review and tests are not live acceptance. Stage the coherent extension
only at an owned, idle page boundary with saved rollback/journal/settings and a
bounded smoke. Do not replace the running release mid-download. Old PR #3 threads
remain unresolved until this candidate is merged with regression-backed evidence.


## Final parent validation

All 309 serial Node tests passed (24 new lifecycle regressions), including the 43
focused diagnostic/lifecycle tests. TypeScript noEmit, changed-file Prettier,
webpack, pack.js and git diff --check passed. ZIP/dist/source-worker byte parity
passed for content/background/inject and Whammy/WebP assets; the exact candidate
hashes are in diagnostic-lifecycle-bundle-sha256.json. These are fresh supervised
parent results, not inferred from the implementation worker's timed stop.
