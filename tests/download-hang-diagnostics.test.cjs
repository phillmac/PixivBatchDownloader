const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { diagnosticsLoader } = require('./helpers/diagnostics-harness.cjs')

const root = path.resolve(__dirname, '..')

function harness() {
  const timers = new Map()
  const listeners = []
  const messages = []
  const elements = new Map()
  let timerId = 0
  const h = {
    now: 0,
    timers,
    listeners,
    messages,
    elements,
    workerResponse: undefined,
  }
  const browser = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      async sendMessage(msg) {
        messages.push(msg)
        if (msg.msg === 'get_download_worker_diagnostics') {
          if (h.workerResponse) return h.workerResponse
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
    console: { warn() {}, error() {} },
    TextEncoder,
    Date,
    location: { href: 'https://www.pixiv.net/test' },
    document,
    window,
    performance: { now: () => h.now },
  })
  const load = diagnosticsLoader(context, { 'webextension-polyfill': browser })
  const exports = load('download/DownloadDiagnostics.ts')
  h.serialization = load('download/DiagnosticSerialization.ts')
  h.queueSnapshot = load(
    'download/DownloadDiagnosticSnapshot.ts'
  ).downloadQueueSnapshot
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
  assert.ok(snap.recentEvents.length <= 240)
  assert.ok(snap.recentEventsOmitted > 0)
  assert.equal(snap.recentEvents.at(-1).stage, 'stage-399')
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

test('report keeps the page snapshot captured before worker lookup completes', async () => {
  const h = harness()
  const d = h.downloadDiagnostics
  const id = d.start({
    workId: 'delayed-worker',
    index: 2,
    progressBarIndex: 0,
    taskBatch: 900,
    workType: 3,
  })
  let resolveWorker
  h.workerResponse = new Promise((resolve) => {
    resolveWorker = resolve
  })

  const details = { nested: { value: 'captured' } }
  d.enter(id, 'waiting-worker', details)
  const reportPromise = d.getReport()
  const live = d.active.get(id)
  live.timeline[0].stage = 'mutated-entry'
  live.timeline.push({ stage: 'mutated-array' })
  details.nested.value = 'mutated-details'
  d.enter(id, 'advanced-during-worker-snapshot')
  d.finish(id, 'completed-during-worker-snapshot')
  resolveWorker({ marker: 'late-worker-snapshot' })
  const report = await reportPromise

  assert.equal(report.worker.marker, 'late-worker-snapshot')
  assert.equal(report.activeTasks[0].workId, 'delayed-worker')
  assert.equal(report.activeTasks[0].stage, 'waiting-worker')
  assert.equal(report.activeTasks[0].timeline.length, 2)
  assert.equal(report.activeTasks[0].timeline[0].stage, 'created')
  assert.equal(report.recentEvents.at(-1).details.nested.value, 'captured')
  assert.equal(d.pageSnapshot().activeTasks.length, 0)
})

test('ugoira and lease terminal failures record the cause before downloadError retry handling', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/ts/download/Download.ts'),
    'utf8'
  )
  const conversion = source.indexOf("'conversion-error'")
  const conversionRetry = source.indexOf("EVT.fire('downloadError', result.id)")
  assert.ok(conversion >= 0)
  assert.ok(conversionRetry > conversion)
  assert.match(source, /artworkId:\s*result\.idNum/)
  assert.match(source, /format,/)
  assert.match(source, /downloadDiagnostics\.errorDetails\(error\)/)

  const lease = source.indexOf("'global-lease-retry-max'")
  const leaseRetry = source.indexOf("EVT.fire('downloadError', arg.id)")
  assert.ok(lease >= 0)
  assert.ok(leaseRetry > lease)
})

test('Whammy streaming wait propagates worker error and messageerror immediately', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/ts/ConvertUgoira/ToWebMUseWhammy.ts'),
    'utf8'
  )
  assert.match(source, /addEventListener\('error', errorHandler\)/)
  assert.match(
    source,
    /addEventListener\('messageerror', messageErrorHandler\)/
  )
  assert.match(source, /Whammy worker error waiting for \$\{expectedType\}/)
  assert.match(
    source,
    /Whammy worker messageerror waiting for \$\{expectedType\}/
  )
  assert.match(source, /removeEventListener\('error', errorHandler\)/)
  assert.match(
    source,
    /removeEventListener\('messageerror', messageErrorHandler\)/
  )
})

