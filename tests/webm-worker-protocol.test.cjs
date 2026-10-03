const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')

function harness() {
  const posted = []
  const added = []
  let closed = 0

  class FakeVideo {
    add(dataURL, delay) {
      added.push({ dataURL, delay })
    }
    compile(_outputAsArray, callback) {
      callback(new Blob(['webm']))
    }
  }

  class FakeOffscreenCanvas {
    constructor(width, height) {
      this.width = width
      this.height = height
      this.ctx = {
        clearRect() {},
        drawImage() {},
      }
    }
    getContext() {
      return this.ctx
    }
    async convertToBlob() {
      return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' })
    }
  }

  const scope = vm.createContext({
    Blob,
    Uint8Array,
    String,
    btoa,
    Map,
    OffscreenCanvas: FakeOffscreenCanvas,
    Whammy: { Video: FakeVideo },
    self: { postMessage: (message) => posted.push(message) },
    onmessage: null,
  })
  const source = fs.readFileSync(
    path.join(root, 'src/static/lib/whammy.worker.js'),
    'utf8'
  )
  vm.runInContext(source, scope)

  const bitmap = () => ({
    close() { closed++ },
  })
  return {
    scope,
    posted,
    added,
    bitmap,
    getClosed: () => closed,
    jobs: () => vm.runInContext('jobs.size', scope),
  }
}
test('Whammy worker streams frames in order and releases each bitmap', async () => {
  const h = harness()
  await h.scope.onmessage({
    data: { id: 1, type: 'start', width: 2, height: 3, quality: 0.9 },
  })
  assert.equal(h.posted.at(-1).type, 'ready')
  assert.equal(h.jobs(), 1)

  await h.scope.onmessage({
    data: { id: 1, type: 'frame', index: 0, bitmap: h.bitmap(), delay: 80 },
  })
  assert.equal(h.posted.at(-1).type, 'frame-complete')
  await h.scope.onmessage({
    data: { id: 1, type: 'frame', index: 1, bitmap: h.bitmap(), delay: 90 },
  })
  assert.equal(h.posted.at(-1).type, 'frame-complete')
  assert.equal(h.getClosed(), 2)

  await h.scope.onmessage({ data: { id: 1, type: 'finish' } })
  const result = h.posted.at(-1)
  assert.equal(result.type, 'result')
  assert.equal(result.result.size, 4)
  assert.deepEqual(h.added.map((x) => x.delay), [80, 90])
  assert.equal(h.jobs(), 0)
})
test('Whammy worker cancels and rejects out-of-order frames', async () => {
  const h = harness()
  await h.scope.onmessage({
    data: { id: 2, type: 'start', width: 2, height: 3, quality: 0.9 },
  })
  await h.scope.onmessage({ data: { id: 2, type: 'cancel' } })
  assert.equal(h.posted.at(-1).type, 'cancelled')
  assert.equal(h.jobs(), 0)

  await h.scope.onmessage({
    data: { id: 3, type: 'start', width: 2, height: 3, quality: 0.9 },
  })
  await h.scope.onmessage({
    data: { id: 3, type: 'frame', index: 1, bitmap: h.bitmap(), delay: 80 },
  })
  assert.equal(h.posted.at(-1).type, 'error')
  assert.match(h.posted.at(-1).error, /Unexpected Whammy frame index/)
  assert.equal(h.jobs(), 0)
})
