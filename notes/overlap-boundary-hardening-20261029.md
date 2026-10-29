# Distinct overlap boundary — 29 October 2026

## Reproduction and rule

Baseline `824256f9` accepted `101,101,101` as a threshold-three known boundary,
which could omit an unexamined `999` immediately afterwards. This is a synthetic
confirmed defect, not evidence of damage in the active EU walk. The prior audit
of187 journals /186 overlap stops found no duplicate recorded boundary IDs.

Only a consecutive run of previously unseen, distinct known IDs may vote toward
the boundary. A repeated known ID clears the streak and does not start a new
streak; it may not vote again later in the same crawl. Unknown IDs and
`allowBoundary=false` clear the streak without forgetting already observed known
IDs. The seen set resets for a newly armed/started crawl and clears at termination.
This deliberately conservative rule can scan more data after duplicates/replays,
but cannot stop on repeated evidence. Discovery order and independent metadata /
download filters remain unchanged. Empty known sets still prove source exhaustion.

## Validation

- 112 focused known-overlap/automation-status tests pass.
- 271 complete Node tests pass, run serially with a512MiB heap cap.
- TypeScript noEmit, changed-file Prettier, webpack, package and diff checks pass.
- ZIP/dist equality verified for content/background/inject and Whammy/WebP assets;
  static workers match their source. Generated content bundle/map rebuilt normally.
- New regressions cover repeats within/across responses, A/B/A, replay after unknown
  or disabled boundary, valid distinct cross-response overlap and explicit empty sets.

The initial parallel development/test attempt overloaded the small jump box and
was terminated. The results above are fresh parent-run serial validations, not
success inferred from that interrupted attempt. No unrelated processes were stopped.

## Deployment

Candidate source only; not deployed. Both user-requested skip controls remain ON
in production and the hourly task remains disabled. Require exact-head review
and a verified page boundary/idle queue, preserved state, coherent extension bundle
and bounded smoke before deployment. Do not reload the active walk mid-download.
