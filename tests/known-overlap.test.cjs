const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')

/** 在独立上下文中加载真实的已知重叠模块。 */
function loadModule() {
  const file = path.join(root, 'src/ts/crawl/KnownOverlap.ts')
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const exports = {}
  const context = vm.createContext({ Date })
  vm.runInContext('(function(exports) {' + compiled + '\n})', context)(exports)
  return exports
}

for (const { name, pages, knownIds = ['101', '102', '103'] } of [
  {
    name: 'repeated-only known IDs retain the unknown item after the false boundary',
    pages: [['101', '101', '101', '999']],
  },
  {
    name: 'known ID repeats split across responses cannot accumulate votes',
    pages: [['101'], ['101'], ['101', '999']],
  },
  {
    name: 'A/B/A duplicates interrupt the distinct known streak',
    pages: [['101', '102', '101', '103', '999']],
  },
  {
    name: 'duplicate response replay cannot bridge a streak to a new known ID',
    pages: [
      ['101', '102'],
      ['101', '102'],
      ['103', '999'],
    ],
  },
  {
    name: 'known IDs cannot vote again after a duplicate resets the streak',
    pages: [['101', '102'], ['101'], ['102', '103', '104', '999']],
    knownIds: ['101', '102', '103', '104'],
  },
  {
    name: 'known IDs cannot vote again after an unknown resets the streak',
    pages: [
      ['101', '102', '998'],
      ['101', '102', '103', '999'],
    ],
  },
]) {
  test(name, () => {
    const m = loadModule()
    const url = 'https://www.pixiv.net/en/users/1'
    m.configureKnownOverlap(url, knownIds, 3)
    m.startKnownOverlap(url)

    for (const ids of pages) {
      const items = ids.map((id) => ({ id, metadata: `work-${id}` }))
      const result = m.consumeKnownOverlap(items)
      assert.equal(result.boundaryReached, false)
      assert.equal(result.scannedCount, items.length)
      // 包括重复项在内的所有候选对象必须原样保留，供独立过滤和元数据流程处理。
      assert.deepEqual(Array.from(result.items), items)
    }
    const snapshot = m.getKnownOverlapSnapshot(url)
    const ids = pages.flat()
    assert.equal(snapshot.scannedCount, ids.length)
    assert.equal(
      snapshot.knownSeenCount,
      ids.filter((id) => knownIds.includes(id)).length
    )
    assert.equal(
      snapshot.unknownCount,
      ids.filter((id) => !knownIds.includes(id)).length
    )
    assert.equal(snapshot.requiredConsecutive, 3)
    assert.equal(snapshot.currentConsecutive, 0)
    assert.deepEqual(Array.from(snapshot.boundaryIds), [])
    assert.equal(snapshot.stopReason, null)
    assert.equal(snapshot.finishedAt, null)
  })
}

test('three fresh distinct known IDs can establish a boundary after a replay', () => {
  const m = loadModule()
  const url = 'https://www.pixiv.net/en/users/1'
  m.configureKnownOverlap(url, ['101', '102', '103', '104', '105'])
  m.startKnownOverlap(url)
  assert.equal(
    m.consumeKnownOverlap([{ id: '101' }, { id: '102' }]).boundaryReached,
    false
  )
  const replay = m.consumeKnownOverlap([
    { id: '101' },
    { id: '102' },
    { id: '103' },
    { id: '104' },
  ])
  assert.equal(replay.boundaryReached, false)
  assert.equal(replay.items.length, 4)
  assert.equal(m.getKnownOverlapSnapshot().currentConsecutive, 2)
  const result = m.consumeKnownOverlap([{ id: '105' }, { id: '999' }])
  assert.equal(result.boundaryReached, true)
  assert.deepEqual(
    Array.from(result.items, (item) => item.id),
    ['105']
  )
  const snapshot = m.getKnownOverlapSnapshot()
  assert.equal(snapshot.requiredConsecutive, 3)
  assert.equal(snapshot.scannedCount, 7)
  assert.equal(snapshot.knownSeenCount, 7)
  assert.deepEqual(Array.from(snapshot.boundaryIds), ['103', '104', '105'])
})

test('unknown IDs reset a partial streak before fresh distinct IDs across responses', () => {
  const m = loadModule()
  const url = 'https://www.pixiv.net/en/users/1'
  m.configureKnownOverlap(url, ['101', '102', '103', '104', '105'])
  m.startKnownOverlap(url)
  const first = m.consumeKnownOverlap([
    { id: '101' },
    { id: '102' },
    { id: '999' },
    { id: '103' },
  ])
  assert.equal(first.boundaryReached, false)
  assert.equal(first.items.length, 4)
  assert.equal(m.getKnownOverlapSnapshot().currentConsecutive, 1)
  const second = m.consumeKnownOverlap([{ id: '104' }, { id: '105' }])
  assert.equal(second.boundaryReached, true)
  const snapshot = m.getKnownOverlapSnapshot()
  assert.equal(snapshot.unknownCount, 1)
  assert.deepEqual(Array.from(snapshot.boundaryIds), ['103', '104', '105'])
})

