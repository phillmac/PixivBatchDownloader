const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')

function harness(controller, durable) {
  const location = { href: 'https://www.pixiv.net/en/users/1' }
  const store = { URLWhenCrawlStart: location.href, idList: [] }
  const states = {
    busy: false,
    bookmarkMode: false,
    exportIDList: false,
    stopCrawl: false,
  }
  const diagnostics = {
    automationSnapshot() {
      return controller
    },
    pageSnapshot() {
      throw new Error(
        'automation status must not build the full diagnostic snapshot'
      )
    },
  }
  const discardCalls = []
  const resume = {
    async getSavedTaskStatus() {
      return typeof durable === 'function' ? durable() : durable
    },
    async discardSavedTask(url) {
      discardCalls.push(url)
      return { discarded: true, url, taskId: 123 }
    },
  }
  const listeners = new Map()
  const EVT = {
    fire(name, data) {
      for (const callback of listeners.get(name) || [])
        callback({ type: name, detail: { data } })
    },
    list: {
      importResultLoaded: 'importResultLoaded',
      crawlStart: 'crawlStart',
      crawlComplete: 'crawlComplete',
      crawlEmpty: 'crawlEmpty',
      stopCrawl: 'stopCrawl',
      managedCrawlAbortComplete: 'managedCrawlAbortComplete',
      getIdListFinished: 'getIdListFinished',
      resultChange: 'resultChange',
      downloadStart: 'downloadStart',
      downloadComplete: 'downloadComplete',
      downloadPause: 'downloadPause',
      downloadStop: 'downloadStop',
      resume: 'resume',
    },
  }
  const window = {
    location,
    addEventListener(name, callback) {
      const callbacks = listeners.get(name) || []
      callbacks.push(callback)
      listeners.set(name, callbacks)
    },
  }
  const context = vm.createContext({ console, Date, window, queueMicrotask })
  const file = path.join(root, 'src/ts/download/AutomationStatus.ts')
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const generation = {}
  const generationCode = ts.transpileModule(
    fs.readFileSync(path.join(root, 'src/ts/crawl/CrawlGeneration.ts'), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }
  ).outputText
  vm.runInContext(
    '(function(exports) {' + generationCode + '\n})',
    context
  )(generation)
  const managed = {}
  const managedFile = path.join(
    root,
    'src/ts/download/ManagedCrawlAutomation.ts'
  )
  const managedCode = ts.transpileModule(fs.readFileSync(managedFile, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  vm.runInContext(`(function(require, exports) {${managedCode}\n})`, context)(
    (name) => {
      if (name === '../crawl/CrawlGeneration') return generation
      if (name === './Resume') return { resume }
      if (name === '../EVT') return { EVT }
      if (name === '../store/Store') return { store }
      if (name === '../store/States') return { states }
      throw new Error(name)
    },
    managed
  )
  const exports = {}
  vm.runInContext(`(function(require, exports) {${compiled}\n})`, context, {
    filename: file,
  })((name) => {
    if (name === './ManagedCrawlAutomation') return managed
    if (name === './DownloadDiagnostics')
      return { downloadDiagnostics: diagnostics }
    if (name === './Resume') return { resume }
    if (name === '../EVT') return { EVT }
    if (name === '../store/Store') return { store }
    if (name === '../store/States') return { states }
    throw new Error(`unexpected require ${name}`)
  }, exports)
  return {
    exports,
    managed,
    generation,
    EVT,
    context,
    store,
    states,
    controller,
    discardCalls,
    fire(name, begin = true) {
      if (name === 'crawlStart' && begin) generation.beginCrawl()
      for (const callback of listeners.get(name) || []) callback()
    },
  }
}

test('durable task with unloaded live results reports RESTORING', async () => {
  const h = harness(
    {
      busy: false,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 0,
    },
    { total: 7 }
  )
  assert.equal((await h.exports.getAutomationStatus()).phase, 'RESTORING')
})

test('restored paused task reports PAUSED_RESUMABLE', async () => {
  const h = harness(
    {
      busy: false,
      downloading: false,
      pause: true,
      stop: false,
      resultLength: 7,
    },
    { total: 7 }
  )
  h.fire('resume')
  assert.equal(
    (await h.exports.getAutomationStatus()).phase,
    'PAUSED_RESUMABLE'
  )
})

test('live controller phases win over durable state', async () => {
  let h = harness(
    {
      busy: true,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 0,
    },
    null
  )
  assert.equal((await h.exports.getAutomationStatus()).phase, 'BUSY_OTHER')
  h.fire('crawlStart')
  assert.equal((await h.exports.getAutomationStatus()).phase, 'CRAWLING')
  h = harness(
    {
      busy: true,
      downloading: true,
      pause: false,
      stop: false,
      resultLength: 7,
    },
    { total: 7 }
  )
  assert.equal((await h.exports.getAutomationStatus()).phase, 'DOWNLOADING')
})

test('bookmark batches are reported separately from crawls', async () => {
  const h = harness(
    {
      busy: true,
      downloading: false,
      bookmarkMode: true,
      pause: false,
      stop: false,
      resultLength: 0,
    },
    null
  )
  assert.equal((await h.exports.getAutomationStatus()).phase, 'BOOKMARKING')
})

test('ready results and empty controller report READY and IDLE', async () => {
  let h = harness(
    {
      busy: false,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 3,
    },
    null
  )
  assert.equal((await h.exports.getAutomationStatus()).phase, 'IDLE')
  h.fire('crawlComplete')
  assert.equal((await h.exports.getAutomationStatus()).phase, 'READY')
  h = harness(
    {
      busy: false,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 0,
    },
    null
  )
  assert.equal((await h.exports.getAutomationStatus()).phase, 'IDLE')
  h = harness(
    {
      busy: false,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 3,
    },
    null
  )
  h.fire('crawlComplete')
  h.fire('downloadComplete')
  assert.equal((await h.exports.getAutomationStatus()).phase, 'IDLE')
})

test('lifecycle observations are URL-scoped across Pixiv SPA navigation', async () => {
  const h = harness(
    {
      busy: false,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 3,
    },
    null
  )
  h.fire('crawlComplete')
  assert.equal((await h.exports.getAutomationStatus()).phase, 'READY')
  h.context.window.location.href = 'https://www.pixiv.net/en/users/1/manga'
  const moved = await h.exports.getAutomationStatus()
  assert.equal(moved.phase, 'IDLE')
  assert.equal(
    moved.lifecycle.crawlCompleted.url,
    'https://www.pixiv.net/en/users/1'
  )
})

test('pre-metadata ID list boundary exposes lightweight count and detached IDs', async () => {
  const h = harness(
    {
      busy: true,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 0,
    },
    null
  )
  h.fire('crawlStart')
  h.store.idList = [
    { id: '101', type: 'illusts', title: 'ignored' },
    { id: '202', type: 'novelSeries', downloadIndexes: [0, 2] },
  ]
  h.fire('getIdListFinished')

  const status = await h.exports.getAutomationStatus()
  assert.equal(status.phase, 'CRAWLING')
  assert.equal(status.crawlIdList.count, 2)
  assert.equal(status.crawlIdList.url, 'https://www.pixiv.net/en/users/1')
  assert.equal('items' in status.crawlIdList, false)

  const first = h.exports.getAutomationCrawlIdList()
  assert.equal(first.schemaVersion, 1)
  assert.equal(first.count, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(first.items)), [
    { id: '101', type: 'illusts' },
    { id: '202', type: 'novelSeries' },
  ])

  h.store.idList[0].id = 'mutated-store'
  first.items[1].id = 'mutated-return-value'
  const second = h.exports.getAutomationCrawlIdList()
  assert.equal(second.items[0].id, '101')
  assert.equal(second.items[1].id, '202')
})

test('pre-armed ID gate rejects oversized crawls synchronously before metadata', async () => {
  const h = harness(
    {
      busy: true,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 0,
    },
    null
  )
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.exports.setAutomationCrawlIdGate(1))),
    { armed: true, maxCount: 1 }
  )
  h.fire('crawlStart')
  h.store.idList = [
    { id: '401', type: 'illusts' },
    { id: '402', type: 'manga' },
  ]
  h.fire('getIdListFinished')

  assert.equal(h.states.exportIDList, true)
  const status = await h.exports.getAutomationStatus()
  assert.deepEqual(JSON.parse(JSON.stringify(status.crawlIdList.gate)), {
    maxCount: 1,
    decision: 'rejected',
    reason: 'count-exceeded',
  })
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.exports.getAutomationCrawlIdList().gate)),
    { maxCount: 1, decision: 'rejected', reason: 'count-exceeded' }
  )

  h.fire('stopCrawl')
  assert.equal(h.states.exportIDList, false)
})

test('pre-armed ID gate accepts within-limit crawls without arming early stop', async () => {
  const h = harness(
    {
      busy: true,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 0,
    },
    null
  )
  h.exports.setAutomationCrawlIdGate(2)
  h.fire('crawlStart')
  h.store.idList = [{ id: '501', type: 'novels' }]
  h.fire('getIdListFinished')

  assert.equal(h.states.exportIDList, false)
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.exports.getAutomationCrawlIdList().gate)),
    { maxCount: 2, decision: 'accepted', reason: null }
  )
})

