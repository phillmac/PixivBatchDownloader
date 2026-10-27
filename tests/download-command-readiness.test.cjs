const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

test('busy result changes keep native preparation available after pause', () => {
  const listeners = new Map()
  const timers = []
  const states = { busy: true, downloading: true }
  const store = { result: [{ id: '1' }, { id: '2' }] }
  const window = {
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    setTimeout(fn) {
      timers.push(fn)
      return timers.length
    },
    clearTimeout() {},
  }
  const EVT = {
    list: new Proxy({}, { get: (_, key) => key }),
    fire(name) {
      if (name === 'downloadPause') states.busy = states.downloading = false
      for (const fn of listeners.get(name) || []) fn({ type: name })
    },
  }
  const dependencies = {
    'webextension-polyfill': {
      default: { runtime: { onMessage: { addListener() {} } } },
    },
    '../EVT': { EVT },
    '../store/States': { states },
    '../store/Store': { store },
    './ManagedCrawlAutomation': { managedCrawlBlocksDownload: () => false },
    './DownloadDiagnostics': { downloadDiagnostics: { finishAll() {} } },
    '../Log': { log: { warning() {}, log() {} } },
    '../Language': { lang: { transl: (s) => s } },
  }
  const exports = {}
  const source = fs
    .readFileSync(
      path.join(__dirname, '../src/ts/download/DownloadControl.ts'),
      'utf8'
    )
    .replace('new DownloadControl()', 'exports.Controller = DownloadControl')
  const context = vm.createContext({
    exports,
    window,
    console,
    require: (key) => dependencies[key] || {},
  })
  vm.runInContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    context
  )
  const ctl = Object.create(exports.Controller.prototype)
  ctl.automationPrepared = true
  ctl.pause = false
  ctl.stop = false
  ctl.bindEvents()
  EVT.fire('resultChange')
  assert.equal(ctl.automationPrepared, true)
  while (timers.length) timers.shift()()
  assert.equal(ctl.automationPrepared, true)
  ctl.pauseDownload()
  assert.equal(states.downloading, false)
  assert.equal(ctl.automationPrepared, true)
  EVT.fire('resultChange')
  assert.equal(
    ctl.automationPrepared,
    false,
    'idle queue replacement waits for delayed native preparation'
  )
})

/** 使用真实控制器方法，延迟内部重试睡眠以检查暂停/停止竞态。 */
function retryHarness() {
  const states = { busy: true, downloading: true }
  const store = { result: [{ id: '1' }] }
  let finishSleep
  let sleepCalls = 0
  let starts = 0
  const events = []
  const sleep = new Promise((resolve) => {
    finishSleep = resolve
  })
  const dependencies = {
    '../store/States': { states },
    '../store/Store': { store },
    '../EVT': {
      EVT: {
        fire(name) {
          events.push(name)
          if (name === 'downloadPause' || name === 'downloadStop') {
            states.busy = states.downloading = false
          }
        },
      },
    },
    './DownloadDiagnostics': { downloadDiagnostics: { finishAll() {} } },
    '../Log': { log: { warning() {}, error() {}, log() {} } },
    '../Language': { lang: { transl: (s) => s } },
    '../utils/Utils': {
      Utils: {
        sleep() {
          sleepCalls++
          return sleep
        },
      },
    },
  }
  const exports = {}
  const source = fs
    .readFileSync(
      path.join(__dirname, '../src/ts/download/DownloadControl.ts'),
      'utf8'
    )
    .replace('new DownloadControl()', 'exports.Controller = DownloadControl')
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    { exports, require: (key) => dependencies[key] || {} }
  )
  const ctl = Object.create(exports.Controller.prototype)
  Object.assign(ctl, {
    pause: false,
    pauseReason: null,
    stop: false,
    taskBatch: 1,
    downloaded: 0,
    errorIdList: ['1'],
  })
  ctl.startDownload = () => {
    starts++
    ctl.reset()
    ctl.taskBatch++
  }
  return {
    ctl,
    states,
    events,
    finishSleep,
    starts: () => starts,
    sleepCalls: () => sleepCalls,
  }
}

test('internal tail retry is classified and restarts once after its delay', async () => {
  const h = retryHarness()
  const pending = h.ctl.checkCompleteWithError()
  assert.equal(h.ctl.pauseReason, 'retry-errors')
  await h.ctl.checkCompleteWithError()
  assert.equal(h.sleepCalls(), 1)
  h.finishSleep()
  await pending
  assert.equal(h.starts(), 1)
  assert.equal(h.ctl.pauseReason, null)
})

for (const action of [
  'user',
  'automation',
  'pixiv-warning',
  'stop',
  'queue-replaced',
]) {
  test(`${action} cancels an internal retry before it can restart the queue`, async () => {
    const h = retryHarness()
    const pending = h.ctl.checkCompleteWithError()
    if (action === 'stop') h.ctl.stopDownload()
    else if (action === 'queue-replaced') {
      h.ctl.reset()
      h.ctl.taskBatch++
    } else h.ctl.pauseDownload(action)
    h.finishSleep()
    await pending
    assert.equal(h.starts(), 0)
  })
}

for (const reason of ['user', 'automation', 'pixiv-warning']) {
  test(`${reason} cancels a retry without releasing concurrent bookmarking`, async () => {
    const h = retryHarness()
    const pending = h.ctl.checkCompleteWithError()
    h.states.busy = true
    h.states.bookmarkMode = true
    h.ctl.pauseDownload(reason)
    assert.equal(h.ctl.pauseReason, reason)
    assert.equal(h.states.busy, true)
    assert.equal(h.states.bookmarkMode, true)
    assert.deepEqual(h.events, ['downloadPause', 'downloadPauseReasonChange'])
    h.finishSleep()
    await pending
    assert.equal(h.starts(), 0)
    assert.equal(h.states.busy, true)
  })
}
