# PPBD roadmap and release recommendations

_Last reconciled: 29 October 2026 (AEDT). Current PPBD-owned priorities._

Use fresh `origin/master` worktrees, not the old reconciliation checkout names.
The currently accepted extension baseline is merged #21 (`824256f9`). Read
[the Dotfiles cross-repository roadmap](https://github.com/phillmac/Dotfiles/blob/master/PIXIV_ROADMAP.md)
for orchestration, archival, resource containment and deployment ownership.

## Constraints

The EU reverse walk is active. Both `DonotCrawlAlreadyDownloadedWorks` and
`deduplication` are intentionally ON; do not change them as a side effect of
hardening. The hourly reverse-walk task remains disabled. No extension reload,
browser recreation or executing-runner replacement mid-download. Isolated local
tests are allowed; production acceptance must use a verified page boundary,
owned idle queue, exact artifact hashes, rollback and a bounded smoke.

Keep native state/control in PPBD; orchestration belongs in Dotfiles. Do not add
DOM-click wrappers or duplicate native lifecycle state. Preserve discovered IDs
before metadata/download filtering, completion-proven overlap, command ownership,
queue generations, pacing, resumable downloads and final membership checks.

## Delivery sequence

| ID | Work | Current status | Acceptance |
| --- | --- | --- | --- |
| PPBD-01 | Distinct known-overlap boundary | Confirmed bug; isolated implementation underway | Three repetitions of one ID must not stop discovery; tests across responses and unknown resets; preserve valid distinct overlap and exhaustion |
| PPBD-02 | Diagnostic routing, byte budgets, immutable capture and tab identity | Targeted implementation underway | Competing unrelated listener cannot win replies; snapshots/storage bounded by bytes; captured timeline stable across await; equal per-tab IDs isolated |
| PPBD-03 | Terminal diagnostic lifecycle audit | Pending triage | Conversion errors, skip advancement, worker delivery, retry handoff and lease loss each classified, tested and fixed or proven superseded |
| PPBD-04 | Automated validation and paired release manifest | Recommended next | Standard test/typecheck/non-mutating-format scripts, CI, webpack/package and ZIP/dist/static-worker equality; explicit candidate/deployed provenance |
| UPSTREAM-01 | Selective upstream sync | Open; latest upstream not reviewed here | Inspect commits individually and include only worthwhile compatible changes; no blanket merge |
| SPA-22 | Search list-page/SPA navigation PR #22 | DEFERRED by user | Reproduce against current build in isolated/idle browser; do not mix into active bookmark work |

### PPBD-01 evidence

On baseline `824256f9`, threshold3 with knownIDs101/102/103 and an input of
101/101/101/999 returns a known-overlap boundary after the repeated101. Fix the
streak rule, not the user's filters. The 29 October audit of187 completed journals
found no duplicate boundary among186 recorded overlap stops; production impact
has not been demonstrated. The active journal must not be rewritten.

### PPBD-02 / PPBD-03 triage requirements

Merged PR #3 has nine unresolved review threads. An unresolved thread alone is
not proof a defect still exists. Reproduce against current source and record one
of confirmed, fixed-with-regression, superseded-with-evidence or needs-reproduction.
Prioritize broad async following-message interference, whole-batch diagnostic
storage pressure, shallow timeline copies and per-tab diagnostic-ID collisions.
Preserve diagnostic evidence until actual native advancement/delivery, and remove
terminal stale tasks so failure reports are not fabricated after completion.

Subsequent review also needs to reconcile older #13/#18/#20 ownership and scope
findings against current code. Documentation-only findings must not be presented
as reproduced P1 runtime incidents. Empty overlap-set semantics are intentional
for an initial reverse segment and must continue to prove source exhaustion.

## Release contract

For any TypeScript change: run relevant and full Node tests, `tsc --noEmit`,
changed-file formatting checks, `npm run ts` and `node pack.js`. Rebuild generated
assets, never hand-edit them. Compare source/static workers with dist and package,
including Whammy/WebP; new bundle code with an old worker is not a valid release.
Record exact source hash, test counts and limitations. Avoid the source-writing
`npm run fmt` as a CI check; add a check-only path instead.

Commit isolated changes, open a scoped PR, and review exact heads. Merged is not
deployed. Generated ZIPs and transient logs must not pollute source. Keep baseline
worker protocol and helpers compatible; a new runtime API needs paired consumer
acceptance in Dotfiles before deployment.

## Historical material

[Reverse-bookmark reconciliation](reverse-bookmark-reconciliation.md) is an
October27 development record, not a current release gate or worktree pointer.
Its archive commits remain recoverable. Existing accepted automation and progress
watchdogs are the baseline; this roadmap asks for targeted hardening, not a rewrite.
