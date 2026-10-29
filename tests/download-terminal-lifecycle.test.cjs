/** Node 断言。 */
const assert = require('node:assert/strict')
/** 读取控制器源码，仅移除自动创建 UI 实例的入口。 */
const fs = require('node:fs')
/** 源码路径。 */
const path = require('node:path')
/** 串行 Node 测试。 */
const test = require('node:test')
/** 隔离页面和 worker 环境。 */
const vm = require('node:vm')
/** 执行实际 TypeScript 方法。 */
const ts = require('typescript')
/** 复用诊断模块的真实源码加载器。 */
const { diagnosticsLoader } = require('./helpers/diagnostics-harness.cjs')

/** 可手动结算的 I/O，不启动真实计时器或网络。 */
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** 排空有限的 Promise 链，不等待原生延迟。 */
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

/** 真实诊断和状态模块，浏览器、时钟、转换器和网络使用最小替身。 */
function harness() {
  const h = {
    timers: new Map(),
    listeners: new Map(),
    runtimeListeners: [],
    sent: [],
    deliveries: [],
    nativeDownloads: [],
    revoked: [],
    events: [],
    sleeps: [],
    stored: { batchNo: {}, idList: {} },
    states: { busy: true, downloading: true },
    store: { result: [{ id: 'work', type: 2, index: 0 }] },
    settings: { imageSize: 'original', ugoiraSaveAsWebP: true },
    now: 0,
  }
  let timerId = 0
  const noop = () => {}
  const window = {
    addEventListener(name, listener) {
      if (!h.listeners.has(name)) h.listeners.set(name, [])
      h.listeners.get(name).push(listener)
    },
    setTimeout(fn, ms) {
      const id = ++timerId
      h.timers.set(id, { fn, ms })
      return id
    },
    clearTimeout: (id) => h.timers.delete(id),
  }
  h.EVT = {
    list: new Proxy({}, { get: (_, key) => key }),
    fire(name, data) {
      h.events.push({ name, data })
      if (h.eventFailure === name) throw new Error('native handoff failed')
      for (const listener of h.listeners.get(name) || []) {
        listener({ type: name, detail: { data } })
      }
    },
  }
  h.browser = {
    action: { onClicked: { addListener: noop } },
    runtime: {
      onInstalled: { addListener: noop },
      onConnect: { addListener: noop },
      onMessage: { addListener: (fn) => h.runtimeListeners.push(fn) },
      async sendMessage(message) {
        h.sent.push(message)
        return { stored: true }
      },
    },
    tabs: {
      onRemoved: { addListener: noop },
      onUpdated: { addListener: noop },
      sendMessage(tabId, message) {
        const delivery = { ...deferred(), tabId, message }
        h.deliveries.push(delivery)
        return delivery.promise
      },
    },
    downloads: {
      onChanged: { addListener: (fn) => (h.onChanged = fn) },
      async download(options) {
        h.nativeDownloads.push(options)
        return h.nativeDownloads.length
      },
      async search({ id }) {
        return [{ id, state: 'complete', bytesReceived: 3, totalBytes: 3 }]
      },
    },
    storage: {
      local: {
        async get() {
          return structuredClone(h.stored)
        },
        async set(data) {
          Object.assign(h.stored, structuredClone(data))
        },
      },
    },
  }
  h.utils = {
    replaceExtension: (name, extension) => name.replace(/\.[^.]+$/, extension),
    sleep(ms) {
      const sleep = { ...deferred(), ms }
      h.sleeps.push(sleep)
      return sleep.promise
    },
  }
  h.fetch = async () => new Response(new Uint8Array([1, 2, 3]))
  h.converted = new Blob(['converted'])
  h.dependencies = {
    'webextension-polyfill': h.browser,
    '../EVT': { EVT: h.EVT },
    '../Log': { log: { error: noop, warning: noop, log: noop } },
    '../Language': { lang: { transl: (value) => value } },
    '../FileName': { fileName: { createFileName: () => 'work.zip' } },
    '../ConvertUgoira/ConvertUgoira': {
      convertUgoira: {
        async webp() {
          if (h.conversionFailure) throw new Error('conversion exploded')
          return h.converted
        },
      },
    },
    './ProgressBar': {
      progressBar: {
        setProgress: noop,
        setProgressThrottle: noop,
        errorColor: noop,
      },
    },
    '../filter/Filter': {},
    './DownloadRecord': {
      downloadRecord: { checkDeduplication: () => new Promise(noop) },
    },
    '../setting/Settings': { settings: h.settings },
    './MakeSingleNovelFile': {},
    '../utils/Utils': { Utils: h.utils },
    '../Config': { Config: { retryMax: 2 } },
    '../MsgBox': {},
    '../store/States': { states: h.states },
    '../store/Store': { store: h.store },
    '../Tools': { Tools: { createWorkLink: (id) => id } },
    './DownloadInterval': { downloadInterval: { async wait() {} } },
    './SettingPersistence': { handleSettingPatch: () => undefined },
    './CrawlRateCoordinator': {},
    './ManageFollowing': {},
    './CheckDownloadCount': {},
  }
  h.context = vm.createContext({
    console: { error: noop, warn: noop },
    window,
    Date,
    TextEncoder,
    Blob,
    AbortController,
    URL: {
      createObjectURL: () => 'blob:prepared',
      revokeObjectURL: (url) => h.revoked.push(url),
    },
    performance: { now: () => h.now },
    navigator: { userAgent: 'Chrome' },
    setInterval: noop,
    fetch: (...args) => h.fetch(...args),
    location: { href: 'https://www.pixiv.net/test' },
    document: { title: 'test', visibilityState: 'visible' },
  })
  h.load = diagnosticsLoader(h.context, h.dependencies)
  h.diagnostics = h.load('download/DownloadDiagnostics.ts').downloadDiagnostics
  h.downloadStates = h.load('download/DownloadStates.ts').downloadStates
  h.downloadStates.replace([0])
  h.Download = h.load('download/Download.ts').Download
  const leaseModule = h.load('download/GlobalDownloadLease.ts')
  h.LeaseLostError = leaseModule.GlobalDownloadLeaseLostError
  h.lease = { async renew() {}, async release() {} }
  leaseModule.GlobalDownloadLease.acquire = async () => h.lease
  h.start = () =>
    h.diagnostics.start({
      workId: 'work',
      index: 0,
      progressBarIndex: 0,
      taskBatch: 25,
      workType: 2,
    })
  h.active = (id) => h.diagnostics.active.get(id)
  h.stages = (id) =>
    h.diagnostics.events
      .filter((event) => event.diagnosticId === id)
      .map((event) => event.stage)
  return h
}

