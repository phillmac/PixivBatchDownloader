const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')

function harness(controller, durable) {
  const location = { href: 'https://www.pixiv.net/en/users/1' }
  const store = { URLWhenCrawlStart: location.href }
  const diagnostics = {
    automationSnapshot() {
      return controller
    },
    pageSnapshot() {
      throw new Error('automation status must not build the full diagnostic snapshot')
    },
  }
  const resume = {
    async getSavedTaskStatus() {
      return durable
    },
  }
  const listeners = new Map()
  const EVT = {
    list: {
      crawlStart: 'crawlStart',
      crawlComplete: 'crawlComplete',
      crawlEmpty: 'crawlEmpty',
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
  const context = vm.createContext({ console, Date, window })
  const file = path.join(root, 'src/ts/download/AutomationStatus.ts')
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
    if (name === './DownloadDiagnostics')
      return { downloadDiagnostics: diagnostics }
    if (name === './Resume') return { resume }
    if (name === '../EVT') return { EVT }
    if (name === '../store/Store') return { store }
    throw new Error(`unexpected require ${name}`)
  }, exports)
  return {
    exports,
    context,
    store,
    controller,
    fire(name) {
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
    busy: false, downloading: false, pause: true, stop: false, resultLength: 3,
  }
  const h = harness(controller, { total: 3 })
  h.fire('crawlComplete')
  h.fire('downloadStart')
  h.fire('downloadPause')
  assert.equal((await h.exports.getAutomationStatus()).phase, 'PAUSED_RESUMABLE')
})

