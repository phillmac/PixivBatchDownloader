const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const crypto = require('node:crypto')
function load(file, dependencies = {}, globals = {}) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  vm.runInNewContext(`(function(require,exports){${code}\n})`, {
    console,
    setTimeout,
    clearTimeout,
    crypto,
    ...globals,
  })((name) => dependencies[name], exports)
  return exports
}
const policy = load('src/ts/crawl/CrawlRatePolicy.ts')
// 实际客户端与策略通过模拟 port 连通，虚拟时钟保留准确的 1800 ms 间隔。
function scheduler() {
  const state = { sessions: {}, nextAt: {}, lastAt: {}, waiting: {} }
  const messages = []
  let now = 0
  let sleeping
  const browser = {
    runtime: {
      connect() {
        let listener
        return {
          onMessage: {
            addListener(fn) {
              listener = fn
            },
          },
          onDisconnect: { addListener() {} },
          disconnect() {},
          postMessage(msg) {
            const record = { ...msg, now }
            messages.push(record)
            let reply
            if (msg.action === 'register') {
              policy.registerCrawl(
                state,
                msg.id,
                msg.account || policy.UNKNOWN_ACCOUNT,
                1,
                msg.workCount,
                now
              )
              reply = { granted: true }
            } else if (msg.action === 'finish') {
              policy.finishCrawl(state, msg.id)
              reply = { granted: true }
            } else reply = policy.permitCrawl(state, msg.id, now)
            record.granted = reply.granted
            queueMicrotask(() => listener({ ...reply, request: msg.request }))
          },
        }
      },
    },
  }
  const { CrawlRateClient } = load('src/ts/crawl/CrawlRateClient.ts', {
    'webextension-polyfill': { default: browser },
    './CrawlRatePolicy': policy,
    '../utils/Utils': {
      Utils: {
        async sleep(ms) {
          now += ms
          await sleeping?.()
        },
      },
    },
  })
  return {
    state,
    messages,
    CrawlRateClient,
    setSleep(fn) {
      sleeping = fn
    },
  }
}
const flush = () => new Promise((resolve) => setImmediate(resolve))
function mergeHarness(s) {
  let valid = true
  let requests = 0
  let permits = 0
  const cached = new Map()
  const states = { stopCrawl: false }
  const generation = {}
  const { MergeNovel } = load('src/ts/download/MergeNovel.ts', {
    '../crawl/CrawlRateClient': s,
    '../crawl/CrawlGeneration': { ownsCrawl: (g) => g === generation && valid },
    '../store/Store': { store: { loggedUserID: '123' } },
    '../store/States': { states },
    '../Tools': { Tools: { getLoggedUserID: () => '123' } },
    '../setting/Settings': { settings: { slowCrawlDealy: 2500 } },
    '../utils/Utils': { Utils: { sleep: async () => {} } },
    '../store/CacheWorkData': {
      cacheWorkData: {
        get: (id) => cached.get(id),
        set: (data) => cached.set(data.body.id, data),
      },
    },
    '../API': {
      API: {
        async getNovelData(id) {
          requests++
          return { body: { id } }
        },
      },
    },
    '../Log': { log: { error() {} } },
    '../Language': { lang: { transl: () => '' } },
    './MergeNovelFileName': { mergeNovelFileName: { getName: () => 'name' } },
  })
  function prepared(count) {
    const merge = new MergeNovel()
    merge.initMergeContext = () => ''
    merge.checkCanMergeSeries = async () => true
    merge.logMergeStart = merge.closeSettingsPanelOnSeriesPage = () => {}
    merge.tryGetNovelIds = async () => {
      merge.novelIdList = Array.from({ length: count }, (_, i) => String(i))
      return true
    }
    merge.enableSlowModeIfNeeded = () => {}
    merge.getAllNovelData = async () => {
      for (const id of merge.novelIdList) {
        if (merge.isCancelled()) return
        const data = await merge.fetchNovelData(id)
        if (data) merge.allNovelData.push(data)
      }
    }
    merge.loadGlossaryData = async () => {}
    merge.loadSeriesData = async () => ({ cover: { urls: { original: '' } } })
    merge.mergeByFormat =
      merge.downloadSeriesCoverFile =
      merge.saveMergedNovelDownloadRecords =
        async () => {}
    merge.logMergeFinished = merge.scheduleReset = () => {}
    return merge
  }
  return {
    prepared,
    cached,
    generation,
    states,
    revoke() {
      valid = false
    },
    requests: () => requests,
    permits: () => permits,
    parent: {
      valid: () => valid && !states.stopCrawl,
      async acquire() {
        permits++
        return valid
      },
    },
  }
}
test('nested MergeNovel uses parent exactly once for uncached novels, none for cached', async () => {
  const s = scheduler()
  const h = mergeHarness(s)
  h.cached.set('0', { body: { id: '0' } })
  assert.equal(
    await h.prepared(3).merge('series', '', true, h.generation, h.parent),
    3
  )
  assert.equal(h.permits(), 2)
  assert.equal(h.requests(), 2)
  assert.equal(s.messages.length, 0)
})
for (const count of [50, 51]) {
  test(`standalone manual MergeNovel ${count} shares scheduler and finishes`, async () => {
    const s = scheduler()
    const h = mergeHarness(s)
    assert.equal(await h.prepared(count).merge('series'), count)
    await flush()
    const registrations = s.messages.filter((m) => m.action === 'register')
    assert.equal(registrations.length, 1)
    assert.match(registrations[0].id, /^merge-novel:[\da-f-]+$/)
    assert.equal(registrations[0].workCount, count)
    const permits = s.messages.filter((m) => m.action === 'permit')
    assert.equal(permits.at(-1).now, count === 50 ? 0 : 50 * 1800)
    assert.equal(s.messages.filter((m) => m.action === 'finish').length, 1)
    assert.equal(Object.keys(s.state.sessions).length, 0)
  })
}
test('manual merge coordinates with active crawl and cleans up exceptions and early returns', async () => {
  const s = scheduler()
  const parent = new s.CrawlRateClient('active', '123', 1)
  await parent.permit(() => true)
  const h = mergeHarness(s)
  const merge = h.prepared(2)
  merge.loadGlossaryData = async () => {
    throw new Error('failure')
  }
  await assert.rejects(merge.merge('series'), /failure/)
  await flush()
  assert.equal(s.state.sessions.active.paced, true)
  assert.deepEqual(Object.keys(s.state.sessions), ['active'])
  assert.deepEqual(
    s.messages
      .filter((m) => m.action === 'permit' && m.id !== 'active' && m.now > 0)
      .map((m) => m.now),
    [1800, 1800, 3600]
  )
  const early = h.prepared(1)
  early.loadSeriesData = async () => null
  assert.equal(await early.merge('series'), 0)
  await flush()
  assert.deepEqual(Object.keys(s.state.sessions), ['active'])
  parent.finish()
})
test('revoked or stopped parent while MergeNovel waits issues no request or cache write', async () => {
  for (const stop of [false, true]) {
    const s = scheduler()
    const h = mergeHarness(s)
    h.parent.acquire = async () => {
      if (stop) h.states.stopCrawl = true
      else h.revoke()
      return true
    }
    assert.equal(
      await h.prepared(1).merge('series', '', true, h.generation, h.parent),
      0
    )
    assert.equal(h.requests(), 0)
    assert.equal(h.cached.size, 0)
    assert.equal(s.messages.length, 0)
  }
})
test('AutoMergeNovel forwards parent permit and generation, and cancellation blocks queue results', async () => {
  let forwarded
  let valid = true
  const generation = {}
  const permit = { valid: () => valid, acquire: async () => true }
  const { autoMergeNovel } = load(
    'src/ts/download/AutoMergeNovel.ts',
    {
      '../crawl/CrawlGeneration': { ownsCrawl: () => valid },
      '../EVT': { EVT: { list: {} } },
      './MergeNovel': {
        MergeNovel: class {
          async merge(...args) {
            forwarded = args
            valid = false
            return 2
          }
        },
      },
    },
    { window: { addEventListener() {} } }
  )
  autoMergeNovel.showTip = () => {}
  await autoMergeNovel.merge('series', 'title', true, generation, permit)
  assert.equal(forwarded[3], generation)
  assert.equal(forwarded[4], permit)
  assert.equal(autoMergeNovel.novelTotal, 0)
})
function searchHarness(s) {
  const generation = {}
  let current = generation
  const states = { stopCrawl: false }
  const store = { loggedUserID: '123', idList: [] }
  let requests = 0
  const settings = { BMKNumSwitch: true, BMKNumMin: 1 }
  const events = new EventTarget()
  const { vipSearchOptimize } = load(
    'src/ts/crawl/VipSearchOptimize.ts',
    {
      '../EVT': { EVT: { list: {} } },
      '../PageType': { pageType: { list: {} } },
      '../setting/Settings': { settings },
      '../API': {
        API: {
          async getArtworkData() {
            requests++
            return { body: { bookmarkCount: 2 } }
          },
          async getNovelData() {
            requests++
            return { body: { bookmarkCount: 2 } }
          },
        },
      },
    },
    { window: events }
  )
  vipSearchOptimize.vipSearchOptimize = true
  const { InitPageBase } = load(
    'src/ts/crawl/InitPageBase.ts',
    {
      './CrawlRateClient': s,
      './CrawlGeneration': { ownsCrawl: (g) => g === current },
      '../download/ManagedCrawlAutomation': {
        getManagedCrawl: () => undefined,
      },
      '../store/Store': { store },
      '../store/States': { states },
      '../EVT': { EVT: { list: {} } },
      './VipSearchOptimize': { vipSearchOptimize },
    },
    { window: events }
  )
  const page = new InitPageBase()
  page.generation = generation
  return {
    page,
    store,
    generation,
    states,
    requests: () => requests,
    revoke() {
      current = {}
    },
  }
}
test('VIP pre-count probes and final metadata keep one generation client: 50 fast, 51 paced', async () => {
  const s = scheduler()
  const h = searchHarness(s)
  await h.page.checkVipWork('1', 'illusts', h.generation)
  const client = h.page.rateSession.client
  h.store.idList.length = 50
  await h.page.checkVipWork('2', 'novels', h.generation)
  const id = s.messages[0].id
  assert.equal(s.state.sessions[id].paced, false)
  h.store.idList.length = 51
  await h.page.checkVipWork('3', 'illusts', h.generation)
  assert.equal(s.state.sessions[id].paced, true)
  h.page.ensureRateSession(h.generation, 100)
  await h.page.waitForMetadataPermit(h.generation)
  assert.equal(h.page.rateSession.client, client)
  assert.equal(new Set(s.messages.map((m) => m.id)).size, 1)
  assert.equal(h.requests(), 3)
  client.finish()
})
test('concurrent crawl promotes pre-count session; VIP revocation during wait blocks API', async () => {
  for (const stop of [false, true]) {
    const s = scheduler()
    const h = searchHarness(s)
    await h.page.checkVipWork('1', 'illusts', h.generation)
    const other = new s.CrawlRateClient('other', '123', 1)
    await flush()
    assert.equal(
      Object.values(s.state.sessions).every((session) => session.paced),
      true
    )
    h.page.crawlFinished = () => {
      h.page.rateSession.client.finish()
    }
    s.setSleep(() => {
      if (stop) h.states.stopCrawl = true
      else h.revoke()
    })
    await h.page.checkVipWork('2', 'novels', h.generation)
    assert.equal(h.requests(), 1)
    h.page.rateSession.client.finish()
    other.finish()
  }
})
test('BookmarkAllWorks bulk tag loop shares active scheduler and finishes, disabled tags create no session', async () => {
  for (const enabled of [true, false]) {
    const s = scheduler()
    const active = new s.CrawlRateClient('active', '123', 1)
    await active.permit(() => true)
    let requests = 0
    const settings = { widthTagBoolean: enabled, slowCrawlDealy: 2400 }
    const { BookmarkAllWorks } = load(
      'src/ts/pageFunciton/BookmarkAllWorks.ts',
      {
        '../crawl/CrawlRateClient': s,
        '../store/Store': { store: { loggedUserID: '123' } },
        '../setting/Settings': { settings },
        '../utils/Utils': { Utils: { sleep: async () => {} } },
        '../Tools': { Tools: { extractTags: () => ['tag'] } },
        '../API': {
          API: {
            async getArtworkData(id) {
              requests++
              return { body: { id } }
            },
            async getNovelData() {
              requests++
              throw new Error('404')
            },
          },
        },
      },
      { document: { createElement: () => ({}) } }
    )
    const bookmarks = new BookmarkAllWorks()
    bookmarks.idList = [
      { id: '1', type: 'illusts' },
      { id: '2', type: 'novels' },
    ]
    await bookmarks.getTagData()
    await flush()
    assert.equal(requests, enabled ? 2 : 0)
    assert.equal(bookmarks.bookmarKData.length, 2)
    assert.equal(
      s.messages.filter((m) => m.action === 'register').length,
      enabled ? 2 : 1
    )
    assert.deepEqual(Object.keys(s.state.sessions), ['active'])
    if (enabled) assert.equal(s.state.sessions.active.paced, true)
    active.finish()
  }
})
// 审计全部直接调用（包括动态 API 方法名），新调用必须显式分类。
const metadataAudit = {
  'crawl/InitPageBase.ts': ['already main-path coordinated', 2],
  'crawl/VipSearchOptimize.ts': ['coordinated bulk/crawl', 2],
  'download/MergeNovel.ts': ['coordinated bulk/crawl', 1],
  'pageFunciton/BookmarkAllWorks.ts': ['coordinated bulk/crawl', 2],
  'filter/WorkPublishTime.ts': ['coordinated bulk/crawl', 2],
  'store/CacheWorkData.ts': ['cache internals', 3],
  'Bookmark.ts': ['deliberately excluded one-off interactive UI', 2],
  'CopyWorkInfo.ts': ['deliberately excluded one-off interactive UI', 2],
  'ImageViewer.ts': ['deliberately excluded one-off interactive UI', 2],
  'PreviewWork.ts': ['deliberately excluded one-off interactive UI', 1],
  'PreviewWorkDetailInfo.ts': [
    'deliberately excluded one-off interactive UI',
    1,
  ],
  'ShowOriginSizeImage.ts': ['deliberately excluded one-off interactive UI', 2],
  'buttonsOnThumb/ButtonsOnArtworkPage.ts': [
    'deliberately excluded one-off interactive UI',
    1,
  ],
  'pageFunciton/QuickBookmark.ts': [
    'deliberately excluded one-off interactive UI',
    3,
  ],
  'pageFunciton/DisplayThumbnailListOnMultiImageWorkPage.ts': [
    'deliberately excluded one-off interactive UI',
    1,
  ],
}
test('all direct metadata producers are explicitly classified by source audit', () => {
  const found = {}
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'static') continue
      const file = `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        scan(file)
        continue
      }
      if (!file.endsWith('.ts')) continue
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      )
      let count = 0
      function visit(node) {
        // 动态条件表达式的两个方法名字各计一次，实际仍是一个请求点。
        if (
          ts.isStringLiteral(node) &&
          ['getNovelData', 'getArtworkData'].includes(node.text)
        )
          count++
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ['getNovelData', 'getArtworkData', 'getWorkDataAsync'].includes(
            node.expression.name.text
          )
        )
          count++
        ts.forEachChild(node, visit)
      }
      visit(source)
      if (count) found[file.slice('src/ts/'.length)] = count
    }
  }
  scan('src/ts')
  assert.deepEqual(
    found,
    Object.fromEntries(
      Object.entries(metadataAudit).map(([file, [, count]]) => [file, count])
    )
  )
})
test('nested expanded series promotes original parent session and cached novels skip shared permits', async () => {
  const s = scheduler()
  const search = searchHarness(s)
  search.page.ensureRateSession(search.generation, 1)
  const client = search.page.rateSession.client
  const h = mergeHarness(s)
  const permit = search.page.metadataPermit(search.generation)
  // 使用同一个父代数与许可，完整 merge 流程展开 51 篇缓存小说。
  for (let i = 0; i < 51; i++)
    h.cached.set(String(i), { body: { id: String(i) } })
  await h.prepared(51).merge('series', '', true, undefined, permit)
  await flush()
  const id = s.messages[0].id
  assert.equal(s.state.sessions[id].paced, true)
  assert.equal(Object.keys(s.state.sessions).length, 1)
  assert.equal(search.page.rateSession.client, client)
  assert.equal(s.messages.filter((m) => m.action === 'permit').length, 0)
  client.finish()
})
test('work-count promotion submitted during registration is awaited before first permit', async () => {
  const s = scheduler()
  const client = new s.CrawlRateClient('pre-count', '123', 1)
  client.updateWorkCount(50)
  client.updateWorkCount(51)
  await client.permit(() => true)
  assert.equal(s.state.sessions['pre-count'].paced, true)
  const firstPermit = s.messages.findIndex((m) => m.action === 'permit')
  assert.ok(s.messages.slice(0, firstPermit).some((m) => m.workCount === 51))
  assert.equal(new Set(s.messages.map((m) => m.id)).size, 1)
  client.updateWorkCount(1)
  assert.equal(s.state.sessions['pre-count'].paced, true)
  client.finish()
})
test('publish-time maintenance bulk task paces retries and closes its session', async () => {
  const s = scheduler()
  let requests = 0
  let maintenance
  const { workPublishTime } = load(
    'src/ts/filter/WorkPublishTime.ts',
    {
      '../crawl/CrawlRateClient': s,
      '../store/Store': { store: { loggedUserID: '123' } },
      '../PPDTask': {
        ppdTask: {
          register(id, name, run) {
            maintenance = run
          },
        },
      },
      '../store/WorkPublishTimeIllusts': { illustsData: [[20, 0]] },
      '../store/WorkPublishTimeNovels': { novelsData: [[129, 0]] },
      '../utils/Utils': {
        Utils: { sleep: async () => {}, json2BlobSafe: async () => [] },
      },
      '../Log': { log: { log() {}, success() {}, error() {} } },
      '../API': {
        API: {
          async getNewIllustData() {
            return { body: { illusts: [{ id: '20001' }] } }
          },
          async getNewNovelData() {
            return { body: { novels: [{ id: '20001' }] } }
          },
          async getArtworkData() {
            if (++requests === 1) throw new Error('404')
            return { error: false, body: { createDate: '2026-01-01' } }
          },
          async getNovelData() {
            requests++
            return { error: false, body: { createDate: '2026-01-01' } }
          },
        },
      },
    },
    { console: { log() {} } }
  )
  assert.equal(typeof maintenance, 'function')
  await maintenance()
  await flush()
  assert.equal(requests, 5)
  assert.equal(
    s.messages.filter((m) => m.action === 'permit' && m.granted).length,
    5
  )
  assert.equal(s.messages.filter((m) => m.action === 'finish').length, 2)
  assert.equal(Object.keys(s.state.sessions).length, 0)
  workPublishTime.crawlWork = async () => {
    throw new Error('unexpected')
  }
  await assert.rejects(workPublishTime.crawlData('illusts'), /unexpected/)
  await flush()
  assert.equal(Object.keys(s.state.sessions).length, 0)
})
test('nested MergeNovel cancellation during actual scheduler wait makes no metadata request', async () => {
  const s = scheduler()
  const h = mergeHarness(s)
  const parent = new s.CrawlRateClient('parent', '123', 51)
  await parent.permit(() => true)
  const permit = {
    valid: h.parent.valid,
    acquire: () => parent.permit(h.parent.valid),
  }
  s.setSleep(() => h.revoke())
  assert.equal(
    await h.prepared(1).merge('series', '', true, h.generation, permit),
    0
  )
  assert.equal(h.requests(), 0)
  assert.equal(h.cached.size, 0)
  assert.equal(s.messages.filter((m) => m.action === 'register').length, 1)
  parent.finish()
})
test('two unique nested expansions cumulatively pace the same parent before second metadata', async () => {
  const s = scheduler()
  const search = searchHarness(s)
  search.page.ensureRateSession(search.generation, 2)
  const client = search.page.rateSession.client
  const h = mergeHarness(s)
  const permit = search.page.metadataPermit(search.generation)
  await h.prepared(30).merge('first', '', true, undefined, permit)
  const id = s.messages[0].id
  assert.equal(s.state.sessions[id].paced, false)
  assert.equal(h.requests(), 30)
  // 第二个系列包含缓存作品；展开仍预留全部数量，但缓存不申请许可。
  h.cached.delete('0')
  const before = s.messages.length
  await h.prepared(30).merge('second', '', true, undefined, permit)
  const second = s.messages.slice(before)
  assert.equal(second.find((m) => m.action === 'register').workCount, 62)
  assert.ok(
    second.findIndex((m) => m.action === 'register') <
      second.findIndex((m) => m.action === 'permit')
  )
  assert.equal(s.state.sessions[id].paced, true)
  assert.equal(
    second.filter((m) => m.action === 'permit' && m.granted).length,
    1
  )
  assert.equal(h.requests(), 31)
  assert.equal(new Set(s.messages.map((m) => m.id)).size, 1)
  assert.equal(search.page.rateSession.client, client)
  client.finish()
})
test('actual post-merge accounting counts only successful owned merges and finalizes stopped crawls', async () => {
  // 提取实际方法，避免复制其停止/所有权判断。
  const source = ts.createSourceFile(
    'base.ts',
    fs.readFileSync('src/ts/crawl/InitPageBase.ts', 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const base = source.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name.text === 'InitPageBase'
  )
  const method = base.members.find(
    (node) => node.name?.getText(source) === 'getWorksData'
  )
  const code = ts.transpileModule(`class Page { ${method.getText(source)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  for (const type of ['novels', 'novelSeries']) {
    for (const scenario of [
      { success: false, stopped: true, superseded: false },
      { success: false, stopped: false, superseded: false },
      { success: true, stopped: false, superseded: false },
      { success: true, stopped: true, superseded: false },
      { success: true, stopped: true, superseded: true },
    ]) {
      const { success, stopped, superseded } = scenario
      const generation = {}
      let current = true
      let finalized = 0
      let advanced = 0
      const states = { stopCrawl: false }
      const merge = async () => {
        assert.equal(page.mergedNovelCount, 0)
        states.stopCrawl = stopped
        current = !superseded
        return type === 'novels' ? success : success ? 2 : 0
      }
      const Page = vm.runInNewContext(`${code}\nPage`, {
        ownsCrawl: (g) => g === generation && current,
        states,
        filter: { check: async () => true },
        Tools: { getWorkTypeVague: () => 'novels' },
        pageType: { type: 0, list: {} },
        cacheWorkData: {
          get: () => ({ body: { seriesNavData: { seriesId: 'series' } } }),
        },
        settings: {
          autoMergeNovel: true,
          skipNovelsInSeriesWhenAutoMerge: true,
        },
        autoMergeNovel: { merge },
        MergeNovel: class {
          merge = merge
        },
      })
      const page = new Page()
      page.mergedNovelCount = 0
      page.metadataPermit = () => ({})
      page.crawlFinished = (g) => {
        assert.equal(g, generation)
        finalized++
      }
      page.afterGetWorksData = () => advanced++
      await page.getWorksData({ id: '1', type }, generation)
      assert.equal(
        finalized,
        !superseded && stopped ? 1 : 0,
        `${type}: superseded=${superseded}`
      )
      assert.equal(advanced, !superseded && !stopped ? 1 : 0)
      assert.equal(page.mergedNovelCount, success && !superseded ? 1 : 0)
    }
  }
})
test('AutoMergeNovel dedup reserves a unique series only once', async () => {
  const s = scheduler()
  const h = mergeHarness(s)
  const client = new s.CrawlRateClient('parent-dedup', '123', 2)
  const permit = {
    valid: () => true,
    acquire: () => client.permit(() => true),
    addWorkCount: (delta) => client.addWorkCount(delta),
  }
  const { autoMergeNovel } = load(
    'src/ts/download/AutoMergeNovel.ts',
    {
      '../EVT': { EVT: { list: {} } },
      './MergeNovel': {
        MergeNovel: class {
          constructor() {
            return h.prepared(30)
          }
        },
      },
    },
    { window: { addEventListener() {} } }
  )
  autoMergeNovel.showTip = () => {}
  await autoMergeNovel.merge('unique', '', true, undefined, permit)
  await autoMergeNovel.merge('unique', '', true, undefined, permit)
  await flush()
  assert.deepEqual(
    s.messages.filter((m) => m.action === 'register').map((m) => m.workCount),
    [2, 32]
  )
  assert.equal(h.requests(), 30)
  client.finish()
})
test('additive reservations queued before first permit preserve cumulative budget and identity', async () => {
  const s = scheduler()
  const client = new s.CrawlRateClient('queued-additions', '123', 2)
  client.addWorkCount(30)
  client.addWorkCount(30)
  client.updateWorkCount(50)
  await client.permit(() => true)
  const firstPermit = s.messages.findIndex((m) => m.action === 'permit')
  assert.equal(s.messages[firstPermit - 1].workCount, 62)
  assert.equal(s.state.sessions['queued-additions'].paced, true)
  assert.equal(new Set(s.messages.map((m) => m.id)).size, 1)
  client.finish()
})

test('AutoMergeNovel duplicate waiters reuse success, zero and cancellation results without merging twice', async () => {
  for (const outcome of ['success', 'zero', 'stop', 'superseded', 'cancel']) {
    let valid = true
    let current = true
    let calls = 0
    let finish
    let wake
    const events = new EventTarget()
    const generation = {}
    const permit = { valid: () => valid, acquire: async () => true }
    const { autoMergeNovel } = load(
      'src/ts/download/AutoMergeNovel.ts',
      {
        '../crawl/CrawlGeneration': { ownsCrawl: () => current },
        '../EVT': { EVT: { list: { crawlStart: 'start' } } },
        '../utils/Utils': {
          Utils: {
            sleep: () =>
              new Promise((resolve) => {
                wake = resolve
              }),
          },
        },
        './MergeNovel': {
          MergeNovel: class {
            async merge() {
              calls++
              return new Promise((resolve) => {
                finish = resolve
              })
            }
          },
        },
      },
      { window: events }
    )
    autoMergeNovel.showTip = () => {}
    const first = autoMergeNovel.merge('series', '', true, generation, permit)
    await flush()
    const duplicate = autoMergeNovel.merge(
      'series',
      '',
      false,
      generation,
      permit
    )
    await flush()
    assert.equal(calls, 1)
    if (outcome === 'stop') autoMergeNovel.stop = true
    if (outcome === 'superseded') current = false
    if (outcome === 'cancel') valid = false
    finish(outcome === 'zero' ? 0 : 2)
    const expected = outcome === 'success'
    assert.equal(await first, expected)
    wake()
    assert.equal(await duplicate, expected)
    assert.equal(
      await autoMergeNovel.merge('series', '', false, generation, permit),
      expected
    )
    assert.equal(calls, 1)
    if (outcome === 'success' || outcome === 'zero') {
      assert.deepEqual(Array.from(autoMergeNovel.completedQueue), ['series'])
      assert.equal(autoMergeNovel.novelTotal, expected ? 2 : 0)
    }
    events.dispatchEvent(new Event('start'))
    assert.equal(autoMergeNovel.successfulSeries.size, 0)
  }
})