test('crawl ID gate rejects novel series when expanded size is unknown', () => {
  const h = harness(
    {
      busy: false,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 0,
    },
    null
  )
  h.exports.setAutomationCrawlIdGate(100)
  h.fire('crawlStart')
  h.store.idList = [{ id: '777', type: 'novelSeries' }]
  h.fire('getIdListFinished')

  assert.equal(h.states.exportIDList, true)
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.exports.getAutomationCrawlIdList().gate)),
    {
      maxCount: 100,
      decision: 'rejected',
      reason: 'novel-series-size-unknown',
    }
  )
})

test('manual crawl stop is exposed as URL-scoped lifecycle state', async () => {
  const h = harness(
    {
      busy: false,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 3,
    },
    null
  )
  h.fire('crawlStart')
  h.fire('stopCrawl')
  let status = await h.exports.getAutomationStatus()
  assert.equal(
    status.lifecycle.crawlStopped.url,
    'https://www.pixiv.net/en/users/1'
  )
  assert.ok(status.lifecycle.crawlStopped.at)

  h.context.window.location.href = 'https://www.pixiv.net/en/users/1#works'
  status = await h.exports.getAutomationStatus()
  assert.equal(
    status.lifecycle.crawlStopped.url,
    'https://www.pixiv.net/en/users/1'
  )

  h.fire('crawlStart')
  status = await h.exports.getAutomationStatus()
  assert.equal(status.lifecycle.crawlStopped, null)
})

test('late ID completion after manual crawl stop discards the gate without leaking export state', () => {
  const h = harness(
    {
      busy: false,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 0,
    },
    null
  )
  h.exports.setAutomationCrawlIdGate(1)
  h.fire('crawlStart')

  // StopCrawl fires the event before it flips states.stopCrawl. Simulate an ID filter
  // finishing afterwards; that late completion must not re-arm the transient stop flag.
  h.fire('stopCrawl')
  h.states.stopCrawl = true
  h.store.idList = [
    { id: '801', type: 'illusts' },
    { id: '802', type: 'illusts' },
  ]
  h.fire('getIdListFinished')

  assert.equal(h.states.exportIDList, false)
  assert.equal(h.exports.getAutomationCrawlIdList(), null)

  h.states.stopCrawl = false
  h.states.busy = false
  h.exports.setAutomationCrawlIdGate(1)
  h.fire('crawlStart')
  h.store.idList = [
    { id: '803', type: 'illusts' },
    { id: '804', type: 'illusts' },
  ]
  h.fire('getIdListFinished')
  assert.equal(h.states.exportIDList, true)
})

test('bookmark-only ID completion neither consumes the gate nor creates a crawl snapshot', async () => {
  const h = harness(
    {
      busy: false,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 0,
    },
    null
  )
  h.exports.setAutomationCrawlIdGate(1)
  h.states.bookmarkMode = true
  h.store.idList = [
    { id: '601', type: 'illusts' },
    { id: '602', type: 'illusts' },
  ]
  h.fire('getIdListFinished')
  assert.equal(h.exports.getAutomationCrawlIdList(), null)
  assert.equal(h.states.exportIDList, false)

  h.states.bookmarkMode = false
  h.fire('crawlStart')
  h.store.idList = [
    { id: '603', type: 'illusts' },
    { id: '604', type: 'illusts' },
  ]
  h.fire('getIdListFinished')
  assert.equal(h.states.exportIDList, true)
  assert.equal(h.exports.getAutomationCrawlIdList().gate.decision, 'rejected')
  assert.equal(
    h.exports.getAutomationCrawlIdList().gate.reason,
    'count-exceeded'
  )
})

test('crawl ID gate validates configuration and refuses mid-task mutation', () => {
  const h = harness(
    {
      busy: false,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 0,
    },
    null
  )
  assert.throws(
    () => h.exports.setAutomationCrawlIdGate(-1),
    /maxCount must be a non-negative safe integer or null/
  )
  assert.throws(
    () => h.exports.setAutomationCrawlIdGate(1.5),
    /maxCount must be a non-negative safe integer or null/
  )
  h.states.busy = true
  assert.throws(
    () => h.exports.setAutomationCrawlIdGate(10),
    /cannot configure crawl ID gate while downloader is busy/
  )
})

test('harvested ID list is URL scoped and cleared by the next crawl start', async () => {
  const h = harness(
    {
      busy: true,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 0,
    },
    null
  )
  h.fire('crawlStart')
  h.store.idList = [{ id: '303', type: 'manga' }]
  h.fire('getIdListFinished')
  assert.equal(h.exports.getAutomationCrawlIdList().count, 1)

  h.context.window.location.href = 'https://www.pixiv.net/en/users/1/manga'
  assert.equal(h.exports.getAutomationCrawlIdList(), null)
  assert.equal((await h.exports.getAutomationStatus()).crawlIdList, null)

  h.context.window.location.href = 'https://www.pixiv.net/en/users/1'
  assert.equal(h.exports.getAutomationCrawlIdList().count, 1)
  h.fire('crawlStart')
  assert.equal(h.exports.getAutomationCrawlIdList(), null)
  assert.equal((await h.exports.getAutomationStatus()).crawlIdList, null)
})

test('durable task stays RESTORING until the current URL resumes', async () => {
  const h = harness(
    {
      busy: false,
      downloading: false,
      pause: true,
      stop: false,
      resultLength: 7,
    },
    { total: 7 }
  )
  h.fire('crawlComplete')
  h.context.window.location.href = 'https://www.pixiv.net/en/users/1/manga'
  assert.equal((await h.exports.getAutomationStatus()).phase, 'RESTORING')
  h.fire('resume')
  assert.equal(
    (await h.exports.getAutomationStatus()).phase,
    'PAUSED_RESUMABLE'
  )
})

test('stopped state is scoped to the URL where stop occurred', async () => {
  const h = harness(
    {
      busy: false,
      downloading: false,
      pause: false,
      stop: true,
      resultLength: 3,
    },
    null
  )
  h.fire('downloadStop')
  assert.equal((await h.exports.getAutomationStatus()).phase, 'STOPPED')
  h.context.window.location.href = 'https://www.pixiv.net/en/users/1/novels'
  assert.equal((await h.exports.getAutomationStatus()).phase, 'IDLE')
})

test('download completion stays attributed to the original task URL across SPA navigation', async () => {
  const controller = {
    busy: false,
    downloading: false,
    pause: false,
    stop: false,
    resultLength: 3,
  }
  const h = harness(controller, null)
  const taskUrl = h.context.window.location.href
  h.store.URLWhenCrawlStart = taskUrl
  h.fire('crawlComplete')
  assert.equal((await h.exports.getAutomationStatus()).phase, 'READY')
  controller.busy = true
  controller.downloading = true
  h.fire('downloadStart')
  h.context.window.location.href = 'https://www.pixiv.net/en/users/1/manga'
  controller.busy = false
  controller.downloading = false
  h.fire('downloadComplete')
  h.context.window.location.href = taskUrl
  const status = await h.exports.getAutomationStatus()
  assert.equal(status.phase, 'IDLE')
  assert.equal(status.lifecycle.downloadCompleted.url, taskUrl)
})

test('freshly crawled paused queue reports PAUSED_RESUMABLE', async () => {
  const controller = {
    busy: false,
    downloading: false,
    pause: true,
    stop: false,
    resultLength: 3,
  }
  const h = harness(controller, { total: 3 })
  h.fire('crawlComplete')
  h.fire('downloadStart')
  h.fire('downloadPause')
  assert.equal(
    (await h.exports.getAutomationStatus()).phase,
    'PAUSED_RESUMABLE'
  )
})

test('new crawlComplete or resultChange clears stale completed-download state', async () => {
  const controller = {
    busy: false,
    downloading: false,
    pause: false,
    stop: false,
    resultLength: 3,
  }
  const h = harness(controller, null)
  h.fire('crawlComplete')
  h.fire('downloadStart')
  h.fire('downloadComplete')
  assert.equal((await h.exports.getAutomationStatus()).phase, 'IDLE')
  h.fire('crawlComplete')
  assert.equal((await h.exports.getAutomationStatus()).phase, 'READY')
  h.fire('downloadStart')
  h.fire('downloadComplete')
  h.fire('resultChange')
  assert.equal((await h.exports.getAutomationStatus()).phase, 'READY')
})

test('status normalizes URL hashes for lifecycle matching', async () => {
  const h = harness(
    {
      busy: false,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 2,
    },
    null
  )
  h.context.window.location.href = 'https://www.pixiv.net/en/users/1#works'
  h.fire('crawlComplete')
  const status = await h.exports.getAutomationStatus()
  assert.equal(status.phase, 'READY')
  assert.equal(status.page.url, 'https://www.pixiv.net/en/users/1')
})

test('isolated world exposes read-only automation function', async () => {
  const h = harness(
    {
      busy: false,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 0,
    },
    null
  )
  assert.equal(typeof h.context.__PBD_AUTOMATION_STATUS__, 'function')
  assert.equal(typeof h.context.__PBD_AUTOMATION_CRAWL_ID_LIST__, 'function')
  assert.equal(
    typeof h.context.__PBD_AUTOMATION_SET_CRAWL_ID_GATE__,
    'function'
  )
  assert.equal(
    typeof h.context.__PBD_AUTOMATION_DISCARD_CURRENT_RESUME__,
    'undefined'
  )
  const armed = h.context.__PBD_AUTOMATION_ARM_CRAWL__(
    h.context.window.location.href
  )
  h.fire('crawlStart')
  h.context.window.location.href = 'https://www.pixiv.net/en/users/2'
  const result = await h.context.__PBD_AUTOMATION_ABORT_CRAWL__(
    armed.operationId,
    armed.url
  )
  assert.equal(result.outcome, 'aborted')
  assert.deepEqual(h.discardCalls, [])
  assert.equal(
    (await h.exports.getAutomationStatus()).managedOperation.state,
    'aborted'
  )
})