test('boundary-disabled observations reset the streak and cannot vote on replay', () => {
  const m = loadModule()
  const url = 'https://www.pixiv.net/en/users/1'
  m.configureKnownOverlap(url, ['101', '102', '103', '104', '105', '106'])
  m.startKnownOverlap(url)
  m.consumeKnownOverlap([{ id: '101' }, { id: '102' }])
  const disabled = m.consumeKnownOverlap([{ id: '103' }], false)
  assert.equal(disabled.boundaryReached, false)
  assert.equal(disabled.items.length, 1)
  assert.equal(m.getKnownOverlapSnapshot().currentConsecutive, 0)
  const replay = m.consumeKnownOverlap([
    { id: '101' },
    { id: '102' },
    { id: '103' },
    { id: '104' },
    { id: '105' },
  ])
  assert.equal(replay.boundaryReached, false)
  assert.equal(replay.items.length, 5)
  assert.equal(m.getKnownOverlapSnapshot().currentConsecutive, 2)
  assert.equal(m.consumeKnownOverlap([{ id: '106' }]).boundaryReached, true)
  assert.deepEqual(Array.from(m.getKnownOverlapSnapshot().boundaryIds), [
    '104',
    '105',
    '106',
  ])
})

test('a known set smaller than the threshold never lowers the required streak', () => {
  const m = loadModule()
  const url = 'https://www.pixiv.net/en/users/1'
  m.configureKnownOverlap(url, ['101', '102'])
  m.startKnownOverlap(url)
  const result = m.consumeKnownOverlap([
    { id: '101' },
    { id: '102' },
    { id: '101' },
    { id: '999' },
  ])
  assert.equal(result.boundaryReached, false)
  assert.equal(result.items.length, 4)
  const snapshot = m.finishKnownOverlap('source-exhausted')
  assert.equal(snapshot.requiredConsecutive, 3)
  assert.equal(snapshot.stopReason, 'source-exhausted')
})

test('a new crawl can use known IDs observed by the previous crawl', () => {
  const m = loadModule()
  const url = 'https://www.pixiv.net/en/users/1'
  for (let crawl = 0; crawl < 2; crawl++) {
    m.configureKnownOverlap(url, ['101', '102', '103'])
    m.startKnownOverlap(url)
    assert.equal(
      m.consumeKnownOverlap([{ id: '101' }, { id: '102' }, { id: '103' }])
        .boundaryReached,
      true
    )
  }
})

test('three consecutive known IDs establish a trusted boundary', () => {
  const m = loadModule()
  m.configureKnownOverlap(
    'https://www.pixiv.net/en/users/1',
    ['97', '96', '95', '80'],
    3
  )
  m.startKnownOverlap('https://www.pixiv.net/en/users/1')

  const result = m.consumeKnownOverlap([
    { id: '100' },
    { id: '99' },
    { id: '97' },
    { id: '96' },
    { id: '95' },
    { id: '94' },
  ])
  assert.deepEqual(
    Array.from(result.items, (item) => item.id),
    ['100', '99', '97', '96', '95']
  )
  assert.equal(result.boundaryReached, true)
  assert.equal(result.scannedCount, 5)

  const snapshot = m.getKnownOverlapSnapshot('https://www.pixiv.net/en/users/1')
  assert.equal(snapshot.stopReason, 'known-overlap')
  assert.equal(snapshot.scannedCount, 5)
  assert.equal(snapshot.unknownCount, 2)
  assert.equal(snapshot.knownSeenCount, 3)
  assert.deepEqual(Array.from(snapshot.boundaryIds), ['97', '96', '95'])
})

test('isolated known IDs are skipped but do not establish a boundary', () => {
  const m = loadModule()
  m.configureKnownOverlap('https://www.pixiv.net/en/users/1', ['99', '97'], 3)
  m.startKnownOverlap('https://www.pixiv.net/en/users/1')

  const result = m.consumeKnownOverlap([
    { id: '100' },
    { id: '99' },
    { id: '98' },
    { id: '97' },
    { id: '96' },
  ])
  assert.deepEqual(
    Array.from(result.items, (item) => item.id),
    ['100', '99', '98', '97', '96']
  )
  assert.equal(result.boundaryReached, false)
  const snapshot = m.finishKnownOverlap('source-exhausted')
  assert.equal(snapshot.stopReason, 'source-exhausted')
  assert.equal(snapshot.knownSeenCount, 2)
})

test('consecutive overlap carries across page-sized consume calls', () => {
  const m = loadModule()
  m.configureKnownOverlap(
    'https://www.pixiv.net/en/users/1/bookmarks/artworks',
    ['9', '8', '7'],
    3
  )
  m.startKnownOverlap('https://www.pixiv.net/en/users/1/bookmarks/artworks')

  const first = m.consumeKnownOverlap([{ id: '10' }, { id: '9' }])
  assert.equal(first.boundaryReached, false)
  const second = m.consumeKnownOverlap([{ id: '8' }, { id: '7' }, { id: '6' }])
  assert.equal(second.boundaryReached, true)
  assert.deepEqual(
    Array.from(first.items, (item) => item.id),
    ['10', '9']
  )
  assert.deepEqual(
    Array.from(second.items, (item) => item.id),
    ['8', '7']
  )
  assert.equal(m.getKnownOverlapSnapshot().scannedCount, 4)
})

