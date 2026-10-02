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
  const gifCalls = []
  const apngCalls = []
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
  const toGIF = {
    convert() {
      const job = deferred()
      gifCalls.push(job)
      return job.promise.then((value) => {
        EVT.fire('convertSuccess')
        return value
      })
    },
  }
  const toAPNG = {
    convert() {
      const job = deferred()
      apngCalls.push(job)
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
    './ToGIF': { toGIF },
    './ToAPNG': { toAPNG },
    './ToWebMUseWhammy': { toWebM: { convert: async () => new Blob() } },
    './APNGDiagnostics': {
      APNGDiagnostics: class {
        constructor() {
          this.details = {}
        }
        enter() {}
        failure(error) {
          return error
        }
      },
    },
  }
  const context = vm.createContext({
    Blob,
    console,
    performance: { now: () => Date.now() },
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
  return { coordinator: exports.convertUgoira, calls, gifCalls, apngCalls }
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


test('GIF and APNG share one heavy conversion slot', async () => {
  const h = harness()
  const first = h.coordinator.gif(new Blob(['a']), info, 11)
  const second = h.coordinator.apng(new Blob(['b']), info, 12)

  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(h.gifCalls.length, 1)
  assert.equal(h.apngCalls.length, 0)
  assert.equal(h.coordinator.heavyActive, 1)

  h.gifCalls[0].resolve(new Blob(['gif']))
  await first
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(h.apngCalls.length, 1)

  h.apngCalls[0].resolve(new Blob(['apng']))
  await second
  assert.equal(h.coordinator.heavyActive, 0)
})

test('failed heavy conversion releases the shared GIF/APNG slot', async () => {
  const h = harness()
  const first = h.coordinator.gif(new Blob(['a']), info, 21)
  const second = h.coordinator.apng(new Blob(['b']), info, 22)

  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(h.gifCalls.length, 1)
  assert.equal(h.apngCalls.length, 0)

  h.gifCalls[0].reject(new Error('gif failed'))
  await assert.rejects(first, /gif failed/)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(h.apngCalls.length, 1)

  h.apngCalls[0].resolve(new Blob(['apng']))
  await second
  assert.equal(h.coordinator.heavyActive, 0)
})