test('Resume status lookup skips IndexedDB when Resume is disabled off Pixiv', async () => {
  let getCalls = 0
  class IndexedDB {
    get() {
      getCalls += 1
      throw new Error('IndexedDB should not be queried')
    }
  }
  const context = vm.createContext({ console, Date })
  const file = path.join(root, 'src/ts/download/Resume.ts')
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const exports = {}
  vm.runInContext(`(function(require, exports) {${compiled}\n})`, context, {
    filename: file,
  })((name) => {
    if (name === '../EVT') return { EVT: { list: {} } }
    if (name === '../Log') return { log: {} }
    if (name === '../Language') return { lang: {} }
    if (name === '../store/Store') return { store: {} }
    if (name === '../store/States') return { states: {} }
    if (name === './DownloadStates') return { downloadStates: {} }
    if (name === '../utils/IndexedDB') return { IndexedDB }
    if (name === '../utils/Utils') return { Utils: { isPixiv: () => false } }
    if (name === '../Toast') return { toast: {} }
    throw new Error(`unexpected require ${name}`)
  }, exports)
  const status = await exports.resume.getSavedTaskStatus(
    'https://www.pixivision.net/example'
  )
  assert.equal(status, null)
  assert.equal(getCalls, 0)
})

function createResumeHarness(options = {}) {
  const location = { href: options.url || 'https://www.pixiv.net/en/users/1' }
  const listeners = new Map()
  const fired = []
  const getCalls = []
  const putCalls = []
  const putManyCalls = []
  const intervalCallbacks = []
  const metaByUrl = new Map(Object.entries(options.metaByUrl || {}))
  const dataById = new Map(
    Object.entries(options.dataById || {}).map(([k, v]) => [Number(k), v])
  )
  const statesById = new Map(
    Object.entries(options.statesById || {}).map(([k, v]) => [Number(k), v])
  )
  const controlById = new Map([['shared', { id: 'shared', generation: 0 }]])
  class IndexedDB {
    async open() {}
    async get(storeName, key, index) {
      getCalls.push([storeName, key, index])
      if (storeName === 'taskMeta' && index === 'url')
        return metaByUrl.get(key) || null
      if (storeName === 'taskMeta') {
        return [...metaByUrl.values()].find((item) => item.id === key) || null
      }
      if (storeName === 'taskData') {
        const value = dataById.get(key)
        return typeof value === 'function' ? value() : (value ?? null)
      }
      if (storeName === 'taskStates') {
        const value = statesById.get(key)
        return typeof value === 'function' ? value() : value || null
      }
      if (storeName === 'resumeControl') return controlById.get(key) || null
      return null
    }
    async put(storeName, value) {
      putCalls.push([storeName, value])
      if (storeName === 'taskMeta') metaByUrl.set(value.url, value)
      if (storeName === 'taskStates') statesById.set(value.id, value)
      if (storeName === 'taskData') dataById.set(value.id, value)
      if (storeName === 'resumeControl') controlById.set(value.id, value)
    }
    async putMany(entries) {
      putManyCalls.push(entries)
      for (const { storeName, data } of entries) {
        await this.put(storeName, data)
      }
    }
    async putManyIfPresent(entries, guardStoreName, guardKey) {
      const guard = await this.get(guardStoreName, guardKey)
      if (!guard) return false
      await this.putMany(entries)
      return true
    }
    async getMany(entries) {
      return Promise.all(
        entries.map(({ storeName, key }) => this.get(storeName, key))
      )
    }
    async deleteMany(entries) {
      for (const { storeName, key } of entries)
        await this.delete(storeName, key)
    }
    async clearMany(storeNames) {
      for (const storeName of new Set(storeNames)) await this.clear(storeName)
    }
    async putManyIfFieldEquals(
      entries,
      guardStoreName,
      guardKey,
      field,
      expected
    ) {
      const guard = await this.get(guardStoreName, guardKey)
      if (!guard || guard[field] !== expected) return false
      await this.putMany(entries)
      return true
    }
    async incrementFieldAndClear(
      guardStoreName,
      guardKey,
      field,
      clearStoreNames
    ) {
      const current = (await this.get(guardStoreName, guardKey)) || {
        id: guardKey,
      }
      const next = Number(current[field] || 0) + 1
      await this.put(guardStoreName, { ...current, [field]: next })
      await this.clearMany(clearStoreNames)
      return next
    }
    async add(storeName, value) {
      if (storeName === 'taskMeta') metaByUrl.set(value.url, value)
      if (storeName === 'taskStates') statesById.set(value.id, value)
      if (storeName === 'taskData') dataById.set(value.id, value)
      if (storeName === 'resumeControl') {
        if (controlById.has(value.id)) throw new Error('ConstraintError')
        controlById.set(value.id, value)
      }
    }
    async delete(storeName, key) {
      if (storeName === 'taskMeta') {
        for (const [url, value] of metaByUrl) {
          if (value.id === key) metaByUrl.delete(url)
        }
      }
      if (storeName === 'taskStates') statesById.delete(key)
      if (storeName === 'taskData') dataById.delete(key)
      if (storeName === 'resumeControl') controlById.delete(key)
    }
    async clear(storeName) {
      if (storeName === 'taskMeta') metaByUrl.clear()
      if (storeName === 'taskStates') statesById.clear()
      if (storeName === 'taskData') dataById.clear()
      if (storeName === 'resumeControl') controlById.clear()
    }
    openCursor() {}
  }
  const EVT = {
    list: {
      pageSwitch: 'pageSwitch',
      settingInitialized: 'settingInitialized',
      crawlStart: 'crawlStart',
      importResultLoaded: 'importResultLoaded',
      crawlComplete: 'crawlComplete',
      resultChange: 'resultChange',
      downloadSuccess: 'downloadSuccess',
      skipDownload: 'skipDownload',
      downloadComplete: 'downloadComplete',
      downloadStop: 'downloadStop',
      downloadPause: 'downloadPause',
      stopCrawl: 'stopCrawl',
      bookmarkModeEnd: 'bookmarkModeEnd',
      clearSavedCrawl: 'clearSavedCrawl',
      resume: 'resume',
    },
    fire(name) {
      fired.push(name)
    },
  }
  const window = {
    location,
    addEventListener(name, callback) {
      const callbacks = listeners.get(name) || []
      callbacks.push(callback)
      listeners.set(name, callbacks)
    },
    setInterval(callback) {
      intervalCallbacks.push(callback)
      return intervalCallbacks.length
    },
    setTimeout(callback) {
      callback()
      return 1
    },
  }
  const localStorage = {
    getItem() {
      return String(Date.now())
    },
    setItem() {},
  }
  const store = {
    result: options.initialResults || [],
    crawlCompleteTime: new Date(0),
    URLWhenCrawlStart: '',
    resetDownloadCount() {},
  }
  const states = {
    settingInitialized: false,
    busy: false,
    async waitSettingInitialized() {},
  }
  const downloadStates = {
    states: [],
    replace(value) {
      this.states = value
    },
    downloadedCount() {
      return this.states.filter((value) => value === 1).length
    },
    summary() {
      return {
        total: this.states.length,
        pending: this.states.filter((value) => value === -1).length,
        inProgress: this.states.filter((value) => value === 0).length,
        completed: this.states.filter((value) => value === 1).length,
      }
    },
  }
  const context = vm.createContext({ console, Date, window, localStorage })
  const file = path.join(root, 'src/ts/download/Resume.ts')
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const exports = {}
  vm.runInContext(`(function(require, exports) {${compiled}\n})`, context, {
    filename: file,
  })((name) => {
    if (name === '../EVT') return { EVT }
    if (name === '../Log')
      return { log: { log() {}, success() {}, warning() {}, error() {} } }
    if (name === '../Language') return { lang: { transl: (value) => value } }
    if (name === '../store/Store') return { store }
    if (name === '../store/States') return { states }
    if (name === '../store/States') return { states }
    if (name === './DownloadStates') return { downloadStates }
    if (name === '../utils/IndexedDB') return { IndexedDB }
    if (name === '../utils/Utils') return { Utils: { isPixiv: () => true } }
    if (name === '../Toast') return { toast: { success() {} } }
    throw new Error(`unexpected require ${name}`)
  }, exports)
  return {
    ...exports,
    context,
    window,
    store,
    states,
    downloadStates,
    fired,
    getCalls,
    putCalls,
    putManyCalls,
    intervalCallbacks,
    metaByUrl,
    dataById,
    statesById,
    controlById,
    fire(name) {
      for (const callback of listeners.get(name) || []) callback()
    },
  }
}

test('Resume status uses metadata summary without cloning taskStates', async () => {
  const url = 'https://www.pixiv.net/en/users/1'
  const h = createResumeHarness({
    url,
    metaByUrl: {
      [url]: {
        id: 101,
        url,
        URLWhenCrawlStart: url,
        part: 1,
        date: new Date('2026-10-03T00:00:00Z'),
        stateSummary: {
          total: 50000,
          pending: 123,
          inProgress: 2,
          completed: 49875,
        },
      },
    },
    statesById: { 101: { id: 101, states: new Array(50000).fill(1) } },
  })
  await h.resume.ready
  const status = await h.resume.getSavedTaskStatus(url)
  assert.equal(status.total, 50000)
  assert.equal(status.pending, 123)
  assert.equal(h.getCalls.filter(([name]) => name === 'taskStates').length, 0)
})