/** 加载真实控制器，仅跳过 UI 构造函数，保留事件和推进/重试实现。 */
function controller(h) {
  const source = fs
    .readFileSync(
      path.join(__dirname, '../src/ts/download/DownloadControl.ts'),
      'utf8'
    )
    .replace('new DownloadControl()', 'exports.Controller = DownloadControl')
  const exports = {}
  const dependencies = {
    ...h.dependencies,
    './DownloadDiagnostics': { downloadDiagnostics: h.diagnostics },
    './DownloadStates': { downloadStates: h.downloadStates },
    '../download/Download': { Download: h.Download },
  }
  vm.runInContext(
    `(function(require, exports) {${
      ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText
    }\n})`,
    h.context
  )((name) => dependencies[name] || {}, exports)
  const ctl = Object.create(exports.Controller.prototype)
  Object.assign(ctl, {
    taskBatch: 25,
    taskList: { work: { index: 0, progressBarIndex: 0 } },
    pause: false,
    stop: false,
    downloaded: 0,
    thread: 1,
    errorIdList: [],
  })
  // UI 统计不属于本测试，队列状态更新仍走实际 downloadOrSkipAFile。
  ctl.setDownloaded = () => {
    ctl.downloaded = h.downloadStates.downloadedCount()
  }
  ctl.checkCompleteWithError = () => {
    h.tailChecks = (h.tailChecks || 0) + 1
  }
  ctl.bindEvents()
  h.pageListener = h.runtimeListeners.at(-1)
  return ctl
}

