const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const info = {
  mime_type: 'image/jpeg',
  frames: [{ file: '000000.jpg', delay: 80 }],
}
const bitmaps = [{ width: 2, height: 3 }]

// Load the real TypeScript modules with browser boundaries replaced for fault injection.
function harness() {
  const timers = new Map()
  let timerId = 0
  const events = new EventTarget()
  const h = {
    timers,
    now: 0,
    consoleErrors: [],
    workers: [],
    canvasError: null,
    postError: null,
    resourceStatus: 200,
    decodeError: null,
  }
  const window = {
    addEventListener: events.addEventListener.bind(events),
    setTimeout(fn, ms) {
      const id = ++timerId
      timers.set(id, { fn, ms })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
  }
  class FakeWorker extends EventTarget {
    constructor() {
      super()
      this.messages = []
      h.workers.push(this)
    }
    postMessage(data, transfer) {
      if (h.postError) throw h.postError
      this.messages.push(structuredClone(data, { transfer }))
    }
    emit(type, fields) {
      const event = Object.assign(new Event(type), fields)
      if (type === 'error' && this.onerror) this.onerror(event)
      this.dispatchEvent(event)
    }
  }
  const browser = {
    runtime: {
      getURL: (file) => `chrome-extension://test/${file}`,
      getManifest: () => ({ version: '19.4.1' }),
    },
  }
  const settings = {
    convertUgoiraThread: 1,
    downloadThread: 1,
    ugoiraSaveAsAPNG: true,
    imageSize: 'original',
  }
  const EVT = {
    list: { settingChange: 'settingChange', convertSuccess: 'convertSuccess' },
    fire(name) {
      events.dispatchEvent(new Event(name))
    },
  }
  const mocks = {
    'webextension-polyfill': { default: browser },
    '../EVT': { EVT },
    '../setting/Settings': { settings },
    '../store/States': { states: { downloading: true } },
    '../Tools': {
      Tools: {
        getJPGContentIndex: () => [40],
        async extractImage() {
          if (h.decodeError) throw h.decodeError
          return bitmaps
        },
      },
    },
    '../utils/Utils': { Utils: { sleep: async () => {} } },
    './ToGIF': {},
    './ToWebP': {},
    './ToWebMUseWhammy': {},
  }
  const context = vm.createContext({
    Blob,
    ArrayBuffer,
    Uint8ClampedArray,
    performance: { now: () => h.now },
    console: { error: (...args) => h.consoleErrors.push(args) },
    navigator: { userAgent: 'test-browser', hardwareConcurrency: 4 },
    document: {
      visibilityState: 'visible',
      createElement: () => ({
        getContext: () => ({
          drawImage() {},
          getImageData() {
            if (h.canvasError) throw h.canvasError
            return { data: new Uint8ClampedArray(24) }
          },
        }),
      }),
    },
    window,
    Worker: FakeWorker,
    URL: { createObjectURL: () => 'blob:worker', revokeObjectURL() {} },
    fetch: async () => ({
      ok: h.resourceStatus === 200,
      status: h.resourceStatus,
      text: async () => '',
    }),
  })
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file)
    const exports = {}
    cache.set(file, exports)
    const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText
    const moduleRequire = (name) => {
      if (name in mocks) return mocks[name]
      return load(path.resolve(path.dirname(file), name + '.ts'))
    }
    vm.runInContext(`(function(require, exports) {${compiled}\n})`, context, {
      filename: file,
    })(moduleRequire, exports)
    return exports
  }
  const base = path.join(root, 'src/ts/ConvertUgoira')
  Object.assign(h, load(path.join(base, 'APNGDiagnostics.ts')))
  h.converter = load(path.join(base, 'ToAPNG.ts')).toAPNG
  h.coordinator = () => load(path.join(base, 'ConvertUgoira.ts')).convertUgoira
  h.diagnostic = () => new h.APNGDiagnostics({ artworkId: 148801620 })
  h.waitForPost = async (count = 1) => {
    for (
      let i = 0;
      i < 40 && (h.workers[0]?.messages.length || 0) < count;
      i++
    ) {
      await Promise.resolve()
    }
    assert.equal(h.workers[0].messages.length, count)
    return h.workers[0]
  }
  return h
}

test('worker exception preserves name, stack and request context; next attempt can succeed', async () => {
  const h = harness()
  const d = h.diagnostic()
  const result = h.converter.convert(bitmaps, info, d)
  const worker = await h.waitForPost()
  const id = worker.messages[0].id
  worker.emit('message', { data: { id, type: 'started' } })
  worker.emit('message', {
    data: {
      id,
      error: {
        name: 'RangeError',
        message: 'Array buffer allocation failed',
        stack: 'UPNG.encode:42',
      },
      encodeMs: 13,
    },
  })
  await assert.rejects(result, (error) => {
    const report = d.failure(error).report
    assert.equal(report.error.name, 'RangeError')
    assert.equal(report.error.stack, 'UPNG.encode:42')
    assert.equal(report.stage, 'worker-encode')
    assert.equal(report.details.workerRequestId, id)
    assert.equal(report.details.workerEncodeMs, 13)
    assert.equal(report.details.inputRGBABytes, 24)
    return true
  })
  assert.equal(h.timers.size, 0)
  assert.equal(h.converter.pendingRequests.size, 0)

  const retry = h.converter.convert(bitmaps, info, h.diagnostic())
  await h.waitForPost(2)
  worker.emit('message', {
    data: { id: worker.messages[1].id, result: new ArrayBuffer(8) },
  })
  assert.equal((await retry).size, 8)
  assert.equal(h.timers.size, 0)
})

