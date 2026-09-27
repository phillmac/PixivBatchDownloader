const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')

function harness() {
  const stored = {}
  const downloadItems = new Map()
  const browser = {
    downloads: {
      async search({ id }) {
        return downloadItems.has(id) ? [downloadItems.get(id)] : []
      },
    },
    storage: {
      local: {
        async get(key) {
          return { [key]: stored[key] }
        },
        async set(data) {
          Object.assign(stored, data)
        },
      },
    },
  }
  const context = vm.createContext({ console, Date })
  const file = path.join(
    root,
    'src/ts/serviceWorker/DownloadWorkerDiagnostics.ts'
  )
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const exports = {}
  vm.runInContext(`(function(require, exports) {${compiled}\n})`, context, {
    filename: file,
  })((name) => {
    if (name === 'webextension-polyfill') return browser
    throw new Error(`unexpected require ${name}`)
  }, exports)
  return {
    diagnostics: exports.downloadWorkerDiagnostics,
    stored,
    downloadItems,
  }
}

test('worker snapshot correlates diagnostic task with browser download', async () => {
  const h = harness()
  h.downloadItems.set(77, {
    id: 77,
    filename: '/tmp/file.txt',
    state: 'complete',
    paused: false,
    error: undefined,
    bytesReceived: 123,
    totalBytes: 123,
    startTime: 'start',
    endTime: 'end',
    exists: true,
  })
  h.diagnostics.enter(12, 'task-1', 'save-request-received', {
    workId: '19747764',
    fileName: 'file.txt',
  })
  h.diagnostics.enter(12, 'task-1', 'browser-download-created', {
    workId: '19747764',
    fileName: 'file.txt',
    browserDownloadId: 77,
  })
  const snap = await h.diagnostics.snapshot(12, { idList: ['19747764'] })
  assert.equal(snap.active[0].browserDownloadId, 77)
  assert.equal(snap.downloads[0].state, 'complete')
  assert.equal(snap.bookkeeping.idList[0], '19747764')
  assert.equal(snap.recentEvents.at(-1).stage, 'browser-download-created')
})

test('persist keeps only the newest twenty incident reports', async () => {
  const h = harness()
  for (let i = 0; i < 23; i++) {
    await h.diagnostics.persist(5, { sequence: i })
  }
  const reports = h.stored.downloadHangDiagnostics
  assert.equal(reports.length, 20)
  assert.equal(reports[0].report.sequence, 3)
  assert.equal(reports.at(-1).report.sequence, 22)
})