test('obsolete Resume restore cannot land after SPA navigation', async () => {
  const urlA = 'https://www.pixiv.net/en/users/1'
  const urlB = 'https://www.pixiv.net/en/users/2'
  let resolveChunk
  const chunk = new Promise((resolve) => {
    resolveChunk = resolve
  })
  const h = createResumeHarness({
    url: urlA,
    initialResults: [{ id: 'keep-current' }],
    metaByUrl: {
      [urlA]: {
        id: 100,
        url: urlA,
        URLWhenCrawlStart: urlA,
        part: 1,
        date: new Date('2026-10-03T00:00:00Z'),
        stateSummary: { total: 1, pending: 1, inProgress: 0, completed: 0 },
      },
    },
    dataById: { 1000: () => chunk },
    statesById: { 100: { id: 100, states: [-1] } },
  })
  await h.resume.ready
  const restoreA = h.resume.restoreData()
  await new Promise((resolve) => setImmediate(resolve))
  h.window.location.href = urlB
  const restoreB = h.resume.restoreData()
  resolveChunk({ id: 1000, data: [{ id: 'stale-A' }] })
  await Promise.all([restoreA, restoreB])
  assert.deepEqual(h.store.result, [{ id: 'keep-current' }])
  assert.equal(h.fired.includes('resume'), false)
})

test('DownloadStates maintains scalar counts incrementally', () => {
  const listeners = new Map()
  const store = { result: new Array(4).fill({}) }
  const EVT = {
    list: { crawlComplete: 'crawlComplete', resultChange: 'resultChange' },
  }
  const window = {
    addEventListener(name, callback) {
      listeners.set(name, callback)
    },
  }
  const context = vm.createContext({ window })
  const file = path.join(root, 'src/ts/download/DownloadStates.ts')
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const exports = {}
  vm.runInContext(`(function(require, exports) {${compiled}\n})`, context, {
    filename: file,
  })((name) => {
    if (name === '../EVT') return { EVT }
    if (name === '../store/Store') return { store }
    if (name === '../store/States') return { states }
    throw new Error(`unexpected require ${name}`)
  }, exports)
  const ds = exports.downloadStates
  ds.init()
  assert.deepEqual(
    { ...ds.summary() },
    { total: 4, pending: 4, inProgress: 0, completed: 0 }
  )
  ds.setState(0, 0)
  ds.setState(0, 1)
  ds.setState(1, 1)
  assert.equal(ds.downloadedCount(), 2)
  assert.deepEqual(
    { ...ds.summary() },
    { total: 4, pending: 2, inProgress: 0, completed: 2 }
  )
})

test('imported results bind the queue to the current page URL', async () => {
  const listeners = new Map()
  const fired = []
  const window = {
    location: { href: 'https://www.pixiv.net/en/users/9#works' },
    addEventListener(name, callback) {
      listeners.set(name, callback)
    },
  }
  const EVT = {
    list: { importResult: 'importResult', crawlComplete: 'crawlComplete' },
    fire(name) {
      fired.push(name)
    },
  }
  const store = {
    result: [],
    URLWhenCrawlStart: 'https://www.pixiv.net/en/users/old',
    crawlCompleteTime: new Date(0),
    reset() {
      this.result = []
    },
    addResult(owner, value) {
      this.result.push(value)
    },
  }
  const imported = {
    idNum: 1,
    id: '1',
    original: 'https://example.invalid/1.jpg',
    type: 0,
    ext: 'jpg',
    pageCount: 1,
  }
  const context = vm.createContext({ console, Date, window })
  const file = path.join(root, 'src/ts/download/ImportResult.ts')
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const exports = {}
  vm.runInContext(`(function(require, exports) {${compiled}\n})`, context, {
    filename: file,
  })((name) => {
    if (name === '../EVT') return { EVT }
    if (name === '../store/StoreType') return {}
    if (name === '../Language') return { lang: { transl: (value) => value } }
    if (name === '../utils/Utils')
      return { Utils: { loadJSONFile: async () => [imported] } }
    if (name === '../store/States') return { states: { busy: false } }
    if (name === '../crawl/CrawlGeneration')
      return { replacementOwner: 'replacement' }
    if (name === '../store/Store') return { store }
    if (name === '../store/States') return { states }
    if (name === '../Toast') return { toast: { error() {} } }
    if (name === '../MsgBox')
      return { msgBox: { error() {}, warning() {}, success() {} } }
    if (name === '../filter/Filter')
      return { filter: { check: async () => true } }
    if (name === '../Tools')
      return { Tools: { getWorkTypeString: () => 'artwork' } }
    throw new Error(`unexpected require ${name}`)
  }, exports)
  listeners.get('importResult')()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.URLWhenCrawlStart, window.location.href)
  assert.equal(store.crawlCompleteTime instanceof Date, true)
  assert.equal(store.result.length, 1)
  assert.equal(fired.includes('crawlComplete'), true)
})

test('automation status snapshots live controller after durable lookup', async () => {
  let resolveDurable
  const durable = new Promise((resolve) => {
    resolveDurable = resolve
  })
  const controller = {
    busy: false,
    downloading: false,
    pause: false,
    stop: false,
    resultLength: 3,
  }
  const h = harness(controller, () => durable)
  h.fire('crawlComplete')
  const pending = h.exports.getAutomationStatus()
  controller.busy = true
  controller.downloading = true
  resolveDurable(null)
  assert.equal((await pending).phase, 'DOWNLOADING')
})

test('automation status returns detached lifecycle observations', async () => {
  const h = harness(
    {
      busy: false,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 2,
    },
    null
  )
  h.fire('crawlComplete')
  const first = await h.exports.getAutomationStatus()
  first.lifecycle.crawlCompleted.url = 'https://example.invalid/mutated'
  const second = await h.exports.getAutomationStatus()
  assert.equal(second.phase, 'READY')
  assert.equal(
    second.lifecycle.crawlCompleted.url,
    'https://www.pixiv.net/en/users/1'
  )
})

test('legacy status migration does not resurrect metadata deleted during lookup', async () => {
  const url = 'https://www.pixiv.net/en/users/1'
  let h
  h = createResumeHarness({
    url,
    metaByUrl: {
      [url]: {
        id: 201,
        url,
        URLWhenCrawlStart: url,
        part: 1,
        date: new Date(0),
      },
    },
    statesById: {
      201: () => {
        // Simulate download completion deleting metadata while the legacy state array is read.
        // The subsequent id lookup must observe deletion and return null without put().
        return { id: 201, states: [-1, 1] }
      },
    },
  })
  // Replace metadata id lookup behavior by clearing through the harness-visible private DB path.
  const originalGet = h.resume.IDB.get.bind(h.resume.IDB)
  let stateRead = false
  h.resume.IDB.get = async (storeName, key, index) => {
    const value = await originalGet(storeName, key, index)
    if (storeName === 'taskStates') {
      stateRead = true
      await h.resume.IDB.clear('taskMeta')
    }
    return value
  }
  const status = await h.resume.getSavedTaskStatus(url)
  assert.equal(stateRead, true)
  assert.equal(status, null)
  assert.equal(h.putCalls.length, 0)
})

test('clear saved crawl invalidates cached persistence ownership before clearing stores', async () => {
  const h = createResumeHarness()
  await h.resume.ready
  h.resume.taskId = 301
  h.resume.currentMeta = { id: 301, url: h.window.location.href }
  h.resume.needPutStates = true
  h.resume.restorePending = true
  h.resume.legacySummaryCache.set(301, {
    total: 1,
    pending: 1,
    inProgress: 0,
    completed: 0,
  })
  await h.resume.clearSavedCrawl()
  assert.equal(h.resume.taskId, 0)
  assert.equal(h.resume.currentMeta, null)
  assert.equal(h.resume.needPutStates, false)
  assert.equal(h.resume.restorePending, false)
  assert.equal(h.resume.legacySummaryCache.size, 0)
})

test('busy page-switch restore retries on the next idle event', async () => {
  const url = 'https://www.pixiv.net/en/users/1'
  const h = createResumeHarness({
    url,
    initialResults: [{ id: 'old' }],
    metaByUrl: {
      [url]: {
        id: 401,
        url,
        URLWhenCrawlStart: url,
        part: 1,
        date: new Date('2026-10-03T00:00:00Z'),
        stateSummary: { total: 1, pending: 1, inProgress: 0, completed: 0 },
      },
    },
    dataById: { 4010: { id: 4010, data: [{ id: 'restored' }] } },
    statesById: { 401: { id: 401, states: [-1] } },
  })
  await h.resume.ready
  h.states.busy = true
  await h.resume.restoreData()
  assert.equal(h.resume.restorePending, true)
  h.states.busy = false
  h.fire('downloadComplete')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.store.result.length, 1)
  assert.equal(h.store.result[0].id, 'restored')
  assert.equal(h.fired.includes('resume'), true)
})