/** 建立单次尝试，直接 await 下载方法来验证真实转换及异常控制流。 */
function attempt(h) {
  const task = Object.create(h.Download.prototype)
  Object.assign(task, {
    diagnosticId: h.start(),
    retry: 0,
    leaseLossRetry: 0,
    retryInterval: [],
    progressBarIndex: 0,
    downloadStatesIndex: 0,
    error: false,
    skip: false,
  })
  task.checkSize = async () => true
  task.checkColor = async () => {}
  task.waitPreviousFileDownload = async () => {}
  const arg = {
    id: 'work',
    index: 0,
    progressBarIndex: 0,
    taskBatch: 25,
    result: {
      id: 'work',
      idNum: 123,
      type: 2,
      index: 0,
      original: 'https://example.invalid/work.zip',
      ugoiraInfo: { frames: [] },
    },
  }
  return { task, arg, id: task.diagnosticId }
}

/** 页面实际接收的保存结果。 */
function pageResult(id, msg = 'downloaded', err = '') {
  return {
    msg,
    err,
    data: {
      id: 'work',
      diagnosticId: id,
      browserDownloadId: 77,
      blobURLFront: 'blob:front',
    },
  }
}

for (const outcome of ['success', 'state-error', 'handoff-error']) {
  test(`skip event finishes only after native advancement: ${outcome}`, () => {
    const h = harness()
    const ctl = controller(h)
    const { task, id } = attempt(h)
    const setDownloaded = ctl.setDownloaded
    ctl.setDownloaded = () => {
      assert.equal(h.active(id).stage, 'skip-advancement-pending')
      if (outcome === 'state-error') throw new Error('state failed')
      setDownloaded()
    }
    if (outcome === 'handoff-error') {
      h.store.result.push({ id: 'next' })
      ctl.createDownload = () => {
        throw new Error('handoff failed')
      }
    }
    task.skipDownload({ id: 'work', reason: 'duplicate', type: 2 })
    const event = h.events.find((event) => event.name === 'skipDownload')
    assert.equal(event.data.diagnosticId, id)
    assert.equal(event.data.reason, 'duplicate')
    assert.equal(event.data.type, 2)
    assert.equal(!!h.active(id), outcome !== 'success')
    assert.equal(h.diagnostics.watchdogs.has(id), outcome !== 'success')
    assert.equal(h.stages(id).includes('skipped'), outcome === 'success')
  })
}

test('skip without an advancement listener stays diagnosable; canceled skip is terminal', () => {
  const h = harness()
  const first = attempt(h)
  first.task.skipDownload({ id: 'work', reason: 'size' })
  assert.equal(h.active(first.id).stage, 'skip-advancement-pending')
  h.states.downloading = false
  const second = attempt(h)
  second.task.skipDownload({ id: 'work', reason: 'size' })
  assert.equal(h.active(second.id), undefined)
  assert.equal(h.diagnostics.watchdogs.has(second.id), false)
  assert.equal(h.stages(second.id).at(-1), 'skip-canceled')
  assert.equal(
    h.events.filter((event) => event.name === 'skipDownload').length,
    1
  )
})

for (const conversion of ['failure', 'success', 'no-conversion']) {
  test(`actual conversion path preserves save semantics: ${conversion}`, async () => {
    const h = harness()
    controller(h)
    const { task, arg, id } = attempt(h)
    h.conversionFailure = conversion === 'failure'
    if (conversion === 'no-conversion') h.settings.ugoiraSaveAsWebP = false
    await task.download(arg)
    await flush()
    const save = h.sent.find((message) => message.msg === 'save_work_file')
    if (conversion === 'failure') {
      assert.equal(task.error, true)
      assert.equal(save, undefined)
      assert.equal(h.downloadStates.states[0], 0)
      assert.equal(h.stages(id).at(-1), 'conversion-error')
      assert.equal(h.stages(id).includes('conversion-complete'), false)
      assert.equal(
        h.events.filter((event) => event.name === 'downloadSuccess').length,
        0
      )
    } else {
      assert.equal(save.diagnosticId, id)
      assert.equal(save.blob, undefined) // Chrome 默认发送 Blob URL。
      assert.equal(
        save.fileName,
        conversion === 'success' ? 'work.webp' : 'work.zip'
      )
      const complete = h.diagnostics.events.find(
        (event) =>
          event.diagnosticId === id && event.stage === 'conversion-complete'
      )
      assert.equal(
        complete.details.blobBytes,
        conversion === 'success' ? h.converted.size : 3
      )
    }
    if (conversion !== 'failure') {
      assert.equal(h.active(id).stage, 'browser-save-message-resolved')
      h.pageListener(pageResult(id))
      assert.equal(h.downloadStates.states[0], 1)
      assert.equal(h.stages(id).at(-1), 'page-download-complete')
    }
    assert.equal(h.active(id), undefined)
    assert.equal(h.diagnostics.watchdogs.has(id), false)
  })
}

