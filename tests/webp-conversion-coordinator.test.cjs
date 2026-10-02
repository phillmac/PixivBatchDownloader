const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function harness() {
  const events = new EventTarget()
  const calls = []
  const browser = { runtime: { getManifest: () => ({ version: 'test' }) } }
  const settings = {
    convertUgoiraThread: 3,
    downloadThread: 6,
    ugoiraSaveAsWebP: true,
    ugoiraSaveAsWebM: true,
    ugoiraSaveAsGIF: true,
    ugoiraSaveAsAPNG: true,
    ugoiraSaveAsZIP: true,
    ugoiraSaveAsUgoira: true,
  }
  const EVT = {
    list: { settingChange: 'settingChange', convertSuccess: 'convertSuccess' },
    fire(name) {
      events.dispatchEvent(new Event(name))
    },
  }
  const toWebP = {
    convert() {
      const job = deferred()
      calls.push(job)
      return job.promise.then((value) => {
        EVT.fire('convertSuccess')
        return value
      })
    },
  }
  const mocks = {
    'webextension-polyfill': { default: browser },
    '../EVT': { EVT },
    '../setting/Settings': { settings },
    '../store/States': { states: { downloading: true } },
    '../Tools': {
      Tools: {
        getJPGContentIndex: () => [0],
        extractImage: async () => [{ width: 2, height: 2, close() {} }],
      },
    },
    '../utils/Utils': {
      Utils: { sleep: () => new Promise((resolve) => setTimeout(resolve, 1)) },
    },
    './ToWebP': { toWebP },
    './ToGIF': { toGIF: { convert: async () => new Blob() } },
    './ToAPNG': { toAPNG: { convert: async () => new Blob() } },
    './ToWebMUseWhammy': { toWebM: { convert: async () => new Blob() } },
    './APNGDiagnostics': { APNGDiagnostics: class {} },
  }
  const context = vm.createContext({
    Blob,
    console,
    window: {
      addEventListener: events.addEventListener.bind(events),
      clearTimeout() {},
      setTimeout() {
        return 1
      },
    },
  })
  const file = path.join(root, 'src/ts/ConvertUgoira/ConvertUgoira.ts')
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const exports = {}
  const moduleRequire = (name) => {
    if (name in mocks) return mocks[name]
    throw new Error(`Unexpected import: ${name}`)
  }
  vm.runInContext(`(function(require, exports) {${compiled}\n})`, context, {
    filename: file,
  })(moduleRequire, exports)
  return { coordinator: exports.convertUgoira, calls }
}

const info = {
  mime_type: 'image/jpeg',
  frames: [{ file: '000000.jpg', delay: 80 }],
}

test('only one WebP conversion may materialize pixels at a time', async () => {
  const h = harness()
  const first = h.coordinator.webp(new Blob(['a']), info, 1)
  const second = h.coordinator.webp(new Blob(['b']), info, 2)

  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(h.calls.length, 1)

  h.calls[0].resolve(new Blob(['first']))
  await first
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(h.calls.length, 2)

  h.calls[1].resolve(new Blob(['second']))
  await second
  assert.equal(h.coordinator.webpActive, 0)
})

test('failed WebP conversion releases the dedicated WebP slot', async () => {
  const h = harness()
  const first = h.coordinator.webp(new Blob(['a']), info, 1)
  const second = h.coordinator.webp(new Blob(['b']), info, 2)

  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(h.calls.length, 1)

  h.calls[0].reject(new Error('worker timeout'))
  await assert.rejects(first, /worker timeout/)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(h.calls.length, 2)

  h.calls[1].resolve(new Blob(['second']))
  await second
  assert.equal(h.coordinator.webpActive, 0)
})