test('new crawlComplete or resultChange clears stale completed-download state', async () => {
  const controller = {
    busy: false, downloading: false, pause: false, stop: false, resultLength: 3,
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
  assert.equal((await h.context.__PBD_AUTOMATION_STATUS__()).phase, 'IDLE')
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
  const metaByUrl = new Map(Object.entries(options.metaByUrl || {}))
  const dataById = new Map(Object.entries(options.dataById || {}).map(([k, v]) => [Number(k), v]))
  const statesById = new Map(Object.entries(options.statesById || {}).map(([k, v]) => [Number(k), v]))
  class IndexedDB {
    async open() {}
    async get(storeName, key, index) {
      getCalls.push([storeName, key, index])
      if (storeName === 'taskMeta' && index === 'url') return metaByUrl.get(key) || null
      if (storeName === 'taskMeta') {
        return [...metaByUrl.values()].find((item) => item.id === key) || null
      }
      if (storeName === 'taskData') {
        const value = dataById.get(key)
        return typeof value === 'function' ? value() : value ?? null
      }
      if (storeName === 'taskStates') return statesById.get(key) || null
      return null
    }
    async put(storeName, value) {
      putCalls.push([storeName, value])
      if (storeName === 'taskMeta') metaByUrl.set(value.url, value)
    }
    async add() {}
    async delete() {}
    async clear() {}
    openCursor() {}
  }
  const EVT = {
    list: {
      pageSwitch: 'pageSwitch', settingInitialized: 'settingInitialized',
      crawlComplete: 'crawlComplete', resultChange: 'resultChange',
      downloadSuccess: 'downloadSuccess', skipDownload: 'skipDownload',
      downloadComplete: 'downloadComplete', downloadStop: 'downloadStop',
      clearSavedCrawl: 'clearSavedCrawl', resume: 'resume',
    },
    fire(name) { fired.push(name) },
  }
  const window = {
    location,
    addEventListener(name, callback) {
      const callbacks = listeners.get(name) || []
      callbacks.push(callback)
      listeners.set(name, callbacks)
    },
    setInterval() { return 1 },
  }
  const localStorage = {
    getItem() { return String(Date.now()) },
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
    replace(value) { this.states = value },
    downloadedCount() { return 0 },
    summary() { return { total: this.states.length, pending: this.states.length, inProgress: 0, completed: 0 } },
  }
  const context = vm.createContext({ console, Date, window, localStorage })
  const file = path.join(root, 'src/ts/download/Resume.ts')
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  vm.runInContext(`(function(require, exports) {${compiled}\n})`, context, { filename: file })((name) => {
    if (name === '../EVT') return { EVT }
    if (name === '../Log') return { log: { log() {}, success() {}, warning() {}, error() {} } }
    if (name === '../Language') return { lang: { transl: (value) => value } }
    if (name === '../store/Store') return { store }
    if (name === '../store/States') return { states }
    if (name === './DownloadStates') return { downloadStates }
    if (name === '../utils/IndexedDB') return { IndexedDB }
    if (name === '../utils/Utils') return { Utils: { isPixiv: () => true } }
    if (name === '../Toast') return { toast: { success() {} } }
    throw new Error(`unexpected require ${name}`)
  }, exports)
  return { ...exports, context, window, store, states, downloadStates, fired, getCalls, putCalls }
}

test('Resume status uses metadata summary without cloning taskStates', async () => {
  const url = 'https://www.pixiv.net/en/users/1'
  const h = createResumeHarness({
    url,
    metaByUrl: {
      [url]: {
        id: 101, url, URLWhenCrawlStart: url, part: 1,
        date: new Date('2026-10-03T00:00:00Z'),
        stateSummary: { total: 50000, pending: 123, inProgress: 2, completed: 49875 },
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
  const chunk = new Promise((resolve) => { resolveChunk = resolve })
  const h = createResumeHarness({
    url: urlA,
    initialResults: [{ id: 'keep-current' }],
    metaByUrl: {
      [urlA]: {
        id: 100, url: urlA, URLWhenCrawlStart: urlA, part: 1,
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
  const EVT = { list: { crawlComplete: 'crawlComplete', resultChange: 'resultChange' } }
  const window = { addEventListener(name, callback) { listeners.set(name, callback) } }
  const context = vm.createContext({ window })
  const file = path.join(root, 'src/ts/download/DownloadStates.ts')
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  vm.runInContext(`(function(require, exports) {${compiled}\n})`, context, { filename: file })((name) => {
    if (name === '../EVT') return { EVT }
    if (name === '../store/Store') return { store }
    throw new Error(`unexpected require ${name}`)
  }, exports)
  const ds = exports.downloadStates
  ds.init()
  assert.deepEqual({ ...ds.summary() }, { total: 4, pending: 4, inProgress: 0, completed: 0 })
  ds.setState(0, 0)
  ds.setState(0, 1)
  ds.setState(1, 1)
  assert.equal(ds.downloadedCount(), 2)
  assert.deepEqual({ ...ds.summary() }, { total: 4, pending: 2, inProgress: 0, completed: 2 })
})

test('imported results bind the queue to the current page URL', async () => {
  const listeners = new Map()
  const fired = []
  const window = {
    location: { href: 'https://www.pixiv.net/en/users/9#works' },
    addEventListener(name, callback) { listeners.set(name, callback) },
  }
  const EVT = {
    list: { importResult: 'importResult', crawlComplete: 'crawlComplete' },
    fire(name) { fired.push(name) },
  }
  const store = {
    result: [],
    URLWhenCrawlStart: 'https://www.pixiv.net/en/users/old',
    crawlCompleteTime: new Date(0),
    reset() { this.result = [] },
    addResult(value) { this.result.push(value) },
  }
  const imported = {
    idNum: 1, id: '1', original: 'https://example.invalid/1.jpg',
    type: 0, ext: 'jpg', pageCount: 1,
  }
  const context = vm.createContext({ console, Date, window })
  const file = path.join(root, 'src/ts/download/ImportResult.ts')
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  vm.runInContext(`(function(require, exports) {${compiled}\n})`, context, { filename: file })((name) => {
    if (name === '../EVT') return { EVT }
    if (name === '../store/StoreType') return {}
    if (name === '../Language') return { lang: { transl: (value) => value } }
    if (name === '../utils/Utils') return { Utils: { loadJSONFile: async () => [imported] } }
    if (name === '../store/States') return { states: { busy: false } }
    if (name === '../store/Store') return { store }
    if (name === '../Toast') return { toast: { error() {} } }
    if (name === '../MsgBox') return { msgBox: { error() {}, warning() {}, success() {} } }
    if (name === '../filter/Filter') return { filter: { check: async () => true } }
    if (name === '../Tools') return { Tools: { getWorkTypeString: () => 'artwork' } }
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
