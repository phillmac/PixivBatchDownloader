const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')

function harness({ failFrame = null, stallFrameOnce = null, fastTimeout = false } = {}) {
  const messages = []
  const events = []
  let outstanding = 0
  let maxOutstanding = 0
  let decoded = 0
  let stalled = false
  let createdWorkers = 0
  let terminatedWorkers = 0

  class FakeWorker extends EventTarget {
    constructor() {
      super()
      createdWorkers++
    }
    terminate() {
      terminatedWorkers++
    }
    postMessage(message) {
      messages.push({ type: message.type, index: message.index, delay: message.delay })
      queueMicrotask(() => {
        if (message.type === 'start') {
          this.dispatchEvent(new MessageEvent('message', {
            data: { id: message.id, type: 'ready' },
          }))
          return
        }
        if (message.type === 'frame') {
          message.bitmap.close()
          if (message.index === stallFrameOnce && !stalled) {
            stalled = true
            return
          }
          if (message.index === failFrame) {
            this.dispatchEvent(new MessageEvent('message', {
              data: { id: message.id, type: 'error', error: 'frame failed' },
            }))
          } else {
            this.dispatchEvent(new MessageEvent('message', {
              data: { id: message.id, type: 'frame-complete', index: message.index },
            }))
          }
          return
        }
        if (message.type === 'finish') {
          this.dispatchEvent(new MessageEvent('message', {
            data: { id: message.id, type: 'result', result: new Blob(['webm']) },
          }))
          return
        }
        if (message.type === 'cancel') {
          this.dispatchEvent(new MessageEvent('message', {
            data: { id: message.id, type: 'cancelled' },
          }))
        }
      })
    }
  }

  const Tools = {
    getJPGContentIndex: () => [0, 10, 20],
    extractImageFrameBlob: (_buffer, _indexes, index) => new Blob([String(index)]),
    extractImage: async () => { throw new Error('full-frame decoder should not run') },
  }
  const context = vm.createContext({
    Blob,
    EventTarget,
    MessageEvent,
    Worker: FakeWorker,
    OffscreenCanvas: class {},
    console,
    queueMicrotask,
    createImageBitmap: async () => {
      decoded++
      outstanding++
      maxOutstanding = Math.max(maxOutstanding, outstanding)
      let closed = false
      return {
        width: 1920,
        height: 1080,
        close() {
          if (!closed) {
            closed = true
            outstanding--
          }
        },
      }
    },
    URL: { createObjectURL: () => 'blob:worker', revokeObjectURL() {} },
    fetch: async () => ({ text: async () => '' }),
    window: {
      setTimeout: fastTimeout ? (fn) => setTimeout(fn, 0) : setTimeout,
      clearTimeout,
    },
  })

  const mocks = {
    'webextension-polyfill': {
      default: { runtime: { getURL: (file) => `chrome-extension://test/${file}` } },
    },
    '../EVT': { EVT: { fire: (name) => events.push(name) } },
    '../Tools': { Tools },
  }
  const file = path.join(root, 'src/ts/ConvertUgoira/ToWebMUseWhammy.ts')
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

  return {
    toWebM: exports.toWebM,
    messages,
    events,
    getDecoded: () => decoded,
    getOutstanding: () => outstanding,
    getMaxOutstanding: () => maxOutstanding,
    getCreatedWorkers: () => createdWorkers,
    getTerminatedWorkers: () => terminatedWorkers,
  }
}

test('WebM decodes and transfers one frame at a time', async () => {
  const h = harness()
  let started
  const info = {
    frames: [
      { delay: 80 },
      { delay: 90 },
      { delay: 100 },
    ],
  }
  const result = await h.toWebM.convertFromZip(
    new Blob(['fake-zip']),
    info,
    (details) => { started = details }
  )
  assert.equal(result.size, 4)
  assert.equal(started.frameCount, 3)
  assert.equal(started.width, 1920)
  assert.equal(started.height, 1080)
  assert.equal(started.inputRGBABytes, 1920 * 1080 * 4 * 3)
  assert.equal(h.getDecoded(), 3)
  assert.equal(h.getMaxOutstanding(), 1)
  assert.equal(h.getOutstanding(), 0)
  assert.deepEqual(
    h.messages.map((x) => x.type),
    ['start', 'frame', 'frame', 'frame', 'finish']
  )
  assert.deepEqual(
    h.messages.filter((x) => x.type === 'frame').map((x) => [x.index, x.delay]),
    [[0, 80], [1, 90], [2, 100]]
  )
  assert.deepEqual(h.events, ['convertSuccess'])
})

test('WebM streaming cancels the worker job after a frame failure', async () => {
  const h = harness({ failFrame: 1 })
  const info = { frames: [{ delay: 80 }, { delay: 90 }, { delay: 100 }] }
  await assert.rejects(
    h.toWebM.convertFromZip(new Blob(['fake-zip']), info),
    /frame failed/
  )
  assert.equal(h.getMaxOutstanding(), 1)
  assert.equal(h.getOutstanding(), 0)
  assert.deepEqual(
    h.messages.map((x) => x.type),
    ['start', 'frame', 'frame', 'cancel']
  )
  assert.deepEqual(h.events, [])
})


test('WebM rejects inconsistent ZIP and metadata frame counts', async () => {
  const h = harness()
  await assert.rejects(
    h.toWebM.convertFromZip(
      new Blob(['fake-zip']),
      { frames: [{ delay: 80 }, { delay: 90 }] }
    ),
    /metadata count mismatch/
  )
  assert.equal(h.getDecoded(), 0)
  assert.deepEqual(h.messages, [])
})

test('WebM rejects a missing frame delay instead of substituting zero', async () => {
  const h = harness()
  await assert.rejects(
    h.toWebM.convertFromZip(
      new Blob(['fake-zip']),
      { frames: [{ delay: 80 }, {}, { delay: 100 }] }
    ),
    /Invalid WebM frame delay at index 1/
  )
  assert.equal(h.getDecoded(), 0)
  assert.deepEqual(h.messages, [])
})

test('WebM timeout terminates the in-flight worker before retry', async () => {
  const h = harness({ stallFrameOnce: 1, fastTimeout: true })
  const info = { frames: [{ delay: 80 }, { delay: 90 }, { delay: 100 }] }
  await assert.rejects(
    h.toWebM.convertFromZip(new Blob(['fake-zip']), info),
    /inactivity timeout/
  )
  assert.equal(h.getTerminatedWorkers(), 1)
  assert.equal(h.getOutstanding(), 0)

  const retry = await h.toWebM.convertFromZip(new Blob(['fake-zip']), info)
  assert.equal(retry.size, 4)
  assert.equal(h.getCreatedWorkers(), 2)
  assert.equal(h.getOutstanding(), 0)
})