for (const advanced of [true, false]) {
  test(`USER_CANCELED keeps watchdog until advancement succeeds: ${advanced}`, () => {
    const h = harness()
    const ctl = controller(h)
    const id = h.start()
    if (!advanced)
      ctl.setDownloaded = () => {
        throw new Error('failed')
      }
    h.pageListener(pageResult(id, 'download_err', 'USER_CANCELED'))
    assert.equal(h.sleeps.length, 0)
    assert.equal(!!h.active(id), !advanced)
    assert.equal(h.diagnostics.watchdogs.has(id), !advanced)
    assert.equal(h.stages(id).includes('page-download-canceled'), advanced)
  })
}

for (const retry of [
  'accepted',
  'sleep-rejected',
  'handoff-threw',
  'no-task',
]) {
  test(`saveFileError retains diagnostics through delayed retry: ${retry}`, async () => {
    const h = harness()
    const ctl = controller(h)
    const id = h.start()
    if (retry === 'handoff-threw')
      ctl.createDownload = () => {
        throw new Error('failed retry')
      }
    if (retry === 'no-task')
      h.downloadStates.getFirstDownloadItem = () => undefined
    h.pageListener(pageResult(id, 'download_err', 'FILE_FAILED'))
    assert.equal(h.sleeps.length, 1)
    assert.equal(h.sleeps[0].ms, 3000)
    assert.equal(h.active(id).stage, 'page-save-retry-pending')
    assert.equal(h.diagnostics.watchdogs.has(id), true)
    assert.equal(h.downloadStates.states[0], 0)
    // 超过五分钟仍未结算的延迟保留真实看门狗；不运行真实计时器。
    h.now += 600000
    assert.equal(h.active(id).stage, 'page-save-retry-pending')
    if (retry === 'sleep-rejected')
      h.sleeps[0].reject(new Error('sleep failed'))
    else h.sleeps[0].resolve()
    await flush()
    assert.equal(!!h.active(id), retry !== 'accepted')
    assert.equal(h.diagnostics.watchdogs.has(id), retry !== 'accepted')
    if (retry === 'accepted') {
      assert.equal(h.stages(id).at(-1), 'page-save-retry-started')
      const next = h.diagnostics.pageSnapshot().activeTasks
      assert.equal(next.length, 1)
      assert.notEqual(next[0].diagnosticId, id)
      assert.equal(next[0].taskBatch, 25)
      assert.equal(next[0].index, 0)
      assert.equal(h.downloadStates.states[0], 0)
    } else if (retry !== 'no-task') {
      assert.equal(h.active(id).stage, 'page-save-retry-rejected')
    }
    assert.equal(
      h.events.filter((event) => event.name === 'saveFileError').length,
      1
    )
    assert.equal(h.sleeps.length, 1)
  })
}

for (const status of [404, 500]) {
  test(`HTTP ${status} at retryMax waits for skip acknowledgement`, async () => {
    const h = harness()
    const ctl = controller(h)
    const { task, arg, id } = attempt(h)
    h.fetch = async () => new Response(null, { status })
    ctl.setDownloaded = () => {
      throw new Error('failed advance')
    }
    await task.download(arg)
    assert.equal(task.retry, 2)
    assert.equal(h.active(id).stage, 'skip-advancement-pending')
    assert.equal(h.diagnostics.watchdogs.has(id), true)
    assert.equal(h.stages(id).includes('skipped'), false)
  })
}