test('crawl completion stays attributed to the original task URL across SPA navigation', async () => {
  const h = harness(
    {
      busy: false,
      downloading: false,
      pause: false,
      stop: false,
      resultLength: 2,
    },
    null
  )
  const original = h.context.window.location.href
  h.fire('crawlStart')
  h.context.window.location.href = 'https://www.pixiv.net/en/users/2'
  h.fire('crawlComplete')
  const status = await h.exports.getAutomationStatus()
  assert.equal(status.phase, 'IDLE')
  assert.equal(status.lifecycle.crawlCompleted.url, original)
})

test('Resume keeps retry pending when page becomes busy during async restore', async () => {
  const url = 'https://www.pixiv.net/en/users/1'
  let resolveChunk
  const chunk = new Promise((resolve) => {
    resolveChunk = resolve
  })
  const h = createResumeHarness({
    url,
    initialResults: [{ id: 'old' }],
    metaByUrl: {
      [url]: {
        id: 501,
        url,
        URLWhenCrawlStart: url,
        part: 1,
        date: new Date('2026-10-03T00:00:00Z'),
        stateSummary: { total: 1, pending: 1, inProgress: 0, completed: 0 },
      },
    },
    dataById: { 5010: () => chunk },
    statesById: { 501: { id: 501, states: [-1] } },
  })
  await h.resume.ready
  const first = h.resume.restoreData()
  await new Promise((resolve) => setImmediate(resolve))
  h.states.busy = true
  resolveChunk({ id: 5010, data: [{ id: 'restored' }] })
  await first
  assert.equal(h.resume.restorePending, true)
  assert.equal(h.fired.includes('resume'), false)
  h.states.busy = false
  h.fire('downloadPause')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.store.result[0].id, 'restored')
  assert.equal(h.fired.includes('resume'), true)
})

test('Resume persistence normalizes fragment-bearing task URLs', async () => {
  const url = 'https://www.pixiv.net/en/users/9'
  const h = createResumeHarness({
    url: `${url}#works`,
    initialResults: [{ id: 'a' }],
  })
  await h.resume.ready
  h.store.URLWhenCrawlStart = `${url}#works`
  h.store.crawlCompleteTime = new Date('2026-10-03T01:02:03Z')
  h.downloadStates.states = [-1]
  await h.resume.saveData(`${url}#works`)
  const meta = h.metaByUrl.get(url)
  assert.ok(meta)
  assert.equal(meta.url, url)
  assert.equal(meta.URLWhenCrawlStart, url)
  assert.equal(h.metaByUrl.has(`${url}#works`), false)
})

test('queued Resume save persists an immutable queue snapshot', async () => {
  const urlA = 'https://www.pixiv.net/en/users/1'
  const urlB = 'https://www.pixiv.net/en/users/2'
  const h = createResumeHarness({ url: urlA, initialResults: [{ id: 'A' }] })
  await h.resume.ready
  h.store.URLWhenCrawlStart = urlA
  h.store.crawlCompleteTime = new Date('2026-10-03T01:00:00Z')
  h.downloadStates.states = [-1]
  const pending = h.resume.saveData(urlA)
  await new Promise((resolve) => setImmediate(resolve))

  h.window.location.href = urlB
  h.store.URLWhenCrawlStart = urlB
  h.store.result = [{ id: 'B1' }, { id: 'B2' }]
  h.store.crawlCompleteTime = new Date('2026-10-03T02:00:00Z')
  h.downloadStates.states = [1, 1]
  await pending

  const meta = h.metaByUrl.get(urlA)
  assert.ok(meta)
  assert.equal(meta.URLWhenCrawlStart, urlA)
  assert.equal(new Date(meta.date).toISOString(), '2026-10-03T01:00:00.000Z')
  assert.deepEqual(
    { ...meta.stateSummary },
    {
      total: 1,
      pending: 1,
      inProgress: 0,
      completed: 0,
    }
  )
  const data = h.dataById.get(Number(`${meta.id}0`))
  assert.equal(data.data.length, 1)
  assert.equal(data.data[0].id, 'A')
  assert.deepEqual([...h.statesById.get(meta.id).states], [-1])
})

test('Resume checkpoints state array and scalar summary through one atomic write', async () => {
  const url = 'https://www.pixiv.net/en/users/1'
  const h = createResumeHarness({ url, initialResults: [{}, {}, {}] })
  await h.resume.ready
  h.resume.taskId = 601
  h.resume.currentMeta = {
    id: 601,
    url,
    URLWhenCrawlStart: url,
    part: 1,
    date: new Date(0),
    stateSummary: { total: 3, pending: 3, inProgress: 0, completed: 0 },
  }
  h.metaByUrl.set(url, h.resume.currentMeta)
  h.downloadStates.states = [-1, 0, 1]
  h.resume.needPutStates = true
  assert.ok(h.intervalCallbacks.length > 0)
  h.intervalCallbacks[0]()
  await new Promise((resolve) => setImmediate(resolve))
  const atomic = h.putManyCalls.at(-1)
  assert.ok(atomic)
  assert.equal(
    atomic
      .map((entry) => entry.storeName)
      .sort()
      .join(','),
    'taskMeta,taskStates'
  )
  const meta = atomic.find((entry) => entry.storeName === 'taskMeta').data
  assert.deepEqual(
    { ...meta.stateSummary },
    {
      total: 3,
      pending: 1,
      inProgress: 1,
      completed: 1,
    }
  )
})

test('expired Resume task invalidates matching checkpoint ownership before deletion', async () => {
  const h = createResumeHarness()
  await h.resume.ready
  h.resume.taskId = 701
  h.resume.currentMeta = {
    id: 701,
    url: h.window.location.href,
    URLWhenCrawlStart: h.window.location.href,
    part: 1,
    date: new Date(0),
  }
  h.resume.needPutStates = true
  h.resume.legacySummaryCache.set(701, {
    total: 1,
    pending: 1,
    inProgress: 0,
    completed: 0,
  })
  h.resume.invalidateTaskOwnership(701)
  assert.equal(h.resume.taskId, 0)
  assert.equal(h.resume.currentMeta, null)
  assert.equal(h.resume.needPutStates, false)
  assert.equal(h.resume.legacySummaryCache.has(701), false)
})

test('expired Resume task cannot land after deletion while restore reads are in flight', async () => {
  const url = 'https://www.pixiv.net/en/users/1'
  let resolveChunk
  const chunk = new Promise((resolve) => {
    resolveChunk = resolve
  })
  const h = createResumeHarness({
    url,
    initialResults: [{ id: 'live' }],
    metaByUrl: {
      [url]: {
        id: 702,
        url,
        URLWhenCrawlStart: url,
        part: 1,
        date: new Date(0),
        stateSummary: { total: 1, pending: 1, inProgress: 0, completed: 0 },
      },
    },
    dataById: { 7020: () => chunk },
    statesById: { 702: { id: 702, states: [-1] } },
  })
  await h.resume.ready
  const pendingRestore = h.resume.restoreData()
  await new Promise((resolve) => setImmediate(resolve))

  // clearExired() uses this invalidation path before deleting the expired task.
  h.resume.invalidateTaskOwnership(702)
  await h.resume.IDB.delete('taskMeta', 702)
  await h.resume.IDB.delete('taskStates', 702)
  await h.resume.IDB.delete('taskData', 7020)

  resolveChunk({ id: 7020, data: [{ id: 'expired' }] })
  await pendingRestore

  assert.equal(h.store.result[0].id, 'live')
  assert.equal(h.resume.taskId || 0, 0)
  assert.equal(h.resume.currentMeta, null)
  assert.equal(h.fired.includes('resume'), false)
})

test('restore rejects a partial three-store task snapshot even while metadata survives', async () => {
  const url = 'https://www.pixiv.net/en/users/1'
  const h = createResumeHarness({
    url,
    initialResults: [{ id: 'live' }],
    metaByUrl: {
      [url]: {
        id: 703,
        url,
        URLWhenCrawlStart: url,
        part: 1,
        date: new Date(0),
        stateSummary: { total: 1, pending: 1, inProgress: 0, completed: 0 },
      },
    },
    statesById: { 703: { id: 703, states: [-1] } },
    // Simulate the old cross-tab expiry race: taskMeta is still visible while
    // taskData has already been removed by a separate-store deletion.
    dataById: {},
  })
  await h.resume.ready
  await h.resume.restoreData()

  assert.equal(h.store.result[0].id, 'live')
  assert.equal(h.resume.taskId || 0, 0)
  assert.equal(h.resume.currentMeta, null)
  assert.equal(h.fired.includes('resume'), false)
})

test('Resume restores a maximum-size persisted chunk without argument spreading', async () => {
  const url = 'https://www.pixiv.net/en/users/1'
  const count = 150000
  const h = createResumeHarness({
    url,
    initialResults: [{ id: 'live' }],
    metaByUrl: {
      [url]: {
        id: 705,
        url,
        URLWhenCrawlStart: url,
        part: 1,
        date: new Date(0),
        stateSummary: {
          total: count,
          pending: count,
          inProgress: 0,
          completed: 0,
        },
      },
    },
    dataById: {
      7050: { id: 7050, data: new Array(count).fill({ id: 'restored' }) },
    },
    statesById: { 705: { id: 705, states: [-1] } },
  })
  await h.resume.ready
  await h.resume.restoreData()

  assert.equal(h.store.result.length, count)
  assert.equal(h.store.result[0].id, 'restored')
  assert.equal(h.store.result[count - 1].id, 'restored')
  assert.equal(h.fired.includes('resume'), true)
})

