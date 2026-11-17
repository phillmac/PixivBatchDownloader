# Search-list crawl page limit: navigation and duplicate completions

Observed (2026-10-15): when the configured work-ID list-page limit is 1, the progress
occasionally reads `crawling list page 2/1`. It appears correlated with **Pixiv's
in-site navigation**: from page 1 to page 2 of a tag listing, or switching Top,
Illustrations, Manga, and Novels. This is a suspected trigger, **not yet verified**.

Before deploying this fix, reproduce on the **current EU extension build** when
`ns3133383.ip-51-75-146.eu` is idle. The current extension should remain
untouched until this baseline check. Record:

1. Page URL before and after navigation; page type and category.
2. Crawl limit (1), crawl start/stop/navigation sequence, progress counters.
3. Work-ID API request page numbers, whether the same page resolves twice, errors/retries,
   `crawlStart`, `stopCrawl`, and `getIdListFinished` observations.
4. Try navigation while initial total-count request is outstanding, while work-ID page
   is being fetched, and immediately after ID-list completion. Repeat for illustration,
   manga, and novel tag/search results.
5. Compare baseline against the patch in this branch (without replacing baseline first).

Source review: `InitSearchArtworkPage` and `InitSearchNovelPage` incremented
`listPageFinished` for every successful callback, even duplicate page callbacks,
and used equality to detect completion. A completed count above the target could
prevent the completion path. Pixiv SPA navigation can change the URL without
creating a new crawl generation, so async callbacks need URL-scoped ownership.
The initial page-1 total-count lookup also fetched page 1 a second time when
collecting IDs (redundant request, not alone an explanation of 2/1).

Patch intent: bound page allocation; idempotent completion/retries; abort list-page
collection after navigation; reuse the initial page-1 response when appropriate;
cover the invariants with regression tests. Do not claim the actual navigation
failure was reproduced until observed on EU.
