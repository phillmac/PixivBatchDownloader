const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')

function loadGIFHarness({ constructorError = null } = {}) {
  const added = []
  const events = []
  class FakeGIF {
    constructor() {
      if (constructorError) throw constructorError
      this.handlers = new Map()
    }
    on(name, fn) {
      this.handlers.set(name, fn)
    }
    addFrame(imageData, options) {
      added.push({ imageData, options })
    }
    render() {
      this.handlers.get('finished')(new Blob(['gif']))
    }
  }
  const context = vm.createContext({
    Blob,
    console,
    GIF: FakeGIF,
    document: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage() {},
          getImageData: () => ({ data: new Uint8ClampedArray(24) }),
        }),
      }),
    },
  })
  const mocks = {
    'webextension-polyfill': {
      default: { runtime: { getURL: (file) => `chrome-extension://test/${file}` } },
    },
    '../EVT': { EVT: { fire: (name) => events.push(name) } },
    '../utils/Utils': { Utils: { isPixiv: () => false } },
  }
  const file = path.join(root, 'src/ts/ConvertUgoira/ToGIF.ts')
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
  return { toGIF: exports.toGIF, added, events }
}

test('GIF releases each decoded bitmap after copying its pixels', async () => {
  const h = loadGIFHarness()
  let closed = 0
  const bitmaps = [
    { width: 2, height: 3, close() { closed++ } },
    { width: 2, height: 3, close() { closed++ } },
  ]
  const info = {
    frames: [
      { file: '000000.jpg', delay: 80 },
      { file: '000001.jpg', delay: 90 },
    ],
  }
  const result = await h.toGIF.convert(bitmaps, info, 1024)
  assert.equal(result.size, 3)
  assert.equal(closed, 2)
  assert.equal(h.added.length, 2)
  assert.deepEqual(h.added.map((x) => x.options.delay), [80, 90])
  assert.deepEqual(h.events, ['convertSuccess'])
})


test('GIF releases decoded bitmaps when setup fails before frame copying', async () => {
  const h = loadGIFHarness({ constructorError: new Error('gif setup failed') })
  let closed = 0
  const bitmaps = [
    { width: 2, height: 3, close() { closed++ } },
    { width: 2, height: 3, close() { closed++ } },
  ]
  const info = {
    frames: [
      { file: '000000.jpg', delay: 80 },
      { file: '000001.jpg', delay: 90 },
    ],
  }
  await assert.rejects(h.toGIF.convert(bitmaps, info, 1024), /gif setup failed/)
  assert.equal(closed, 2)
})
