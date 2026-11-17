const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

function load(file, dependencies = {}, globals = {}) {
  const exports = {}
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  vm.runInNewContext(`(function(require, exports){${js}\n})`, {
    console,
    setTimeout,
    clearTimeout,
    ...globals,
  })((name) => dependencies[name] ?? {}, exports)
  return exports
}

const { SearchListPageBudget } = load('src/ts/crawl/SearchListPageBudget.ts')
const url = 'https://www.pixiv.net/tags/test/illustrations?p=1'

test('bounded allocation and duplicate callbacks never produce 2/1', () => {
  const budget = new SearchListPageBudget(1, 1, url)
  assert.equal(budget.claim(), 1)
  assert.equal(budget.claim(), undefined)
  assert.equal(budget.claim(1), undefined)
  assert.equal(budget.complete(1), true)
  assert.equal(budget.complete(1), false)
  assert.equal(budget.finishedCount, 1)
  assert.equal(budget.isComplete(), true)
  assert.equal(budget.canScheduleNext(), false)
  assert.equal(budget.claim(2), undefined)
})

test('failed page may retry once, and distinct pages count once each', () => {
  const budget = new SearchListPageBudget(4, 2, url)
  assert.equal(budget.claim(), 4)
  budget.abandon(4)
  assert.equal(budget.claim(4), 4)
  assert.equal(budget.complete(4), true)
  assert.equal(budget.finishedCount, 1)
  assert.equal(budget.claim(), 5)
  assert.equal(budget.complete(5), true)
  assert.equal(budget.isComplete(), true)
  assert.equal(budget.finishedCount, 2)
  assert.equal(budget.claim(), undefined)
  assert.equal(budget.claim(4), undefined)
})

test('navigation and cancellation invalidate old callbacks', () => {
  const budget = new SearchListPageBudget(1, 1, url)
  assert.equal(budget.claim(), 1)
  assert.equal(budget.accepts(url + '&p=2'), false)
  budget.cancel()
  assert.equal(budget.accepts(url), false)
  assert.equal(budget.complete(1), false)
  assert.equal(budget.finishedCount, 0)
  assert.equal(budget.claim(1), undefined)
})

