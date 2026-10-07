# Automation command controls and button investigation

The audited commands use custom PPBD DOM and slots, not React/Preact or shadow
DOM. No crawl/download handler checks `isTrusted` or browser user activation.
None of these controls inherently requires a DOM click.

## Registration, invocation and observation

- SettingsPanelBootstrap creates the shell/form synchronously. Tools.addBtn
  creates each button; the page module attaches its listener immediately after
  creation. Numeric crawl setting handlers have their separate delayed setup.
- InitPageBase.readyCrawl checks busy, managed reload requirement, recrawl
  confirmation and filter validity, then emits crawlStart before awaiting mute
  settings. It eventually enters the page's ID enumeration and metadata crawl.
  crawlComplete/crawlEmpty complete managed ownership; stops revoke ownership.
- InitUserPage, InitBookmarkPage and InitUserRequestPage use readyCrawl for their normal start button.
  Only these page controllers are registered for automation crawl.start.
  Other pages can have specialized button setup (search, series, etc.); calling
  the base method indiscriminately would bypass that setup.
- PageType emits pageSwitchedTypeChange synchronously. DestroyManager clears
  the old page slots; InitPage creates the replacement controller in setTimeout(0).
  Same-type switches retain the controller. URL checks still apply to every call.
- DownloadControl is document-scoped; its start/pause/stop listeners do not get
  rebuilt on SPA type switches. crawlComplete/resume/resultChange schedule
  readyDownload in setTimeout(0). READY status can therefore precede download
  preparation. Automation now waits for the controller's preparation flag.
- startDownload checks busy/results/revocation, resets or resumes download states,
  emits downloadStart, then schedules download workers. Pause/stop emit their
  lifecycle events; in-flight workers/files can still settle afterward.
- StopCrawl's button both emits stopCrawl and sets states.stopCrawl. Dispatching
  only its event is not an equivalent legacy stop. The API invokes the same
  native method. Managed operations continue using the exact existing abort API.
- HotkeyListener dispatches commandStartDefaultCrawl; SettingsPanelShell locates
  the current primary crawl button and clicks it. Download summary buttons locate
  the corresponding real download button. Those UI shortcuts remain unchanged.
- EVT dispatch and function returns indicate invocation, not task completion.
  AutomationStatus reports URL-bound lifecycle, managed state and controller
  state; the runner continues observing those contracts and its watchdogs.

## Captured live evidence (2026-10-07)

Archived transcripts: ~/orchestration-logs/artifacts/pixiv-button-control/.

Fresh UserHome and Bookmark controls were mounted, connected, enabled and hidden.
There were two click listeners (ripple and controller); the corrected probe
selected the actual controller listener by its source and used a conditional
Debugger function breakpoint as a hit counter. Synthetic pause on an empty
owned test tab reached that controller exactly once, with isTrusted=false and
navigator.userActivation.isActive=false. No crawl or download was started.

An owned-tab UserHome->Bookmark SPA route probe detached/replaced startCrawling
while retaining startDownload. A targeted page reload rejected the old isolated
context with `Cannot find context with specified id`; fresh lookup found registered
handlers. This reproduces stale-reference failure after reload, and establishes
why a retained crawl node cannot identify the current controller. It does not
attribute all historical button failures to either cause.

The previous settings smoke separately captured an isolated context before API
mounting. Context discovery, DOM presence, document interactivity, visibility,
and enabled state are therefore insufficient readiness signals. Hidden state
alone did not prevent .click() from reaching the handler. No historical failure
has established a requirement for trusted clicks or physical pointer input.

At initial baseline Chrome reported zero active files while an unrelated PPBD
controller was DOWNLOADING. No deployment/reload occurred during that state.
Later preflight found only idle pages and no runner process; external tab changes
were not caused by task commands and their exact timing remains unknown.

## Narrow PPBD-owned API

The read and invocation promise globals live in the PPBD isolated content-script world:

```js
const ready = await globalThis.__PBD_AUTOMATION_COMMANDS__()
const reply = await globalThis.__PBD_AUTOMATION_COMMAND__({
  command: 'crawl.start',
  url: ready.url,
  token: ready.token,
  operationId: armed.operationId,
})
```