test('shared clear generation cancels an in-flight save from another tab', async () => {
  const url = 'https://www.pixiv.net/en/users/1'
  const h = createResumeHarness({ url, initialResults: [{ id: 'queued' }] })
  await h.resume.ready
  h.store.URLWhenCrawlStart = url
  h.store.crawlCompleteTime = new Date('2026-10-04T00:00:00Z')
  h.downloadStates.states = [-1]

  const originalAdd = h.resume.IDB.add.bind(h.resume.IDB)
  let releaseChunk
  let chunkStarted
  const chunkStartedPromise = new Promise((resolve) => {
    chunkStarted = resolve
  })
  h.resume.IDB.add = async (storeName, value) => {
    if (storeName === 'taskData') {
      chunkStarted()
      await new Promise((resolve) => {
        releaseChunk = resolve
      })
    }
    return originalAdd(storeName, value)
  }

  const pending = h.resume.saveData(url)
  await chunkStartedPromise
  // Another tab atomically publishes a clear generation and clears durable stores.
  h.controlById.set('shared', { id: 'shared', generation: 1 })
  h.metaByUrl.clear()
  h.statesById.clear()
  h.dataById.clear()
  releaseChunk()
  await pending

  assert.equal(h.metaByUrl.has(url), false)
  assert.equal(h.statesById.size, 0)
  assert.equal(h.dataById.size, 0)
  assert.equal(h.resume.taskId || 0, 0)
})

test('repeated result changes retain at most one pending large save', async () => {
  const url = 'https://www.pixiv.net/en/users/1'
  const h = createResumeHarness({ url, initialResults: [{ id: 'initial' }] })
  await h.resume.ready
  h.store.URLWhenCrawlStart = url
  h.store.crawlCompleteTime = new Date('2026-10-04T00:00:00Z')
  h.downloadStates.states = [-1]

  const originalAdd = h.resume.IDB.add.bind(h.resume.IDB)
  let releaseChunk
  let chunkStarted
  const chunkStartedPromise = new Promise((resolve) => {
    chunkStarted = resolve
  })
  let blocked = false
  h.resume.IDB.add = async (storeName, value) => {
    if (storeName === 'taskData' && !blocked) {
      blocked = true
      chunkStarted()
      await new Promise((resolve) => {
        releaseChunk = resolve
      })
    }
    return originalAdd(storeName, value)
  }

  const first = h.resume.saveData(url)
  await chunkStartedPromise
  const queued = []
  for (let i = 0; i < 25; i++) {
    h.store.result = [{ id: `latest-${i}` }]
    h.downloadStates.states = [-1]
    queued.push(h.resume.saveData(url))
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.resume.pendingSaveRequests.length, 1)
  assert.equal(h.resume.pendingSaveRequests[0].waiters.length, 25)

  releaseChunk()
  await Promise.all([first, ...queued])
  assert.equal(h.resume.pendingSaveRequests.length, 0)
  assert.equal(h.resume.saveDataDraining, false)
})

test('download completion cancels the initial save before taskId ownership exists', async () => {
  const url = 'https://www.pixiv.net/en/users/1'
  const h = createResumeHarness({ url, initialResults: [{ id: 'queued' }] })
  await h.resume.ready
  h.store.URLWhenCrawlStart = url
  h.store.crawlCompleteTime = new Date('2026-10-04T00:00:00Z')
  h.downloadStates.states = [-1]

  const originalAdd = h.resume.IDB.add.bind(h.resume.IDB)
  let releaseChunk
  let chunkStarted
  const chunkStartedPromise = new Promise((resolve) => {
    chunkStarted = resolve
  })
  h.resume.IDB.add = async (storeName, value) => {
    if (storeName === 'taskData') {
      chunkStarted()
      await new Promise((resolve) => {
        releaseChunk = resolve
      })
    }
    return originalAdd(storeName, value)
  }

  const pending = h.resume.saveData(url)
  await chunkStartedPromise
  assert.equal(h.resume.taskId || 0, 0)
  h.fire('downloadComplete')
  await new Promise((resolve) => setImmediate(resolve))
  releaseChunk()
  await pending

  assert.equal(h.metaByUrl.has(url), false)
  assert.equal(h.statesById.size, 0)
  assert.equal(h.dataById.size, 0)
  assert.equal(h.resume.taskId || 0, 0)
})

test('checkpoint does not recreate metadata deleted by another tab', async () => {
  const url = 'https://www.pixiv.net/en/users/1'
  const meta = {
    id: 704,
    url,
    URLWhenCrawlStart: url,
    part: 1,
    date: new Date(0),
    stateSummary: { total: 2, pending: 2, inProgress: 0, completed: 0 },
  }
  const h = createResumeHarness({
    url,
    metaByUrl: { [url]: meta },
    statesById: { 704: { id: 704, states: [-1, -1] } },
  })
  await h.resume.ready
  h.resume.taskId = 704
  h.resume.currentMeta = meta
  h.downloadStates.states = [1, -1]
  h.resume.needPutStates = true

  // Another tab commits expiry deletion before this tab's progress checkpoint transaction.
  await h.resume.IDB.delete('taskMeta', 704)
  await h.resume.IDB.delete('taskStates', 704)
  h.intervalCallbacks[0]()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(h.metaByUrl.has(url), false)
  assert.equal(h.resume.taskId, 0)
  assert.equal(h.resume.currentMeta, null)
  assert.equal(h.putManyCalls.length, 0)
})

test('managed manual stop wins over late completion and result changes', async () => {
  const h = harness({ busy: false, resultLength: 3 }, null)
  let abortComplete = 0
  h.context.window.addEventListener('managedCrawlAbortComplete', () => {
    abortComplete++
  })
  const arm = h.context.__PBD_AUTOMATION_ARM_CRAWL__(
    h.context.window.location.href
  )
  h.fire('crawlStart')
  h.fire('stopCrawl')
  h.fire('crawlComplete')
  h.fire('resultChange')
  await h.context.__PBD_AUTOMATION_ABORT_CRAWL__(arm.operationId, arm.url)
  assert.equal((await h.exports.getAutomationStatus()).phase, 'STOPPED')
  assert.deepEqual(h.discardCalls, [])
  assert.equal(abortComplete, 1)
  const next = h.context.__PBD_AUTOMATION_ARM_CRAWL__(arm.url)
  h.fire('crawlStart')
  h.fire('crawlComplete')
  assert.equal(
    (await h.context.__PBD_AUTOMATION_ABORT_CRAWL__(next.operationId, next.url))
      .outcome,
    'already-completed'
  )
  assert.equal((await h.exports.getAutomationStatus()).phase, 'READY')
  assert.equal(h.discardCalls.length, 0)
})

test('managed abort fails closed for wrong token, URL and unmatched crawl', async () => {
  const h = harness({ busy: false }, null)
  const arm = h.context.__PBD_AUTOMATION_ARM_CRAWL__(
    h.context.window.location.href
  )
  h.fire('crawlStart')
  assert.equal(
    (await h.context.__PBD_AUTOMATION_ABORT_CRAWL__('wrong', arm.url)).outcome,
    'ownership-mismatch'
  )
  assert.equal(
    (
      await h.context.__PBD_AUTOMATION_ABORT_CRAWL__(
        arm.operationId,
        arm.url + '?x'
      )
    ).outcome,
    'ownership-mismatch'
  )
  h.context.window.location.href += '?other'
  h.store.URLWhenCrawlStart = h.context.window.location.href
  h.fire('crawlStart')
  h.fire('stopCrawl')
  assert.equal((await h.exports.getAutomationStatus()).managedOperation, null)
  assert.equal(h.discardCalls.length, 0)
})

test('download controller blocks ready UI and direct start for aborted managed results', async () => {
  const h = harness({ busy: false, resultLength: 3 }, null)
  const arm = h.context.__PBD_AUTOMATION_ARM_CRAWL__(
    h.context.window.location.href
  )
  h.fire('crawlStart')
  await h.context.__PBD_AUTOMATION_ABORT_CRAWL__(arm.operationId, arm.url)
  const file = path.join(root, 'src/ts/download/DownloadControl.ts')
  const source = fs
    .readFileSync(file, 'utf8')
    .replace(
      'new DownloadControl()',
      'exports.controllerClass = DownloadControl'
    )
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const exports = {}
  vm.runInContext(`(function(require, exports) {${compiled}\n})`, h.context)(
    (name) => {
      if (name === './ManagedCrawlAutomation') return h.managed
      // Any attempt to prepare results, show buttons or download reaches an unstubbed dependency.
      return {}
    },
    exports
  )
  const controller = Object.create(exports.controllerClass.prototype)
  controller.readyDownload()
  controller.startDownload()
})

test('not-started abort cancels the arm and owned abort suppresses before Stop Crawl', async () => {
  const h = harness({ busy: false }, null)
  const url = h.context.window.location.href

  const stale = h.context.__PBD_AUTOMATION_ARM_CRAWL__(url + '#fragment')
  const notStarted = await h.context.__PBD_AUTOMATION_ABORT_CRAWL__(
    stale.operationId,
    url
  )
  assert.equal(notStarted.outcome, 'not-started')
  assert.equal(notStarted.operationId, stale.operationId)
  assert.equal((await h.exports.getAutomationStatus()).managedArm, null)

  // A later manual crawl on that URL is not silently claimed by the stale arm.
  h.fire('crawlStart')
  assert.equal((await h.exports.getAutomationStatus()).managedOperation, null)
  h.fire('stopCrawl')
  assert.equal(h.discardCalls.length, 0)

  const owned = h.context.__PBD_AUTOMATION_ARM_CRAWL__(url)
  h.store.URLWhenCrawlStart = url
  h.fire('crawlStart')
  h.context.window.addEventListener('stopCrawl', () => {
    assert.deepEqual(h.discardCalls, [])
    assert.equal(h.managed.getManagedCrawl().state, 'aborted')
    assert.equal(
      h.generation.ownsCrawl(h.managed.getManagedCrawl().generation),
      false
    )
  })
  const result = await h.context.__PBD_AUTOMATION_ABORT_CRAWL__(
    owned.operationId,
    url
  )
  assert.equal(result.outcome, 'aborted')
  assert.equal(h.states.stopCrawl, true)
})

