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
