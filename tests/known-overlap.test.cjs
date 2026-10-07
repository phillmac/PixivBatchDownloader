const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')

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
  const result = m.consumeKnownOverlap([{ id: '40' }, { id: '39' }])
  assert.equal(result.boundaryReached, false)
  assert.equal(result.items.length, 2)
  assert.equal(
    m.finishKnownOverlap('source-exhausted').stopReason,
    'source-exhausted'
  )
  assert.equal(m.startKnownOverlap(url), null)
})