function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

// Execute the production base worker, Store and save modules with deferred API/filter responses.
function crawlHarness() {
  const h = harness({ busy: false, resultLength: 0 }, null)
  h.context.window.setTimeout = setTimeout
  h.context.window.clearTimeout = clearTimeout
  h.context.location = { pathname: '/en/users/1/requests' }
  h.EVT.list = new Proxy(h.EVT.list, { get: (obj, key) => obj[key] || key })
  h.EVT.bindOnce = () => {}
  const noop = () => {}
  const settings = { setFileDownloadOrder: false, exportIDList: false }
  const filter = { check: async () => true, showTip: () => false }
  const API = {}
  const Tools = new Proxy(
    {
      getWorkTypeVague: () => 0,
      extractTags: () => [],
      getAIGeneratedMark: () => '',
      getCurrentPageUserId: () => '1',
    },
    { get: (obj, key) => obj[key] || (() => '') }
  )
  const Utils = {
    isPixiv: () => true,
    htmlDecode: (x) => x,
    htmlToText: (x) => x,
    sleep: async () => {},
    splitArray: (a) => [a],
  }
  const log = new Proxy({}, { get: () => noop })
  const modules = {
    '../crawl/CrawlGeneration': h.generation,
    './CrawlGeneration': h.generation,
    '../download/ManagedCrawlAutomation': h.managed,
    '../EVT': { EVT: h.EVT },
    '../store/Store': { store: h.store },
    './Store': { store: h.store },
    '../store/States': { states: h.states },
    '../filter/Filter': { filter },
    '../API': { API },
    '../Tools': { Tools },
    '../utils/Utils': { Utils },
    '../Log': { log },
    '../Language': { lang: { transl: () => '' } },
    '../setting/Settings': { settings },
    '../PageType': { pageType: { type: 0, list: {} } },
    '../store/CacheWorkData': { cacheWorkData: { get: () => null } },
    './VipSearchOptimize': {
      vipSearchOptimize: { checkBookmarkCount: async () => false },
    },
    '../Colors': { Colors: { bgBlue: 'blue' } },
    '../Toast': { toast: log },
    '../MsgBox': { msgBox: log },
    '../filter/Mute': { mute: { getMuteSettings: async () => {} } },
    '../ShowOneTimeMsg': { showOneTimeMsg: log },
    '../crawl/CrawlLatestFewWorks': {},
    './CrawlLatestFewWorks': { crawlLatestFewWorks: log },
    '../filter/CheckIndexForMultiImageWork': {
      checkIndexForMultiImageWork: { check: () => true },
    },
  }
  function load(relative, replacement) {
    let source = fs.readFileSync(path.join(root, 'src/ts', relative), 'utf8')
    if (replacement) source = replacement(source)
    const code = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText
    const exports = {}
    vm.runInContext('(function(require, exports) {' + code + '\n})', h.context)(
      (name) => modules[name] || {},
      exports
    )
    return exports
  }
  // Keep the same Store object captured by automation; install production methods/defaults.
  const realStore = load('store/Store.ts').store
  Object.setPrototypeOf(h.store, Object.getPrototypeOf(realStore))
  Object.assign(h.store, realStore)
  h.store.bindEvents()
  h.store.URLWhenCrawlStart = h.context.window.location.href
  modules['../store/SaveArtworkData'] = load('store/SaveArtworkData.ts')
  modules['../store/SaveNovelData'] = load('store/SaveNovelData.ts')
  const Base = load('crawl/InitPageBase.ts').InitPageBase
  modules['../crawl/InitPageBase'] = { InitPageBase: Base }
  const worker = new Base()
  worker.sortResult = noop
  worker.resetGetIdListStatus = noop
  let complete = 0
  h.context.window.addEventListener('crawlComplete', () => {
    complete++
  })
  function start(managed = true) {
    h.states.stopCrawl = false
    const arm = managed
      ? h.managed.armManagedCrawl(h.context.window.location.href)
      : null
    h.fire('crawlStart')
    worker.generation = h.generation.currentCrawl()
    worker.finishedRequest = 0
    worker.ajaxThread = 1
    worker.crawlFinishBecauseStopCrawl = false
    return { arm, generation: worker.generation }
  }
  return {
    ...h,
    worker,
    Utils,
    API,
    filter,
    settings,
    load,
    start,
    complete: () => complete,
    saveArtwork: modules['../store/SaveArtworkData'].saveArtworkData,
    saveNovel: modules['../store/SaveNovelData'].saveNovelData,
  }
}

function artwork(id = '100', illustType = 0) {
  return {
    body: {
      id,
      illustType,
      tags: { tags: [] },
      title: 'work',
      description: '',
      aiType: 0,
      pageCount: 1,
      width: 1,
      height: 1,
      userId: '1',
      userName: 'author',
      urls: {
        original: 'https://example.invalid/100_p0.jpg',
        regular: '',
        small: '',
        thumb: '',
      },
    },
  }
}

for (const replacement of ['new crawl', 'import']) {
  test(`late managed metadata after abort and ${replacement} cannot write, consume IDs or complete`, async () => {
    const h = crawlHarness()
    const old = h.start()
    const response = deferred()
    const started = deferred()
    h.API.getArtworkData = () => {
      started.resolve()
      return response.promise
    }
    h.store.idList = [{ id: '100', type: 'illusts' }]
    const pending = h.worker.getWorksData(undefined, old.generation)
    await started.promise
    await h.managed.abortManagedCrawl(old.arm.operationId, old.arm.url)
    if (replacement === 'new crawl') h.start()
    else {
      h.store.reset()
      h.store.addResult(h.generation.replacementOwner, {
        id: '900',
        idNum: 900,
        type: 3,
      })
      h.fire('importResultLoaded')
      assert.equal(h.managed.managedCrawlBlocksDownload(), false)
    }
    h.store.idList = [{ id: '200', type: 'illusts' }]
    h.worker.finishedRequest = 7
    const before = JSON.stringify(h.store.result)
    response.resolve(artwork())
    await pending
    assert.equal(JSON.stringify(h.store.result), before)
    assert.equal(h.store.idList[0].id, '200')
    assert.equal(h.worker.finishedRequest, 7)
    assert.equal(h.complete(), 0)
  })
}

for (const filename of [
  'InitUserPage',
  'InitBookmarkPage',
  'InitUserRequestPage',
]) {
  test(`${filename} rejects old ID response after abort and same-URL second crawl`, async () => {
    const h = crawlHarness()
    const old = h.start()
    const response = deferred()
    const started = deferred()
    const request = () => {
      started.resolve()
      return response.promise
    }
    h.API.getUserWorksByType = request
    h.API.getBookmarkData = request
    h.API.getUserRequestIds = request
    const Class = h.load('crawlMixedPage/' + filename + '.ts')[filename]
    const producer = Object.create(Class.prototype)
    Object.assign(producer, {
      generation: old.generation,
      listType: 0,
      idList: [],
      offset: 0,
      filteredNumber: 0,
      requsetNumber: 10,
    })
    const pending = producer.getIdList()
    await started.promise
    await h.managed.abortManagedCrawl(old.arm.operationId, old.arm.url)
    const next = h.start()
    producer.generation = next.generation
    h.store.idList = [{ id: 'new', type: 'illusts' }]
    response.resolve(
      filename === 'InitBookmarkPage'
        ? { body: { works: [{ id: 'old' }] } }
        : [{ id: 'old', type: 'illusts' }]
    )
    await pending
    assert.equal(h.store.idList.length, 1)
    assert.equal(h.store.idList[0].id, 'new')
    assert.equal(h.complete(), 0)
  })
}

test('save modules reject ownership lost during their filters and ugoira metadata', async () => {
  for (const kind of ['artwork-filter', 'novel-filter', 'ugoira']) {
    const h = crawlHarness()
    const old = h.start()
    const pause = deferred()
    if (kind === 'ugoira') h.API.getUgoiraMeta = () => pause.promise
    else h.filter.check = () => pause.promise
    const pending =
      kind === 'novel-filter'
        ? h.saveNovel.save(old.generation, {
            body: { id: '100', tags: { tags: [] }, aiType: 0 },
          })
        : h.saveArtwork.save(
            old.generation,
            artwork('100', kind === 'ugoira' ? 2 : 0)
          )
    await Promise.resolve()
    await h.managed.abortManagedCrawl(old.arm.operationId, old.arm.url)
    h.start()
    pause.resolve(
      kind === 'ugoira'
        ? { body: { frames: [], mime_type: '', originalSrc: '', src: '' } }
        : true
    )
    await pending
    assert.equal(h.store.result.length, 0)
    assert.equal(h.store.resultMeta.length, 0)
  }
})