test('completed overlap no longer consumes later unrelated item lists', () => {
  const m = loadModule()
  m.configureKnownOverlap(
    'https://www.pixiv.net/en/users/1',
    ['9', '8', '7'],
    3
  )
  m.startKnownOverlap('https://www.pixiv.net/en/users/1')
  const first = m.consumeKnownOverlap([{ id: '9' }, { id: '8' }, { id: '7' }])
  assert.equal(first.boundaryReached, true)

  const unrelated = m.consumeKnownOverlap([{ id: '50' }, { id: '49' }])
  assert.equal(unrelated.boundaryReached, false)
  assert.deepEqual(
    Array.from(unrelated.items, (item) => item.id),
    ['50', '49']
  )
  assert.equal(m.getKnownOverlapSnapshot().stopReason, 'known-overlap')
})

test('boundary-disabled scan observes known IDs without early termination', () => {
  const m = loadModule()
  m.configureKnownOverlap(
    'https://www.pixiv.net/en/users/1',
    ['99', '98', '97'],
    3
  )
  m.startKnownOverlap('https://www.pixiv.net/en/users/1')

  const result = m.consumeKnownOverlap(
    [{ id: '99' }, { id: '98' }, { id: '97' }, { id: '100' }],
    false
  )
  assert.deepEqual(
    Array.from(result.items, (item) => item.id),
    ['99', '98', '97', '100']
  )
  assert.equal(result.boundaryReached, false)
  const snapshot = m.finishKnownOverlap('source-exhausted')
  assert.equal(snapshot.stopReason, 'source-exhausted')
  assert.equal(snapshot.boundaryReached, false)
  assert.equal(snapshot.knownSeenCount, 3)
  assert.equal(snapshot.unknownCount, 1)
})

test('finite discovery can explicitly report limit before boundary', () => {
  const m = loadModule()
  m.configureKnownOverlap('https://www.pixiv.net/en/users/1', ['1'], 3)
  m.startKnownOverlap('https://www.pixiv.net/en/users/1')
  m.consumeKnownOverlap([{ id: '10' }, { id: '9' }])
  const snapshot = m.finishKnownOverlap('crawl-limit')
  assert.equal(snapshot.boundaryReached, false)
  assert.equal(snapshot.stopReason, 'crawl-limit')
})

test('matching crawl consumes the overlap arm exactly once', () => {
  const m = loadModule()
  m.configureKnownOverlap(
    'https://www.pixiv.net/en/users/1',
    ['9', '8', '7'],
    3
  )
  assert.ok(m.startKnownOverlap('https://www.pixiv.net/en/users/1'))
  m.consumeKnownOverlap([{ id: '9' }, { id: '8' }, { id: '7' }])
  assert.equal(m.getKnownOverlapSnapshot().stopReason, 'known-overlap')

  assert.equal(m.startKnownOverlap('https://www.pixiv.net/en/users/1'), null)
  const later = m.consumeKnownOverlap([{ id: '9' }, { id: '8' }, { id: '7' }])
  assert.deepEqual(
    Array.from(later.items, (item) => item.id),
    ['9', '8', '7']
  )
  assert.equal(later.boundaryReached, false)
})

test('URL mismatch does not activate an armed overlap set', () => {
  const m = loadModule()
  m.configureKnownOverlap(
    'https://www.pixiv.net/en/users/1',
    ['9', '8', '7'],
    3
  )
  assert.equal(m.startKnownOverlap('https://www.pixiv.net/en/users/2'), null)
  const result = m.consumeKnownOverlap([{ id: '10' }, { id: '9' }])
  assert.deepEqual(
    Array.from(result.items, (item) => item.id),
    ['10', '9']
  )
  assert.equal(m.getKnownOverlapSnapshot(), null)
})

test('explicit empty boundary records real exhaustion without enabling an early stop', () => {
  const m = loadModule()
  const url = 'https://www.pixiv.net/users/1/bookmarks/artworks?p=21'
  m.configureKnownOverlap(url, [], 3)
  assert.equal(m.startKnownOverlap(url).knownCount, 0)
  for (const ids of [
    ['40', '40'],
    ['40', '39'],
  ]) {
    const items = ids.map((id) => ({ id }))
    const result = m.consumeKnownOverlap(items)
    assert.equal(result.boundaryReached, false)
    assert.deepEqual(Array.from(result.items), items)
  }
  const snapshot = m.finishKnownOverlap('source-exhausted')
  assert.equal(snapshot.stopReason, 'source-exhausted')
  assert.equal(snapshot.scannedCount, 4)
  assert.equal(snapshot.unknownCount, 4)
  assert.equal(snapshot.knownSeenCount, 0)
  assert.equal(snapshot.currentConsecutive, 0)
  assert.equal(snapshot.requiredConsecutive, 3)
  assert.deepEqual(Array.from(snapshot.boundaryIds), [])
  assert.equal(m.startKnownOverlap(url), null)
})