test('synchronous transfer error retains the post-message stage and removes the timer', async () => {
  const h = harness()
  h.postError = new DOMException('out of memory', 'DataCloneError')
  const d = h.diagnostic()
  await assert.rejects(h.converter.convert(bitmaps, info, d), (error) => {
    const report = d.failure(error).report
    assert.equal(report.error.name, 'DataCloneError')
    assert.equal(report.stage, 'worker-post-message')
    return true
  })
  assert.equal(h.timers.size, 0)
  assert.equal(h.converter.pendingRequests.size, 0)
})

for (const started of [false, true]) {
  test(`timeout distinguishes workerStarted=${started} and ignores late replies`, async () => {
    const h = harness()
    const d = h.diagnostic()
    const result = h.converter.convert(bitmaps, info, d)
    const worker = await h.waitForPost()
    const id = worker.messages[0].id
    if (started) worker.emit('message', { data: { id, type: 'started' } })
    const timer = [...h.timers.values()][0]
    assert.equal(timer.ms, 120000)
    timer.fn()
    await assert.rejects(result, /timeout after 120000 ms/)
    const report = d.failure(new Error('timeout')).report
    assert.equal(report.stage, started ? 'worker-encode' : 'wait-worker')
    assert.equal(report.details.workerStarted, started)
    worker.emit('message', { data: { id, result: new ArrayBuffer(8) } })
    assert.equal(h.timers.size, 0)
    assert.equal(h.converter.workerTimeouts, 1)
  })
}

test('timeout retains encoder frame progress and bounds the stage timeline', async () => {
  const h = harness()
  const d = h.diagnostic()
  const result = h.converter.convert(bitmaps, info, d)
  let settled = false
  result.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  const worker = await h.waitForPost()
  const id = worker.messages[0].id
  worker.emit('message', { data: { id, type: 'started' } })
  for (let index = 0; index < 3; index++) {
    h.now = 1000 + index * 250
    worker.emit('message', {
      data: {
        id,
        type: 'progress',
        progress: {
          stage: 'compress-frame',
          frameCount: 275,
          framesCompressed: index,
          frame: { index, width: 426, height: 240 },
          lastFrameMs: 250,
        },
      },
    })
  }
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(h.timers.size, 1)
  h.now = 2500
  ;[...h.timers.values()][0].fn()
  await assert.rejects(result, /timeout after 120000 ms/)
  const report = d.failure(new Error('timeout')).report
  assert.equal(report.diagnosticsVersion, 'apng-failure-v2')
  assert.equal(report.stage, 'worker-compress-frame')
  assert.equal(report.details.workerProgress.framesCompressed, 2)
  assert.equal(report.details.workerProgress.frame.index, 2)
  assert.equal(report.details.workerLastProgressAgeMs, 1000)
  assert.equal(
    report.timeline.filter((item) => item.stage === 'worker-compress-frame')
      .length,
    1
  )
  assert.equal(h.timers.size, 0)
})

for (const type of ['error', 'messageerror']) {
  test(`worker ${type} rejects concurrent requests immediately`, async () => {
    const h = harness()
    const first = h.converter.convert(bitmaps, info, h.diagnostic())
    const second = h.converter.convert(bitmaps, info, h.diagnostic())
    const worker = await h.waitForPost(2)
    worker.emit(type, {
      message: 'worker crashed',
      filename: 'blob:test',
      lineno: 12,
      colno: 3,
    })
    const results = await Promise.allSettled([first, second])
    assert.ok(results.every((result) => result.status === 'rejected'))
    assert.equal(h.timers.size, 0)
    assert.equal(h.converter.pendingRequests.size, 0)
  })
}

test('out-of-order responses stay associated with the correct conversion', async () => {
  const h = harness()
  const first = h.converter.convert(bitmaps, info, h.diagnostic())
  const second = h.converter.convert(bitmaps, info, h.diagnostic())
  const worker = await h.waitForPost(2)
  const [a, b] = worker.messages
  worker.emit('message', { data: { id: b.id, result: new ArrayBuffer(16) } })
  worker.emit('message', { data: { id: a.id, result: new ArrayBuffer(8) } })
  assert.equal((await first).size, 8)
  assert.equal((await second).size, 16)
})

