# Automation settings and button audit

The API lives in the PPBD content script's **isolated execution context**, like
`__PBD_AUTOMATION_STATUS__`. It is not a page-world API. Both calls return promises:

```js
await globalThis.__PBD_AUTOMATION_GET_SETTING__('crawlNumber', { pageType: 2 })
await globalThis.__PBD_AUTOMATION_SET_SETTING__('crawlNumber', -1, { pageType: 2 })
```

Allowed keys: `crawlNumber`, `DonotCrawlAlreadyDownloadedWorks`, `deduplication`,
`autoStartDownload`, `autoStartDownloadForQuickDownload`. Boolean keys require an
actual boolean. Crawl limits require a safe integer within the configured range;
`-1` is allowed only where max is `-1`. Hidden/non-crawl page types reject writes.
Page type defaults to the current SPA page type, so orchestration should supply an
explicit page type for temporary overrides and restoration. Numeric page types
are PPBD's stable PageName enum (UserHome=2, Bookmark=4).

Reads include apiVersion, key, pageType/name, unit (`pages`, `works`, `none` or
null for booleans), min/max, supportsUnbounded, effectiveValue, persistedValue,
persisted, verified, requiresReload and crossTab. Missing persisted values are
null and are not verified, even when defaults are effective. Reads fail before
settings initialization. Writes fail while PPBD is busy and add previousValue,
previousPersistedValue and requestedValue. A write returns only after background
storage readback and current runtime readback succeed. Failures reject; storage
may already have changed if later verification fails, so always restore in
`finally`, using a value read *before* attempting the override.

The API does not change crawl mode or apply a preset. Both auto-start settings
remain independent. All exposed controls are runtime settings; requiresReload is
false. This does not clear an existing managed-crawl safety/ownership reload
requirement. The runner must continue honoring that separate contract.

## Persistence and propagation

Previously each tab's debounce saved the whole settings copy. With cross-tab
synchronization disabled this could overwrite unrelated newer persisted values.
Settings now collect local dirty keys; the existing single background runtime
message dispatcher serializes merge-and-verify patches. Automation crawlNumber
updates patch only one page entry. UI changes still use normal setters/events and
debouncing. Initialization restores defaults and conversions in memory without
writing the entire stale snapshot. Reset/import deliberately update their full
set of keys. Unknown persisted keys survive normal patches.

`settingChange` updates local consumers and form controls. `storage.onChanged`
updates other tabs through the same setter without a persistence feedback loop.
The existing `settingsAcrossDifferentTabs` preference is respected. With sync
disabled, the calling tab still receives its own automation change immediately;
other tabs keep their independent runtime values. crossTab reports `storage-event`
or `disabled`; acknowledged is **false** because storage completion is not an
acknowledgment from every tab. Read the API in each tab to verify propagation.
Legacy already-loaded tabs retain their old whole-snapshot writer until reloaded;
deployment should not change settings while mixed code generations are active.

## Control classification and click investigation

| Control | Category | Evidence / automation path |
| --- | --- | --- |
| crawlNumber input, min/max buttons | Persisted setting + runtime event | CrawlNumber.ts assigns value then setSetting; buttons dispatch input change. Use API, no click needed. |
| DonotCrawlAlreadyDownloadedWorks, deduplication | Persisted setting + runtime event | FormSettings.ts uses setters; filters/download code read runtime settings. Use API. |
| autoStartDownload, autoStartDownloadForQuickDownload | Persisted setting + runtime event | DownloadControl.readyDownload reads each separately. Use API. |
| Other settings | Not audited exhaustively | Deliberately excluded from whitelist; no blanket reload claim. |
| Start crawl | Command | InitPageBase.addCrawlBtns registers readyCrawl on click. commandStartDefaultCrawl currently calls SettingsPanelShell.clickDefaultCrawlBtn. A future owned direct command API could avoid DOM. |
| Start/pause/stop download | Command | DownloadControl registers click handlers invoking controller methods. Not settings. Future direct command surface needs lifecycle/ownership checks. |
| Extension reload | Lifecycle operation | New JS requires extension reload and page reinjection; unrelated to setting value updates. |

No exposed setting requires DOM interaction. No audited handler checks isTrusted,
uses user activation, or lives in shadow DOM. PPBD's panel uses custom DOM/slots,
not React/Preact. Pixiv's own SPA is separate. Historical flakiness cannot be
attributed conclusively without a captured failure, but the source establishes
concrete timing hazards: CrawlNumber attaches handlers in setTimeout(0), panel
bootstrap/slots must exist, page-switch rebuilding can invalidate references,
and extension reload invalidates isolated contexts. Evaluating PPBD globals in
the page world cannot reach them. Setting an input's `.value` does not fire its
`change` listener, and `.click()` on a numeric input does not change its value.
Use fresh execution contexts and fresh element lookup for remaining commands.
The runner already looks up command buttons afresh and checks disabled state.

Next button investigation should instrument selected crawl/download command
handler registration and invocation, then reproduce any failure under SPA and
extension reload. Do not introduce a generic click framework without that proof.
