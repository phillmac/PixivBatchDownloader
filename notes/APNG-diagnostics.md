# Capturing an APNG conversion failure

This fork captures APNG failures automatically, without opening DevTools before
the failure. It adds an expandable **APNG failure details** entry to the existing
page log. Each failed attempt has its own timestamps and worker request ID.

## Install the diagnostic build

1. Export your settings from the currently installed downloader if you want to
   carry them across. Settings use `browser.storage.local`, which belongs to the
   extension installation. Download records use the `DLRecord` IndexedDB database
   on the Pixiv page's origin, so they normally remain available when switching
   installations in the same Chrome/Edge profile. Record export/import is needed
   when moving to a different browser profile or restoring a backup.
2. Extract the diagnostic ZIP into a permanent folder. In `chrome://extensions`
   (or `edge://extensions`), enable Developer mode and choose **Load unpacked**.
   Select the extracted folder containing `manifest.json`. If building from
   source, select `dist` instead.
3. Disable the other installation of Powerful Pixiv Downloader so only this build
   runs on Pixiv. Import your settings into this installation; existing download
   records in the same browser profile do not need to be imported again.
4. Refresh the Pixiv tab to load the diagnostic code, then use the downloader as
   usual. No diagnostic setting needs to be enabled.

For a source checkout of the `apng-failure-diagnostics` branch:

```sh
npm install
npm run ts
node pack.js
```

`node pack.js` is required: it copies the updated APNG worker into `dist/lib` and
creates `powerfulpixivdownloader.zip`. Reload the unpacked extension and refresh
the Pixiv tab after rebuilding.

## When a failure happens

1. Pause downloading if retries are still running.
2. Expand **APNG failure details** under the red conversion failure message.
   Its heading already shows the failing stage, exception name and message.
3. Click **Export logs** in the page log area **before refreshing or closing the
   tab**. This manual export works while paused and does not wait for the batch
   to complete. It also ignores automatic export filters.
4. Keep that HTML log and the affected work's saved ZIP/ugoira file, which includes
   `animation.json` when saved by this downloader. Together they provide the
   failure evidence and source frames for a later reproduction. Enabling ZIP
   alongside APNG ensures a source copy is saved before APNG conversion starts.

The automatic log export setting “download complete” still requires completion;
use the manual button when a failed item prevents the batch from finishing.
The reports live in the current tab's log until exported; clearing the log or
reloading the tab removes them. Exporting the log retains the full JSON inside
the expandable entry.

## Reading a report

| Stage / field | What it establishes |
| --- | --- |
| `read-zip`, `scan-zip-frames`, `decode-frames` | Failure happened before APNG encoding. Check the original error, ZIP size, extracted frame count and cache status. |
| `load-worker` | Loading the bundled scripts or creating the worker failed. Resource paths/statuses and the original exception are recorded. |
| `read-frame-pixels` | Canvas processing failed. `frame`, `frameOperation` and `framesRead` identify the frame and operation reached. Frame indices are zero-based. |
| `worker-post-message` | Submitting/transferring the pixel buffers failed, for example with `DataCloneError`. |
| `wait-worker` with `workerStarted: false` | No start acknowledgement was received before the failure. This can mean queueing or an unresponsive worker; it does not prove either cause. |
| `worker-encode` | The worker acknowledged the request and entered encoding. A worker exception preserves its original name, message and stack. A timeout here does not prove the encoder ran out of memory. |
| `worker-post-result` | Encoding returned, but sending its result from the worker failed. |
| `worker-error`, `worker-messageerror`, `worker-response` | A worker runtime error, a response deserialization error, or an invalid response occurred. |
| `create-apng-blob` | The main thread received the encoded result but could not finish constructing the output. |
| `timeline`, `elapsedMs`, `workerEncodeMs` | Elapsed time from conversion request, stage transitions, and worker execution duration when a response is available. |
| `workerCreatedAt`, `workerRequestId`, `previousWorkerTimeouts` | Identify reuse of the same worker across attempts. A timed-out request may still be running in that worker. |
| `inputRGBABytes` | Size of the uncompressed input pixels: width × height × 4 × frame count. This is **not** peak encoder memory. |
| `mainThreadHeapAtStart`, `mainThreadHeapAtFailure` | Optional browser heap snapshots. These exclude worker/native allocations and cannot establish total memory usage. |

Reports include the work ID, extension and diagnostic versions, browser,
conversion/download thread settings, enabled formats, dimensions and delay
summary. They do not retain image buffers or dump the full settings file.
`diagnosticsVersion` is `apng-failure-v1` for this build.

The timeout remains 120 seconds, measured from submission to the worker, including
queueing time. This change does not increase the timeout, change the retry policy,
or claim a cause for an intermittent failure that has not yet been captured.
If the browser kills the whole tab/process, JavaScript cannot create a failure
report after that termination.

For live inspection, open DevTools on the **Pixiv tab**. Enable Errors, clear any
text filter, and include the extension's content-script context (disable
“Selected context only” or select Powerful Pixiv Downloader). Search for
`PPD ugoira conversion failed`. The console contains the report and original
exception. Enable Preserve log if you need console output to survive navigation.

## Verification

```sh
node --test tests/apng-diagnostics.test.cjs
npm run ts
node pack.js
```

The focused tests inject encoder, transfer, timeout, worker, canvas and decode
failures; check concurrent response routing and cleanup; and run the bundled
UPNG/pako encoder on a tiny two-frame animation. They do not reproduce the
intermittent failure of a particular Pixiv work in a logged-in browser.