test('malformed worker response is a diagnostic failure', async () => {
  const h = harness()
  const d = h.diagnostic()
  const result = h.converter.convert(bitmaps, info, d)
  const worker = await h.waitForPost()
  worker.emit('message', { data: { id: worker.messages[0].id, result: null } })
  await assert.rejects(result, /Invalid APNG worker response/)
  assert.equal(d.failure(null).report.stage, 'worker-response')
  assert.equal(h.timers.size, 0)
})

test('canvas failure reports the frame and operation', async () => {
  const h = harness()
  h.canvasError = new DOMException(
    'canvas allocation failed',
    'InvalidStateError'
  )
  const d = h.diagnostic()
  await assert.rejects(h.converter.convert(bitmaps, info, d), (error) => {
    const report = d.failure(error).report
    assert.equal(report.stage, 'read-frame-pixels')
    assert.equal(report.details.frame.file, '000000.jpg')
    assert.equal(report.details.frameOperation, 'getImageData')
    assert.equal(report.error.name, 'InvalidStateError')
    return true
  })
})

test('missing worker resource reports its path and status', async () => {
  const h = harness()
  h.resourceStatus = 404
  const d = h.diagnostic()
  await assert.rejects(h.converter.convert(bitmaps, info, d), /lib\/.*HTTP 404/)
  const report = d.failure(null).report
  assert.equal(report.stage, 'load-worker')
  assert.ok(
    report.details.workerResources.every((resource) => resource.status === 404)
  )
})

test('frame decode failure releases the conversion slot and produces a report', async () => {
  const h = harness()
  const coordinator = h.coordinator()
  const file = new Blob(['zip'])
  h.decodeError = new DOMException(
    'The source image could not be decoded',
    'InvalidStateError'
  )
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(coordinator.apng(file, info, 148801620), (error) => {
      assert.ok(error instanceof h.APNGConversionError)
      assert.equal(error.report.stage, 'decode-frames')
      assert.equal(error.report.details.activeConversionsAfterFailure, 0)
      assert.equal(error.report.details.artworkId, 148801620)
      assert.equal(error.report.error.name, 'InvalidStateError')
      assert.equal(error.cause, h.decodeError)
      assert.doesNotThrow(() => JSON.stringify(error.report))
      return true
    })
    assert.equal(coordinator._count, 0)
  }
})

test('real worker reports progress, preserves output and restores hooks after failure', () => {
  const messages = []
  const scope = vm.createContext({
    performance,
    self: { postMessage: (message) => messages.push(message) },
  })
  for (const file of ['pako.min.js', 'UPNG.js', 'apng.worker.js']) {
    vm.runInContext(
      fs.readFileSync(path.join(root, 'src/static/lib', file), 'utf8'),
      scope
    )
  }
  vm.runInContext(
    `
    var input = {
      id: 1, width: 1, height: 1,
      arrayBuffList: [new Uint8Array([255, 0, 0, 255]).buffer, new Uint8Array([0, 255, 0, 255]).buffer],
      delayList: [80, 120]
    }
    var baseline = UPNG.encode(input.arrayBuffList, 1, 1, 0, input.delayList)
    var originalFramize = UPNG.encode.framize
    var originalFilter = UPNG.encode._filterZero
    onmessage({ data: input })
  `,
    scope
  )
  assert.equal(messages[0].type, 'started')
  const encoded = messages.find((message) => message.result)
  assert.equal(encoded.id, 1)
  assert.deepEqual(
    new Uint8Array(encoded.result),
    new Uint8Array(scope.baseline)
  )
  const progress = messages.filter((message) => message.type === 'progress')
  assert.equal(progress[0].progress.stage, 'frame-differences')
  assert.deepEqual(
    progress
      .filter((message) => message.progress.stage === 'compress-frame')
      .map((message) => message.progress.frame.index),
    [0, 1]
  )
  assert.equal(progress.at(-1).progress.stage, 'assemble-png')
  assert.equal(progress.at(-1).progress.framesCompressed, 2)
  assert.equal(
    vm.runInContext(
      'UPNG.encode.framize === originalFramize && UPNG.encode._filterZero === originalFilter',
      scope
    ),
    true
  )
  scope.png = encoded.result
  assert.equal(vm.runInContext('UPNG.decode(png).frames.length', scope), 2)
  vm.runInContext(
    `
    var originalDeflate = pako.deflate
    pako.deflate = function () { throw new RangeError('encoder failure probe') }
    onmessage({ data: { ...input, id: 2 } })
  `,
    scope
  )
  const failed = messages.find((message) => message.id === 2 && message.error)
  assert.equal(failed.error.name, 'RangeError')
  assert.equal(failed.stage, 'compress-frame')
  assert.match(failed.error.stack, /encoder failure probe/)
  assert.equal(
    vm.runInContext(
      'UPNG.encode.framize === originalFramize && UPNG.encode._filterZero === originalFilter',
      scope
    ),
    true
  )
  vm.runInContext(
    `pako.deflate = originalDeflate; onmessage({ data: { ...input, id: 3 } })`,
    scope
  )
  assert.deepEqual(
    new Uint8Array(
      messages.find((message) => message.id === 3 && message.result).result
    ),
    new Uint8Array(scope.baseline)
  )
})