Readiness returns apiVersion=1, exact normalized url, token, ready, crawlReady,
downloadReady, and the normal AutomationStatus snapshot. `ready` requires settings
initialization, native download-controller registration and a stable read.
`crawlReady` identifies a registered UserHome/Bookmark/UserRequest controller whose type
agrees with the current URL; it does not mean idle, valid filters, or arm ownership.
`downloadReady` means delayed native preparation finished. These booleans are
registration/preparation signals; the invocation still checks all preconditions.

Commands: crawl.start, crawl.stop, download.start, download.pause, download.stop.
The token is document-specific and single-use. Registration, page navigation and
queue/lifecycle events invalidate it. A command rechecks URL/token after all async
reads and consumes the token immediately before calling the backing controller.
Two concurrent calls with one token cannot both invoke. A synchronous
`__PBD_AUTOMATION_INVALIDATE_COMMAND__(token)` returns apiVersion, token and
outcome=invalidated/superseded. Either acknowledgment proves that exact token
cannot start a later pending invocation; superseded may also mean it already ran.
The runner revokes a token after any ambiguous invocation response, then observes
already-started work through normal cleanup. If revocation cannot be confirmed,
it records an indeterminate command, keeps the recovery tab and defers restoring
managed auto-start=true. A CDP timeout alone does not cancel the page promise.
 Refresh invalidates both
context and token. A new readiness query is not permission to retry an ambiguous
command: observe status and reconcile ownership first.

crawl.start requires the exact current managed arm ID/URL, audited controller,
IDLE, no busy operation, no managed reload requirement, no bookmark/tag-list/quick/timed mode, and no undownloaded result
confirmation. Native filter refusal returns not-started after consuming the token.
Acceptance requires the actual managed crawlStart transition. Full/incremental,
ID gate, known overlap and downloaded filtering remain the existing contracts.

crawl.stop is only for explicit legacy takeover cleanup with an active URL-bound
crawl and the current token. Active managed operations refuse with use-managed-abort;
the runner uses __PBD_AUTOMATION_ABORT_CRAWL__ for those instead.

download commands require the queue's original URL to match the live URL and reject
revoked managed queues. Start requires completed native preparation, results and
READY/PAUSED_RESUMABLE/STOPPED with no busy operation. Pause/stop require an active
DOWNLOADING controller. Native lifecycle state must transition for acceptance.
Tokens prevent an old request from acting on a replacement queue or new batch.
These are local document guards; runner cross-tab/memory/ownership safeguards
continue to apply independently.

Replies include apiVersion, command, outcome=accepted/refused, state=pending/null,
reason, and accepted URL (plus managed operationId for crawl start). Invocation or
receipt never claims completion. `not-started`/`not-stopped` may follow invocation;
errors/timeouts may follow effects. Do not automatically retry them. Completion is
reported by normal managedOperation.state=completed and URL-bound lifecycle events
in subsequent status queries, not by the command return. Pause/stop acceptance also
does not mean all in-flight browser downloads have drained.

## Classification and runner

| Control | Classification | Automation path |
| --- | --- | --- |
| crawlNumber input/min/max | Persisted setting + runtime event | Completed settings API; no click |
| already-downloaded, deduplication, both auto-start controls | Persisted settings + runtime events | Completed settings API; no click |
| Start profile/bookmark crawl | Command | Owned arm + crawl.start |
| Stop managed crawl | Ownership/lifecycle command | Existing exact abort API |
| Stop legacy crawl | Command | Explicit takeover + crawl.stop |
| Start/pause/stop download | Commands | Native prepared controller + single-use token |
| Extension/page reload | Lifecycle operation | Fresh context/controller required; CDP reload, no button |
| Managed requiresReload | Operation guard | Retained; setting requiresReload=false does not override it |
| Other buttons/settings | Outside narrow audited surface | No blanket classification or API claim |

The runner removed click_first and button_enabled. Requests-section commands invoke
the audited requests controller, preserving its section-specific behavior. If native
auto-start runs during readiness polling or invalidates the command token, the
runner observes the bound active/completed lifecycle without starting it again. It polls read-only API mounting
and controller readiness for at most ten seconds, invokes each command once, and
never retries a mutation/verification failure. Download-start observation requires
matching URL-bound downloadStarted/downloadCompleted events before treating an
immediate IDLE transition as complete. The existing full/incremental discovery,
membership, early-stop, abort, watchdog, gate and navigation-aware settings
restoration remain intact.

Next task: PPBD upstream synchronization. Review upstream changes individually;
do not bulk merge upstream.