test('managed manual stop revokes synchronously; unmanaged stop preserves partial finalization', async () => {
  const h = crawlHarness()
  let task = h.start()
  h.fire('stopCrawl')
  assert.equal(h.generation.ownsCrawl(task.generation), false)
  assert.equal(h.managed.getManagedCrawl().state, 'aborted')
  task = h.start(false)
  h.store.addResult(task.generation, { id: '100', idNum: 100, type: 3 })
  h.fire('stopCrawl')
  assert.equal(h.generation.ownsCrawl(task.generation), true)
  // The real Stop button sets this after dispatch; legacy worker finalizes partial results.
  h.states.stopCrawl = true
  await h.worker.getWorksData(undefined, task.generation)
  assert.equal(h.complete(), 1)
  assert.equal(h.store.result.length, 1)
})

test('work-count and ID-only managed stops remain distinct from completed', async () => {
  for (const reason of ['skipped-work-count', 'skipped-id-list']) {
    const h = crawlHarness()
    const task = h.start()
    h.store.idList = [{ id: '100', type: 'illusts' }]
    if (reason === 'skipped-work-count') {
      // Arm before start in production; exercise the real synchronous gate listener here.
      h.states.busy = false
      h.exports.setAutomationCrawlIdGate(0)
    } else h.worker.onlyCrawlIdList = true
    await h.worker.getIdListFinished(task.generation)
    assert.equal(h.managed.getManagedCrawl().state, reason)
    assert.equal(h.generation.ownsCrawl(task.generation), false)
    assert.equal(h.complete(), 0)
    assert.deepEqual(h.discardCalls, [])
  }
})

test('wrong generation and completed late abort do not mutate authority or downloadable results', async () => {
  const h = crawlHarness()
  const task = h.start()
  const wrong = await h.context.__PBD_AUTOMATION_ABORT_CRAWL__(
    task.arm.operationId,
    task.arm.url,
    task.generation + 1
  )
  assert.equal(wrong.outcome, 'ownership-mismatch')
  assert.equal(h.generation.ownsCrawl(task.generation), true)
  h.store.addResult(task.generation, { id: '100', idNum: 100, type: 3 })
  h.worker.crawlFinished(task.generation)
  const before = JSON.stringify(h.store.result)
  assert.equal(
    (
      await h.managed.abortManagedCrawl(
        task.arm.operationId,
        task.arm.url,
        task.generation
      )
    ).outcome,
    'already-completed'
  )
  assert.equal(h.generation.ownsCrawl(task.generation), true)
  assert.equal(h.managed.managedCrawlBlocksDownload(), false)
  assert.equal(JSON.stringify(h.store.result), before)
})

test('normal unmanaged metadata crawl publishes and completes', async () => {
  const h = crawlHarness()
  const task = h.start(false)
  h.API.getArtworkData = async () => artwork()
  h.store.idList = [{ id: '100', type: 'illusts' }]
  await h.worker.getWorksData(undefined, task.generation)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.store.result.length, 1)
  assert.equal(h.store.resultMeta.length, 1)
  assert.equal(h.complete(), 1)
})

test('Resume ignores busy resultChange but persists completed and idle edited/imported queues', async () => {
  const h = createResumeHarness()
  await h.resume.ready
  h.store.result = [{ id: '100' }]
  h.downloadStates.states = [-1]
  h.states.busy = true
  h.fire('resultChange')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.putCalls.length, 0)
  h.fire('crawlComplete')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.metaByUrl.size, 1)
  h.states.busy = false
  h.store.result = [{ id: 'imported' }, { id: 'edited' }]
  h.downloadStates.states = [-1, -1]
  h.fire('resultChange')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    [...h.dataById.values()].some((chunk) => chunk.data.length === 2),
    true
  )
  assert.equal(typeof h.resume.discardSavedTask, 'undefined')
})

test('managed terminal event advances the production waiting-ID scheduler after revocation', async () => {
  const h = crawlHarness()
  const task = h.start()
  const oldResponse = deferred()
  const started = deferred()
  const nextRequested = deferred()
  const nextResponse = deferred()
  const completed = deferred()
  const nextStarted = deferred()
  let nextTask
  h.context.window.addEventListener('crawlComplete', () => completed.resolve())
  h.API.getArtworkData = (id) => {
    if (id === '100') {
      started.resolve()
      return oldResponse.promise
    }
    nextRequested.resolve()
    return nextResponse.promise
  }
  h.store.idList = [{ id: '100', type: 'illusts' }]
  const pending = h.worker.getWorksData(undefined, task.generation)
  await started.promise
  h.store.waitingIdList = [{ id: '200', type: 'illusts' }]
  const schedulerSource = fs.readFileSync(
    path.join(root, 'src/ts/download/DownloadControl.ts'),
    'utf8'
  )
  const schedulerAst = ts.createSourceFile(
    'DownloadControl.ts',
    schedulerSource,
    ts.ScriptTarget.Latest,
    true
  )
  const cls = schedulerAst.statements.find(ts.isClassDeclaration)
  const bind = cls.members.find(
    (member) => member.name?.getText(schedulerAst) === 'bindEvents'
  )
  // Exercise the actual queue listener; other listeners concern downloads and UI.
  const queueStatement = bind.body.statements.find((statement) =>
    statement
      .getText(schedulerAst)
      .startsWith('checkWaitingIdListEvents.forEach')
  )
  const source = `const checkWaitingIdListEvents = [EVT.list.downloadComplete, EVT.list.crawlEmpty, EVT.list.managedCrawlAbortComplete]; ${queueStatement.getText(schedulerAst)}`
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  h.context.EVT = h.EVT
  h.context.store = h.store
  h.context.toast = { success() {} }
  h.context.lang = { transl: () => '' }
  h.context.browser = { runtime: { sendMessage() {} } }
  vm.runInContext(
    ['(function() {', code, '})'].join(String.fromCharCode(10)),
    h.context
  ).call({})
  const originalFire = h.EVT.fire.bind(h.EVT)
  h.EVT.fire = (name, data) => {
    if (name === 'crawlIdList') {
      h.states.busy = false
      nextTask = h.worker.crawlIdList(data)
      nextStarted.resolve()
    } else originalFire(name)
  }
  await h.managed.abortManagedCrawl(task.arm.operationId, task.arm.url)
  assert.equal(h.generation.ownsCrawl(task.generation), false)
  await nextStarted.promise
  await nextTask
  await nextRequested.promise
  oldResponse.resolve(artwork('100'))
  await pending
  assert.equal(h.store.result.length, 0)
  nextResponse.resolve(artwork('200'))
  await completed.promise
  assert.equal(h.store.waitingIdList.length, 0)
  assert.equal(h.store.result.length, 1)
  assert.equal(h.store.result[0].idNum, 200)
  assert.equal(h.complete(), 1)
})

test('late retry and afterGetWorksData filter cannot consume new IDs or completion counters', async () => {
  for (const phase of ['retry', 'after-filter']) {
    const h = crawlHarness()
    const task = h.start()
    const pause = deferred()
    h.store.idList = [{ id: '200', type: 'illusts' }]
    let pending
    if (phase === 'after-filter') {
      h.filter.check = () => pause.promise
      pending = h.worker.afterGetWorksData(undefined, task.generation)
    } else {
      h.API.getArtworkData = async () => {
        throw new Error('offline')
      }
      // Awaiting filter and failed API leads into the real retry sleep.
      h.context.console = { ...console, error() {} }
      const started = deferred()
      h.Utils.sleep = () => {
        started.resolve()
        return pause.promise
      }
      pending = h.worker.getWorksData(
        { id: '100', type: 'illusts' },
        task.generation
      )
      await started.promise
    }
    await h.managed.abortManagedCrawl(task.arm.operationId, task.arm.url)
    h.start(false)
    h.store.idList = [{ id: '300', type: 'illusts' }]
    h.worker.finishedRequest = 9
    pause.resolve(false)
    await pending
    assert.equal(h.store.idList[0].id, '300')
    assert.equal(h.worker.finishedRequest, 9)
    assert.equal(h.complete(), 0)
  }
})

test('a new unmanaged crawl invalidates prior callbacks without any Stop event', async () => {
  const h = crawlHarness()
  const old = h.start(false)
  const response = deferred()
  const started = deferred()
  h.API.getArtworkData = () => {
    started.resolve()
    return response.promise
  }
  const pending = h.worker.getWorksData(
    { id: '100', type: 'illusts' },
    old.generation
  )
  await started.promise
  h.start(false)
  h.store.idList = [{ id: 'new', type: 'illusts' }]
  response.resolve(artwork())
  await pending
  assert.equal(h.store.result.length, 0)
  assert.equal(h.store.idList[0].id, 'new')
  assert.equal(h.complete(), 0)
})

test('managed ID export remains non-destructive and never marks metadata completion', async () => {
  const h = crawlHarness()
  const task = h.start()
  h.settings.exportIDList = true
  let exported
  h.Utils.json2BlobSafe = async (ids) => {
    exported = ids
    return []
  }
  h.store.idList = [{ id: '100', type: 'illusts' }]
  await h.worker.getIdListFinished(task.generation)
  assert.equal(exported[0].id, '100')
  assert.equal(h.store.idList[0].id, '100')
  assert.equal(h.managed.getManagedCrawl().state, 'skipped-id-list')
  assert.equal(h.complete(), 0)
  assert.deepEqual(h.discardCalls, [])
})
