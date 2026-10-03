const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')

function libraryHarness() {
  const h = {
    workers: [],
    reads: 0,
    timers: new Map(),
    now: 0,
    timerId: 0,
  }
  class FakeWorker {
    constructor() {
      this.messages = []
      this.terminated = false
      h.workers.push(this)
    }
    postMessage(data, transfer) {
      this.messages.push({ data, transfer })
    }
    terminate() {
      this.terminated = true
    }
    emit(data) {
      this.onmessage?.({ data })
    }
  }
  const window = {
    PPDWebP: null,
    setTimeout(fn, ms) {
      const id = ++h.timerId
      h.timers.set(id, { fn, ms })
      return id
    },
    clearTimeout(id) {
      h.timers.delete(id)
    },
  }
  const context = vm.createContext({
    Blob,
    Error,
    Worker: FakeWorker,
    Uint8ClampedArray,
    performance: { now: () => h.now },
    window,
    document: {
      createElement() {
        return {
          width: 0,
          height: 0,
          getContext() {
            return {
              clearRect() {},
              drawImage() {},
              getImageData() {
                h.reads++
                return { data: new Uint8ClampedArray(16) }
              },
            }
          },
        }
      },
    },
  })
  vm.runInContext(
    fs.readFileSync(path.join(root, 'src/static/lib/ppd-webp.js'), 'utf8'),
    context
  )
  h.encoder = window.PPDWebP
  h.encoder.init('blob:worker')
  h.flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  return h
}

test('WebP raw pixels are read and transferred one frame at a time', async () => {
  const h = libraryHarness()
  const bitmaps = Array.from({ length: 3 }, () => ({ width: 2, height: 2 }))
  const result = h.encoder.encode(bitmaps, [80, 80, 80])
  await h.flush()

  const worker = h.workers[0]
  assert.equal(h.reads, 1)
  assert.equal(worker.messages[0].data.type, 'start')
  assert.equal(worker.messages[1].data.type, 'frame')
  assert.equal(worker.messages[1].data.index, 0)

  worker.emit({ type: 'frame-complete', index: 0, encodedBytes: 10 })
  await h.flush()
  assert.equal(h.reads, 2)
  assert.equal(worker.messages[2].data.index, 1)

  worker.emit({ type: 'frame-complete', index: 1, encodedBytes: 11 })
  await h.flush()
  assert.equal(h.reads, 3)
  assert.equal(worker.messages[3].data.index, 2)

  worker.emit({ type: 'frame-complete', index: 2, encodedBytes: 12 })
  await h.flush()
  assert.equal(worker.messages[4].data.type, 'finish')
  worker.emit({
    type: 'result',
    blob: new Blob(['webp'], { type: 'image/webp' }),
  })
  assert.equal((await result).type, 'image/webp')
  assert.equal(worker.terminated, true)
})

test('WebP inactivity timeout terminates the worker and reports memory context', async () => {
  const h = libraryHarness()
  const result = h.encoder.encode([{ width: 1920, height: 1080 }], [80], {
    timeoutMs: 1234,
  })
  await h.flush()
  const worker = h.workers[0]
  const timer = [...h.timers.values()][0]
  assert.equal(timer.ms, 1234)
  timer.fn()

  await assert.rejects(result, (error) => {
    assert.match(error.message, /timeout/)
    assert.equal(error.ppdWebP.frameCount, 1)
    assert.equal(error.ppdWebP.width, 1920)
    assert.equal(error.ppdWebP.height, 1080)
    assert.equal(error.ppdWebP.rawFrameBytes, 1920 * 1080 * 4)
    return true
  })
  assert.equal(worker.terminated, true)
})

function minimalWebPFrame() {
  const bytes = new Uint8Array(24)
  bytes.set(Buffer.from('RIFF'), 0)
  new DataView(bytes.buffer).setUint32(4, 16, true)
  bytes.set(Buffer.from('WEBP'), 8)
  bytes.set(Buffer.from('VP8 '), 12)
  new DataView(bytes.buffer).setUint32(16, 4, true)
  return bytes
}

test('WebP worker acknowledges each frame before final assembly', async () => {
  const messages = []
  class FakeOffscreenCanvas {
    getContext() {
      return { putImageData() {} }
    }
    async convertToBlob() {
      return new Blob([minimalWebPFrame()], { type: 'image/webp' })
    }
  }
  class FakeImageData {
    constructor(data, width, height) {
      this.data = data
      this.width = width
      this.height = height
    }
  }
  const context = vm.createContext({
    Blob,
    Buffer,
    Uint8Array,
    Uint8ClampedArray,
    DataView,
    OffscreenCanvas: FakeOffscreenCanvas,
    ImageData: FakeImageData,
    onmessage: null,
    self: { postMessage: (message) => messages.push(message) },
  })
  vm.runInContext(
    fs.readFileSync(
      path.join(root, 'src/static/lib/ppd-webp.worker.js'),
      'utf8'
    ),
    context
  )

  await context.onmessage({
    data: {
      type: 'start',
      width: 2,
      height: 2,
      quality: 0.94,
      loopCount: 0,
      frameCount: 1,
    },
  })
  await context.onmessage({
    data: {
      type: 'frame',
      index: 0,
      delay: 80,
      rgba: new ArrayBuffer(16),
    },
  })
  assert.deepEqual(
    messages.slice(0, 3).map((message) => message.type),
    ['progress', 'progress', 'frame-complete']
  )
  assert.equal(messages[2].index, 0)

  await context.onmessage({ data: { type: 'finish' } })
  assert.equal(messages.at(-2).stage, 'assemble-webp')
  assert.equal(messages.at(-1).type, 'result')
  assert.equal(messages.at(-1).blob.type, 'image/webp')
  assert.ok(messages.at(-1).blob.size > 0)
})
