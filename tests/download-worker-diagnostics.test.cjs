const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { diagnosticsLoader } = require('./helpers/diagnostics-harness.cjs')

const root = path.resolve(__dirname, '..')

function harness() {
  const stored = {}
  const failures = { get: false, set: false }
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
          if (failures.get) throw new Error('storage get failed')
          return { [key]: stored[key] }
        },
        async set(data) {
          if (failures.set) throw new Error('storage quota exceeded')
          Object.assign(stored, data)
        },
      },
    },
  }
  const context = vm.createContext({ console, Date, TextEncoder })
  const load = diagnosticsLoader(context, { 'webextension-polyfill': browser })
  const exports = load('serviceWorker/DownloadWorkerDiagnostics.ts')
  return {
    diagnostics: exports.downloadWorkerDiagnostics,
    serialization: load('download/DiagnosticSerialization.ts'),
    failures,
    browser,
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

test('concurrent persistence keeps every incident report', async () => {
  const h = harness()
  await Promise.all(
    Array.from({ length: 8 }, (_, sequence) =>
      h.diagnostics.persist(7, { sequence })
    )
  )
  const reports = h.stored.downloadHangDiagnostics
  assert.equal(reports.length, 8)
  assert.equal(
    Array.from(reports, (entry) => entry.report.sequence).join(','),
    '0,1,2,3,4,5,6,7'
  )
})

test('equal batch:index:sequence in different tabs keeps browser IDs and completion isolated', async () => {
  const h = harness()
  const id = '123:0:1'
  h.diagnostics.enter(10, id, 'browser-download-created', {
    workId: 'a',
    browserDownloadId: 77,
  })
  h.diagnostics.enter(20, id, 'browser-download-created', {
    workId: 'b',
    browserDownloadId: 88,
  })
  assert.equal(
    (await h.diagnostics.snapshot(10)).active[0].browserDownloadId,
    77
  )
  assert.equal(
    (await h.diagnostics.snapshot(20)).active[0].browserDownloadId,
    88
  )
  h.diagnostics.finish(10, id, 'browser-download-complete')
  assert.equal((await h.diagnostics.snapshot(10)).active.length, 0)
  const other = await h.diagnostics.snapshot(20)
  assert.equal(other.active[0].workId, 'b')
  assert.equal(other.downloads[0].id, 88)
  h.diagnostics.finish(20, id, 'browser-download-error')
  assert.equal((await h.diagnostics.snapshot(20)).active.length, 0)
})

test('serialized retention is byte bounded across oversized unicode reports and legacy data', async () => {
  const h = harness()
  const { diagnosticLimits } = h.serialization
  // 即使旧版本写入无上限内容，下一次持久化也会收缩。
  h.stored.downloadHangDiagnostics = [
    { report: { text: '旧😀'.repeat(500000) } },
  ]
  for (let sequence = 0; sequence < 25; sequence++) {
    const rows = Array.from({ length: 2000 }, (_, index) => ({
      index,
      text: '日本語😀'.repeat(1000),
    }))
    const result = await h.diagnostics.persist(5, { sequence, rows })
    assert.equal(result.stored, true)
    assert.ok(
      Buffer.byteLength(JSON.stringify(h.stored)) <= diagnosticLimits.retention
    )
    for (const entry of h.stored.downloadHangDiagnostics) {
      assert.ok(
        Buffer.byteLength(JSON.stringify(entry)) <= diagnosticLimits.report
      )
    }
  }
  const entries = h.stored.downloadHangDiagnostics
  assert.equal(entries.at(-1).report.sequence, 24)
  assert.ok(entries.length > 1 && entries.length < 20)
})

test('cycles, bigint, throwing getters and toJSON cannot poison persistence or later reports', async () => {
  const h = harness()
  const report = {
    bigint: 1n,
    get failure() {
      throw new Error('getter')
    },
    toJSON() {
      throw new Error('serializer')
    },
  }
  report.self = report
  assert.equal((await h.diagnostics.persist(1, report)).stored, true)
  const stored = h.stored.downloadHangDiagnostics[0]
  assert.ok(stored.diagnosticSerialization.serializationErrors >= 3)
  assert.equal(
    (await h.diagnostics.persist(1, { recovered: true })).stored,
    true
  )
  assert.equal(h.stored.downloadHangDiagnostics.at(-1).report.recovered, true)
})

test('storage read/write failures resolve safely and the persistence queue recovers', async () => {
  const h = harness()
  for (const mode of ['get', 'set']) {
    h.failures[mode] = true
    const failed = await h.diagnostics.persist(1, { mode })
    assert.equal(failed.stored, false)
    h.failures[mode] = false
    assert.equal(
      (await h.diagnostics.persist(1, { recovered: mode })).stored,
      true
    )
  }
})

test('blocked storage cannot build an unbounded queue and captures detach before queueing', async () => {
  const h = harness()
  let release
  const blocked = new Promise((resolve) => {
    release = resolve
  })
  const get = h.browser.storage.local.get
  h.browser.storage.local.get = async (key) => {
    await blocked
    return get(key)
  }
  const report = { nested: { stage: 'captured' } }
  const pending = Array.from({ length: 40 }, () =>
    h.diagnostics.persist(1, report)
  )
  report.nested.stage = 'mutated'
  release()
  const results = await Promise.all(pending)
  assert.equal(results.filter((result) => result.stored).length, 8)
  assert.equal(
    results.filter((result) => result.reason === 'diagnostic-queue-full')
      .length,
    32
  )
  assert.equal(
    h.stored.downloadHangDiagnostics[0].report.nested.stage,
    'captured'
  )
})

test('thousands of worker tasks and large details bound memory rings and returned snapshots', async () => {
  const h = harness()
  const large = '😀日本語'.repeat(10000)
  for (let index = 0; index < 4000; index++)
    h.diagnostics.enter(1, `task-${index}`, 'pending', {
      fileName: large,
      nested: { text: large },
    })
  const snapshot = await h.diagnostics.snapshot(1, {
    memoryIdListTotal: 4000,
    memoryIdList: Array(4000).fill(large),
  })
  assert.equal(snapshot.activeTotal, 256)
  assert.equal(snapshot.evictedTasks, 3744)
  assert.equal(snapshot.activeOmitted + snapshot.active.length, 256)
  assert.equal(snapshot.bookkeeping.memoryIdListTotal, 4000)
  assert.ok(
    Buffer.byteLength(JSON.stringify(snapshot)) <=
      h.serialization.diagnosticLimits.worker
  )
  assert.ok(
    Buffer.byteLength(JSON.stringify(h.diagnostics.events.get(1))) <=
      h.serialization.diagnosticLimits.collection
  )
  for (let tab = 2; tab < 100; tab++)
    h.diagnostics.enter(tab, 'same', 'pending')
  assert.equal(h.diagnostics.events.size, 32)
  assert.ok(h.diagnostics.active.size <= 256)
})
