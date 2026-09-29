# Download hang diagnostics

Rare downloads can become stuck with the page still showing `Downloading` even though normal activity has stopped. These failures are difficult to reproduce, so preserve the live state before trying to recover it.

## First rule: capture before recovery

Do **not** reload the page, pause/start the downloader, stop the task, update the extension, or restart the browser until a diagnostic snapshot has been captured. Those actions reset the state that identifies where the task stopped.

After capture, pause followed by start remains a reasonable manual recovery action. This instrumentation does not automatically retry, abort, pause, or recover a download.

## What a useful capture must answer

For the stuck item, determine which boundary was reached:

1. Was a `Download` task created and which `downloadStates[]` index is still active?
2. Did media fetching start, receive a response, make body progress, and reach EOF?
3. For a novel, did generation reach `novel-blob-ready`?
4. Did file-order waiting begin and finish?
5. Did the page send the save message to the extension service worker?
6. Did that runtime message resolve or reject?
7. Did the service worker receive the save request?
8. Did duplicate suppression reject the request?
9. Did `browser.downloads.download()` start, resolve to a browser download ID, or reject?
10. Did Chrome report the download complete/error?
11. Did the worker send the result back to the originating tab?
12. Did the tab consume that result and change its `downloadStates[]` entry from `0` to `1`?

## Automatic instrumentation

Each `Download` instance now has a diagnostic ID correlated across the content script and service worker. Stage transitions are kept in bounded in-memory rings; body progress refreshes the hang watchdog without logging every chunk.

If a task remains in one stage for five minutes, the page automatically captures a combined report. The report includes:

- page URL, title and visibility;
- controller batch/thread/downloaded/remaining state;
- the complete `downloadStates[]` array and active task indexes;
- each active task's current stage and bounded stage timeline;
- recent page-side stage events;
- service-worker active tasks and recent events for that tab;
- in-memory and persisted `batchNo` / `idList` bookkeeping;
- Chrome Downloads API state for known browser download IDs.

The newest 20 suspected-hang reports are retained in `browser.storage.local` under `downloadHangDiagnostics`. Successful downloads do not create persistent reports.

Worker anomalies that could disappear when an MV3 worker sleeps are persisted immediately: duplicate-suppressed save requests, `browser.downloads.download()` rejection, and failure to send a completion/error result back to the tab.

## Manual snapshot while the tab is still stuck

From the extension service-worker DevTools console, find the tab and ask its content script for a snapshot:

```js
const tabs = await browser.tabs.query({})
const tab = tabs.find((tab) => tab.url === 'https://www.pixiv.net/...')
await browser.tabs.sendMessage(tab.id, { msg: 'get_download_diagnostics' })
```

This is read-only. It does not advance, pause, retry or otherwise alter the downloader task.

If normal extension messaging is itself suspected or unavailable, inspect the page-local fallback through DevTools/CDP:

```js
const text = document.querySelector('#xz-download-hang-diagnostic')?.textContent
const report = text ? JSON.parse(text) : null
```

The fallback is written when the page watchdog detects a stuck stage, before it tries to combine the report with worker state. This deliberately gives us an observation seam even when page-to-worker messaging is the thing that failed.

## Interpreting the last stage

| Last observation | Likely seam |
| --- | --- |
| `fetch-start` with no response | media request / Fetch API |
| `fetch-response` or `body-progress` with no later progress | response body / network stream |
| `body-complete` | post-fetch processing |
| `conversion-start` | ugoira conversion; also inspect APNG diagnostics where applicable |
| `novel-build-start` | novel generation |
| `novel-blob-ready` | novel is generated; investigate ordering/save handoff |
| `save-order-wait` | file-order dependency |
| `browser-save-message-sent` with no resolved/rejected stage | content-script to worker runtime messaging |
| `browser-save-message-rejected` | runtime messaging rejected before normal worker handling |
| worker has no save event after page message resolved | worker lifecycle/message correlation needs investigation |
| `save-request-deduplicated` | `idList` duplicate suppression silently blocked the save |
| `browser-download-create-pending` | worker reached the Chrome Downloads API but its promise did not settle |
| `browser-download-create-rejected` | Chrome Downloads API rejected creation |
| `browser-download-created` plus Chrome `in_progress` | browser/network/disk layer; inspect byte counters and error state |
| `browser-download-complete` but page task remains active | completion result was lost or page advancement failed |
| `result-message-rejected` | worker could not deliver the result to the originating tab |

A progress bar at 100% does **not** prove that Chrome created or saved a download. It only proves that the page-side file/blob preparation reached its end.

## Evidence from the September 2026 live incident

A preserved novel-bookmarks tab provided a useful example of why these boundaries matter:

- the page remained at `470 / 471` with one task active;
- all six visible per-thread progress bars were at 100%;
- the live tab had six download threads and file-ordering disabled;
- Chrome had no active or interrupted downloads;
- five of the six visible novels had completed Chrome download records;
- the sixth novel had **no Chrome download record at all**;
- the page's recent network resources contained no relevant media request, as expected for a generated novel file;
- buffered page/worker console history contained no useful downloader exception;
- pause/start is known to recover this long-standing failure.

That evidence narrows this occurrence to the save handoff after novel generation and before successful Chrome download creation. Two pre-existing silent paths are especially important to distinguish next time: duplicate suppression in the worker and rejection/non-settlement around the page-to-worker / `browser.downloads.download()` handoff.

Do not treat this incident as proof of one root cause. The purpose of this diagnostics layer is to make the next occurrence distinguish those paths without disturbing the live failure first.
