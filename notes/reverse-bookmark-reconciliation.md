# Reverse bookmark automation — recovered source, 27 October 2026

> **Historical development record.** See [ROADMAP.md](ROADMAP.md) for current
> priorities and release status. PPBD #21 and the companion Dotfiles changes have
> since been merged/deployed. Old pending-release statements and worktree names
> below are retained as provenance, not current operating instructions.

## Canonical development line

The recovered PPBD source belongs to PR #21 (`feat/bookmark-info-automation`).
The reconciliation worktree is `~/worktrees/ppbd-reverse-walk-reconciled`, on
`feat/bookmark-reverse-walk-reconciled`; the PR branch should be fast-forwarded
to this tested line rather than maintaining another implementation.
The companion Dotfiles development line is `feat/pixiv-reverse-walk-reconciled`
at `~/worktrees/pixiv-reverse-walk-reconciled`.

Preserved inputs:

- `b705b4eef5f27b2a6f5275b6592622f9270d7a13`: original bookmark information API.
- `dbb17a3873de81b6b86bef2fb58e22e4129db440`: formerly uncommitted native retry,
  queue-generation, command-token, conversion diagnostics and generated-worker
  follow-ups. This commit is an archival checkpoint, not a production release.
- `9aaa55dd8f5c6fa62d8bbb03bff1c9e08e204a45`, branch
  `archive/ppbd-generated-20261027`: four orphaned generated files from the old
  master checkout. Preserved for recovery, deliberately NOT merged. Rebuilding
  the recovered source is the authority for distributable assets.

PR #22 / `fix/search-list-navigation-limit` is explicitly excluded. Do not
merge SPA search page-limit or upstream changes as part of this reconciliation.

## Contract repaired during reconciliation

Bookmark commands now accept tagged artwork and novel bookmark routes. The
collection path segment determines the API type and UI page size; a user tag
named `novels` must never turn an artwork collection into a novel collection.
`API.getBookmarkData` accepts a decoded raw bookmark tag and encodes it once at
the request boundary, so `&`, `#`, percent signs and Unicode cannot change
sibling filters or truncate the query. Existing pre-encoded `work_tag` behavior
is retained. The read-only information API and native crawler share the same
query interpretation and API implementation.

The recovered command lifecycle carries an opaque queue generation in status
and revokes command tokens when ownership/queue or native retry state changes.
A native retry pause is identified by both `controller.pause === true` and
`pauseReason === 'retry-errors'`, even when the outward phase is READY. An
explicit owned pause cancels the delayed retry, including a pending busy retry;
stop requires the retry not be busy. Neither acceptance means that all in-flight
files have drained. The runner must validate the status attached to the exact
one-shot command token, not merely a prior free-standing status poll.

## Additional independent-review correction

A review reproduced stale discovery proof after `importResultLoaded` followed
by `crawlComplete`: a same-size replacement queue on the same URL could inherit
the old discovery IDs under a new queue identity. Imports now clear discovery,
pre-metadata ID-list and old crawl-start/empty state. A discovery snapshot binds
only to its first completed queue; a repeated completion cannot reassign that
proof after result replacement. Regression tests cover imported queues, late ID
events, a legitimate new crawl, and repeated completion after resultChange.

## Bundle coherence

Run the full Node suite, `tsc --noEmit`, `npm run ts`, and `node pack.js`.
Packaging must synchronize static assets; copying only `content.js` is unsafe.
The recovered EU incident involved new streaming conversion code paired with
an old Whammy worker. Verify the ZIP and dist copies of content/background/inject
bundles and Whammy/WebP workers; the static workers must also match their source.

The 27 October reconciliation passed 259 Node tests, type checking, webpack,
packaging and diff checks. The ZIP/dist/source-worker byte equality was checked.
The six core bundle/worker hashes are also committed in
`notes/reverse-bookmark-bundle-sha256.json`. Exact logs and SHA-256 manifests
are retained on the jump box under
`~/orchestration-logs/artifacts/pixiv-reconcile-20261027/`.

## Remaining release gates

These local validations are not a live-browser acceptance test. Keep the coupled
runner/extension release unmerged and undeployed until final review and an idle,
ownership-checked, bounded live smoke are authorized. Preserve the EU page-832
checkpoint and all existing browser state. Checkpoint discovery alone must never
be treated as a completed download or authoritative full membership.

The Dotfiles memory-abort ownership fix and navigation-readiness reconciliation
are companion requirements. Do not deploy only this extension or only an old
runner based on a branch name; use exact reviewed source and artifact hashes.

## Final review outcome

The first full-source independent review identified the imported-queue P2 above.
After its fix, a separate read-only cross-review found no remaining actionable
findings in that correction or the companion runner reconciliation. Both new
PPBD regressions passed independently. The complete 259-test suite and rebuilt
package passed on the parent host. GitHub review, CI and authorized live smoke
remain separate gates before merge/deployment.
