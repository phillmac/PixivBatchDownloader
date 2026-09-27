const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')

function harness() {
  const timers = new Map()
  const listeners = []
  const messages = []
  const elements = new Map()
  let timerId = 0
  const h = { now: 0, timers, listeners, messages, elements }
  const browser = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      async sendMessage(msg) {
        messages.push(msg)
        if (msg.msg === 'get_download_worker_diagnostics') {
          return { active: [], marker: 'worker-snapshot' }
        }
        return { stored: true }
      },
    },
  }
  const window = {
    setTimeout(fn, ms) {
      const id = ++timerId
      timers.set(id, { fn, ms })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
  }
  const documentElement = {
    append(element) {
      elements.set(element.id, element)
    },
  }
  const document = {
    title: '[↓] 1 stuck tab',
    visibilityState: 'visible',
    documentElement,
    getElementById: (id) => elements.get(id) || null,
    createElement: () => ({
      id: '',
      textContent: '',
      setAttribute() {},
    }),
  }
  const context = vm.createContext({
    console,
    Date,
    location: { href: 'https://www.pixiv.net/test' },
    document,
    window,
    performance: { now: () => h.now },
  })
  const file = path.join(root, 'src/ts/download/DownloadDiagnostics.ts')
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const exports = {}
  vm.runInContext(`(function(require, exports) {${compiled}\n})`, context, {
    filename: file,
  })((name) => {
    if (name === 'webextension-polyfill') return browser
    throw new Error(`unexpected require ${name}`)
  }, exports)
  Object.assign(h, exports)
  h.flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  return h
}

test('stage timeout persists a combined report and page fallback snapshot', async () => {
  const h = harness()
  const d = h.downloadDiagnostics
  d.setPageStateProvider(() => ({ downloaded: 470, total: 471 }))
  const id = d.start({
    workId: '19747764',
    index: 470,
    progressBarIndex: 5,
    taskBatch: 123,
    workType: 3,
  })
  h.now = 100
  d.enter(id, 'novel-blob-ready', { fileName: 'stuck.txt', blobBytes: 81920 })
  h.now = 200
  d.enter(id, 'browser-save-message-resolved')

  assert.equal(h.timers.size, 1)
  const timer = [...h.timers.values()][0]
  assert.equal(timer.ms, h.DOWNLOAD_DIAGNOSTIC_TIMEOUT_MS)

  h.now += timer.ms
  timer.fn()
  await h.flush()

  const snapshot = JSON.parse(
    h.elements.get('xz-download-hang-diagnostic').textContent
  )
  assert.equal(snapshot.controller.downloaded, 470)
  assert.equal(snapshot.activeTasks[0].stage, 'browser-save-message-resolved')
  assert.equal(
    snapshot.activeTasks[0].timeline.at(-1).stage,
    'browser-save-message-resolved'
  )
  assert.ok(
    snapshot.recentEvents.some((event) => event.stage === 'stage-timeout')
  )

  const stored = h.messages.find(
    (message) => message.msg === 'record_download_hang_diagnostic'
  )
  assert.ok(stored)
  assert.equal(stored.report.worker.marker, 'worker-snapshot')
  assert.equal(stored.report.activeTasks[0].workId, '19747764')

  d.finish(id, 'page-download-complete')
  assert.equal(d.pageSnapshot().activeTasks.length, 0)
  assert.equal(h.timers.size, 0)
})

test('progress refreshes the watchdog without flooding the event ring', () => {
  const h = harness()
  const d = h.downloadDiagnostics
  const id = d.start({
    workId: '123',
    index: 0,
    progressBarIndex: 0,
    taskBatch: 456,
    workType: 0,
  })
  d.enter(id, 'fetch-response', { totalBytes: 1000 })
  const firstTimer = [...h.timers.keys()][0]

  h.now = 1500
  d.progress(id, 100, 1000, 'image.jpg')
  const secondTimer = [...h.timers.keys()][0]
  assert.notEqual(secondTimer, firstTimer)
  for (let i = 0; i < 400; i++) {
    h.now += 31000
    d.enter(id, `stage-${i}`)
  }
  const snap = d.pageSnapshot()
  assert.equal(snap.activeTasks[0].timeline.length, 32)
  assert.equal(snap.recentEvents.length, 240)
  d.finish(id, 'done')
})

test('manual diagnostic request returns page and worker state', async () => {
  const h = harness()
  const d = h.downloadDiagnostics
  d.start({
    workId: '999',
    index: 1,
    progressBarIndex: 0,
    taskBatch: 789,
    workType: 3,
  })
  const listener = h.listeners[0]
  const report = await listener({ msg: 'get_download_diagnostics' })
  assert.equal(report.worker.marker, 'worker-snapshot')
  assert.equal(report.activeTasks[0].workId, '999')
})