for (const [label, file, exportName] of [
  [
    'artwork',
    'src/ts/crawlArtworkPage/InitSearchArtworkPage.ts',
    'InitSearchArtworkPage',
  ],
  [
    'novel',
    'src/ts/crawlNovelPage/InitSearchNovelPage.ts',
    'InitSearchNovelPage',
  ],
]) {
  function makeHarness() {
    let requestCount = 0
    let completions = 0
    const events = []
    const settings = {
      slowCrawl: false,
      slowCrawlDealy: 0,
      previewResult: false,
    }
    const states = {
      stopCrawl: false,
      slowCrawlMode: false,
      timedCrawlMode: false,
    }
    const store = { idList: [], tag: 'test' }
    const window = {
      location: { href: url },
      removeEventListener() {},
      clearInterval() {},
    }
    const response = (page = 1) => ({
      total: 60,
      data: [{ id: String(page), illustType: 0 }],
    })
    const dependencies = {
      '../crawl/InitPageBase': {
        InitPageBase: class {
          init() {}
        },
      },
      '../crawl/CrawlGeneration': {
        ownsCrawl: (generation) => generation === 99,
      },
      '../crawl/SearchListPageBudget': { SearchListPageBudget },
      '../filter/Filter': { filter: { check: async () => true } },
      '../store/Store': { store },
      '../store/States': { states },
      '../Language': { lang: { transl: (...args) => args.join(':') } },
      '../Tools': {
        Tools: { getWorkTypeString: () => 'illusts', clearSlot() {} },
      },
      '../Log': { log: { log() {}, error() {}, warning() {} } },
      '../EVT': {
        EVT: {
          fire: (evt) => events.push(evt),
          list: { pageSwitch: 'pageSwitch' },
        },
      },
      '../utils/Utils': {
        Utils: { sleep: async () => {}, debounce: (fn) => fn },
      },
      '../Config': { Config: { retryTime: 0 } },
      '../setting/Settings': { settings },
      '../pageFunciton/FastScreen': { FastScreen: class {} },
      '../crawlMixedPage/CrawlTagList': { crawlTagList: { init() {} } },
    }
    const Klass = load(file, dependencies, {
      window,
      document: { createDocumentFragment: () => ({}) },
    })[exportName]
    const instance = new Klass()
    instance.generation = 99
    instance.crawlUrl = url
    instance.startpageNo = 1
    instance.crawlNumber = 1
    instance.needCrawlPageCount = 1
    instance.pageBudget = new SearchListPageBudget(1, 1, url)
    instance.getSearchData = async (page) => {
      requestCount++
      return response(page)
    }
    instance.getIdListFinished = () => {
      completions++
      instance.resetGetIdListStatus()
    }
    return {
      instance,
      response,
      window,
      states,
      store,
      events,
      requests: () => requestCount,
      completions: () => completions,
    }
  }

  test(`${label}: preloaded first page counts exactly once without refetch`, async () => {
    const h = makeHarness()
    await h.instance.getIdList(undefined, h.response())
    assert.equal(h.requests(), 0)
    assert.equal(h.completions(), 1)
    assert.deepEqual(
      Array.from(h.store.idList, (item) => item.id),
      ['1']
    )
    assert.equal(h.instance.listPageFinished, 0) // reset by completion
  })

  test(`${label}: simultaneous duplicate callback cannot double-fetch IDs`, async () => {
    const h = makeHarness()
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    h.instance.getSearchData = async (page) => {
      await gate
      return h.response(page)
    }
    const first = h.instance.getIdList()
    const duplicate = h.instance.getIdList(1)
    release()
    await Promise.all([first, duplicate])
    assert.equal(h.completions(), 1)
    assert.deepEqual(
      Array.from(h.store.idList, (item) => item.id),
      ['1']
    )
  })

  test(`${label}: navigation rejects late response and aborts crawl`, async () => {
    const h = makeHarness()
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    h.instance.getSearchData = async (page) => {
      await gate
      return h.response(page)
    }
    const pending = h.instance.getIdList()
    h.window.location.href = url.replace('p=1', 'p=2')
    h.instance.stopForNavigation()
    release()
    await pending
    assert.equal(h.states.stopCrawl, true)
    assert.deepEqual(h.events, ['stopCrawl'])
    assert.equal(h.completions(), 0)
    assert.equal(h.store.idList.length, 0)
  })

  test(`${label}: category switch during crawl is stopped in destroy`, async () => {
    const h = makeHarness()
    h.window.location.href = url.replace('/illustrations', '/novels')
    h.instance.destroy()
    assert.equal(h.states.stopCrawl, true)
    assert.deepEqual(h.events, ['stopCrawl'])
    assert.equal(h.instance.pageBudget.finishedCount, 0)
    assert.equal(h.instance.pageBudget.claim(1), undefined)
  })

  test(`${label}: two-page crawl stops at the second unique page`, async () => {
    const h = makeHarness()
    const requested = []
    h.instance.needCrawlPageCount = 2
    h.instance.pageBudget = new SearchListPageBudget(1, 2, url)
    h.instance.getSearchData = async (page) => {
      requested.push(page)
      return h.response(page)
    }
    await h.instance.getIdList()
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(requested, [1, 2])
    assert.deepEqual(
      Array.from(h.store.idList, (item) => item.id),
      ['1', '2']
    )
    assert.equal(h.completions(), 1)
  })

  test(`${label}: navigation during page-count lookup prevents ID collection`, async () => {
    const h = makeHarness()
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    h.instance.pageBudget = undefined
    h.instance.setSlowCrawl = () => {}
    h.instance.initFetchURL = () => {}
    h.instance.getSearchData = async () => {
      await gate
      return h.response()
    }
    const pending = h.instance.nextStep()
    h.window.location.href = url.replace('p=1', 'p=2')
    h.instance.stopForNavigation()
    release()
    await pending
    assert.equal(h.completions(), 0)
    assert.equal(h.store.idList.length, 0)
    assert.equal(h.instance.pageBudget, undefined)
    assert.equal(h.states.stopCrawl, true)
  })

  test(`${label}: one retry cannot extend a one-page limit`, async () => {
    const h = makeHarness()
    let attempts = 0
    h.instance.getSearchData = async (page) => {
      attempts++
      if (attempts === 1) throw new Error('temporary failure')
      return h.response(page)
    }
    await h.instance.getIdList()
    await new Promise((r) => setImmediate(r))
    assert.equal(attempts, 2)
    assert.equal(h.completions(), 1)
    assert.deepEqual(
      Array.from(h.store.idList, (item) => item.id),
      ['1']
    )
  })
}