for (const lease of ['terminal', 'nonterminal', 'handoff-error']) {
  test(`actual lease-loss retry path: ${lease}`, async () => {
    const h = harness()
    const { task, arg, id } = attempt(h)
    let renewals = 0
    h.lease.renew = async () => {
      if (lease !== 'nonterminal' || renewals++ === 0)
        throw new h.LeaseLostError()
    }
    if (lease === 'handoff-error') h.eventFailure = 'downloadError'
    if (lease === 'handoff-error')
      await assert.rejects(task.download(arg), /native handoff failed/)
    else await task.download(arg)
    assert.equal(task.leaseLossRetry, lease === 'nonterminal' ? 1 : 2)
    if (lease === 'terminal') {
      assert.equal(h.active(id), undefined)
      assert.equal(h.diagnostics.watchdogs.has(id), false)
      assert.equal(
        h.stages(id).filter((stage) => stage === 'global-lease-lost').length,
        1
      )
      assert.equal(h.sent.length, 0)
    } else {
      assert.ok(h.active(id))
      assert.equal(h.diagnostics.watchdogs.has(id), true)
      assert.equal(h.stages(id).includes('global-lease-lost'), false)
    }
    assert.equal(
      h.events.filter((event) => event.name === 'downloadError').length,
      lease === 'nonterminal' ? 0 : 1
    )
  })
}

/** 执行完整 worker 监听器，替换外部浏览器 I/O。 */
function worker(h) {
  h.workerDiagnostics = h.load(
    'serviceWorker/DownloadWorkerDiagnostics.ts'
  ).downloadWorkerDiagnostics
  h.load('serviceWorker/background.ts')
  h.workerListener = h.runtimeListeners.at(-1)
}

for (const native of ['complete', 'error', 'simulated']) {
  for (const delivered of ['resolved', 'rejected']) {
    test(`worker ${native}: stays active while pending, then ${delivered}`, async () => {
      const h = harness()
      worker(h)
      const message = {
        msg:
          native === 'simulated'
            ? 'save_work_file_a_download'
            : 'save_work_file',
        id: 'work',
        taskBatch: 25,
        diagnosticId: '25:0:1',
        fileName: 'work.webp',
        blobURL: 'blob:front',
      }
      await h.workerListener(message, { tab: { id: 7 } })
      await flush()
      if (native !== 'simulated') {
        const detail =
          native === 'complete'
            ? { id: 1, state: { current: 'complete' } }
            : { id: 1, error: { current: 'FILE_FAILED' } }
        await h.onChanged(detail)
        // 待交付时原生账目已清理，再次通知不重复发送结果。
        await h.onChanged(detail)
        assert.ok(h.revoked.includes('blob:front'))
        if (native === 'error') assert.equal(h.stored.idList[7][0], '')
      }
      assert.equal(h.deliveries.length, 1)
      assert.equal(h.nativeDownloads.length, native === 'simulated' ? 0 : 1)
      const pending = await h.workerDiagnostics.snapshot(7)
      assert.equal(pending.active.length, 1)
      assert.equal(pending.active[0].stage, 'result-message-pending')
      const delivery = h.deliveries[0]
      assert.equal(delivery.tabId, 7)
      assert.equal(
        delivery.message.msg,
        native === 'error' ? 'download_err' : 'downloaded'
      )
      assert.equal(delivery.message.data.diagnosticId, message.diagnosticId)
      if (delivered === 'resolved') delivery.resolve()
      else delivery.reject(new Error('Receiving end does not exist'))
      await flush()
      const settled = await h.workerDiagnostics.snapshot(7)
      assert.equal(settled.active.length, 0)
      assert.ok(
        settled.recentEvents.some(
          (event) =>
            event.stage ===
            (delivered === 'resolved'
              ? 'result-message-resolved'
              : 'result-delivery-failed')
        )
      )
      if (delivered === 'rejected') {
        const report = h.stored.downloadHangDiagnostics[0].report
        assert.equal(report.reason, 'result-message-rejected')
        assert.equal(report.details.diagnosticId, message.diagnosticId)
        assert.equal(report.details.workId, 'work')
        assert.equal(
          report.details.nativeError,
          native === 'error' ? 'FILE_FAILED' : ''
        )
        assert.match(report.details.error, /Receiving end/)
        assert.equal(report.worker.active[0].stage, 'result-message-rejected')
        if (native !== 'simulated') {
          assert.equal(report.details.browserDownloadId, 1)
          assert.equal(report.worker.downloads[0].id, 1)
        }
      } else assert.equal(h.stored.downloadHangDiagnostics, undefined)
      assert.equal(h.deliveries.length, 1)
    })
  }
}
