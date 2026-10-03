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