test('large queue snapshot retains totals, active and recent details within explicit bytes', () => {
  const h = harness()
  const states = Array(12000).fill(1)
  states[10] = 0
  states[8000] = -1
  const tasks = Object.fromEntries(
    states.map((_, index) => [
      `${index}-日本語😀`,
      { index, progressBarIndex: index % 6 },
    ])
  )
  const snapshot = h.queueSnapshot(states, tasks)
  assert.equal(snapshot.downloadStateSummary.total, 12000)
  assert.equal(snapshot.downloadStateSummary.completed, 11998)
  assert.equal(snapshot.downloadStateSummary.inProgress, 1)
  assert.equal(snapshot.downloadStateSummary.pending, 1)
  assert.equal(snapshot.taskListTotal, 12000)
  assert.equal(snapshot.taskListOmitted + snapshot.taskList.length, 12000)
  assert.equal(
    snapshot.downloadStatesOmitted + snapshot.downloadStates.length,
    12000
  )
  assert.equal(snapshot.taskList[0].index, 10)
  assert.equal(snapshot.taskList[1].index, 11999)
  assert.equal(snapshot.downloadStates[0].index, 10)
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 26 * 1024)
  h.downloadDiagnostics.setPageStateProvider(() => snapshot)
  const page = h.downloadDiagnostics.pageSnapshot()
  assert.ok(
    Buffer.byteLength(JSON.stringify(page)) <=
      h.serialization.diagnosticLimits.page
  )
  assert.equal(page.controller.taskListTotal, 12000)
  assert.equal(page.schemaVersion, 2)
  assert.equal(page.diagnosticsVersion, 'download-hang-v2-bounded')
  // 验证控制器只在完整诊断路径调用此辅助函数。
  const control = fs.readFileSync(
    path.join(root, 'src/ts/download/DownloadControl.ts'),
    'utf8'
  )
  const automation = control
    .split('setAutomationStateProvider')[1]
    .split('const statusTipWrap')[0]
  assert.doesNotMatch(
    automation,
    /downloadQueueSnapshot|taskList|downloadStates/
  )
  h.downloadDiagnostics.setAutomationStateProvider(() => ({
    remainingDownload: 2,
  }))
  h.downloadDiagnostics.setPageStateProvider(() => {
    throw new Error('must not poll full snapshot')
  })
  assert.equal(h.downloadDiagnostics.automationSnapshot().remainingDownload, 2)
})

test('oversized unicode, cyclic values and throwing accessors stay bounded and serializable', async () => {
  const h = harness()
  const d = h.downloadDiagnostics
  const { diagnosticRecord, diagnosticLimits } = h.serialization
  const details = {
    text: '日本語😀\\\n'.repeat(100000),
    bigint: 10n,
    toJSON() {
      throw new Error('must not execute toJSON')
    },
    get broken() {
      throw new Error('getter')
    },
  }
  details.cycle = details
  const safe = diagnosticRecord(details)
  const json = JSON.stringify(safe)
  assert.ok(Buffer.byteLength(json) <= diagnosticLimits.detail)
  assert.ok(safe.diagnosticSerialization.truncatedValues > 0)
  assert.ok(safe.diagnosticSerialization.serializationErrors > 0)
  assert.doesNotMatch(safe.text, /[\uD800-\uDBFF]$/u)
  const id = d.start({
    workId: '1',
    index: 0,
    progressBarIndex: 0,
    taskBatch: 1,
    workType: 0,
  })
  for (let i = 0; i < 400; i++) d.enter(id, 'stage-' + i, details)
  const page = d.pageSnapshot()
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= diagnosticLimits.page)
  assert.ok(
    Buffer.byteLength(JSON.stringify(d.events)) <= diagnosticLimits.collection
  )
  assert.equal(page.recentEvents.at(-1).stage, 'stage-399')
  h.workerResponse = { details, tasks: Array(5000).fill(details) }
  const report = await d.getReport()
  assert.ok(
    Buffer.byteLength(JSON.stringify(report)) <= diagnosticLimits.report
  )
  d.finishAll('done')
})

test('thousands of unfinished diagnostics bound records, event bytes and watchdogs', () => {
  const h = harness()
  const d = h.downloadDiagnostics
  for (let index = 0; index < 4000; index++)
    d.start({
      workId: String(index),
      index,
      progressBarIndex: 0,
      taskBatch: 1,
      workType: 0,
    })
  const page = d.pageSnapshot()
  assert.equal(page.evictedTasks, 4000 - 256)
  assert.equal(page.activeTasksTotal, 256)
  assert.equal(page.activeTasksOmitted + page.activeTasks.length, 256)
  assert.equal(h.timers.size, 256)
  assert.ok(
    Buffer.byteLength(JSON.stringify(page)) <=
      h.serialization.diagnosticLimits.page
  )
  d.finishAll('done')
  assert.equal(h.timers.size, 0)
})

test('watchdog fallback survives failed persistence and hostile provider data', async () => {
  const h = harness()
  const d = h.downloadDiagnostics
  d.setPageStateProvider(() => ({
    get bad() {
      throw new Error('snapshot getter')
    },
  }))
  d.start({
    workId: '1',
    index: 0,
    progressBarIndex: 0,
    taskBatch: 1,
    workType: 0,
  })
  h.workerResponse = Promise.reject(new Error('worker unavailable'))
  // 避免测试本身在计时器触发前产生未处理的拒绝。
  h.workerResponse.catch(() => undefined)
  h.now += h.DOWNLOAD_DIAGNOSTIC_TIMEOUT_MS
  ;[...h.timers.values()][0].fn()
  await h.flush()
  assert.ok(h.elements.get('xz-download-hang-diagnostic').textContent)
  const stored = h.messages.find(
    (message) => message.msg === 'record_download_hang_diagnostic'
  )
  assert.ok(stored.report.worker.unavailable)
  assert.ok(stored.report.diagnosticSerialization)
})
