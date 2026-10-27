const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

/** 运行真实 API 请求构造，不发送网络请求。 */
function harness() {
  const exports = {}
  const dependencies = {
    './Config': { Config: {} },
    './EVT': { EVT: {} },
    './PPDTask': { ppdTask: { register() {} } },
    './utils/Utils': { Utils: {} },
  }
  const context = vm.createContext({
    exports,
    require(name) {
      assert.ok(dependencies[name], name)
      return dependencies[name]
    },
  })
  vm.runInContext(
    ts.transpileModule(
      fs.readFileSync(path.join(__dirname, '../src/ts/API.ts'), 'utf8'),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }
    ).outputText,
    context
  )
  const calls = []
  exports.API.fetch = async (url) => {
    calls.push(new URL(url))
    return { error: false, body: { total: 1 } }
  }
  return { API: exports.API, calls }
}

test('bookmark API encodes raw tags once without changing sibling filters or truncating the query', async () => {
  const h = harness()
  for (const tag of [
    '',
    'foo&rest=hide#bar',
    '100% literal + ? = /',
    '日本語😀',
    'novels',
  ]) {
    await h.API.getBookmarkData(
      '1',
      'illusts',
      tag,
      960,
      false,
      'desc',
      'all',
      'a%20b',
      '202610',
      1
    )
    const url = h.calls.at(-1)
    assert.equal(url.pathname, '/ajax/user/1/illusts/bookmarks')
    assert.equal(url.hash, '')
    assert.equal(url.searchParams.get('tag'), tag)
    assert.equal(url.searchParams.get('offset'), '960')
    assert.equal(url.searchParams.get('limit'), '1')
    assert.deepEqual(url.searchParams.getAll('rest'), ['show'])
    assert.equal(url.searchParams.get('order'), 'desc')
    assert.equal(url.searchParams.get('mode'), 'all')
    assert.equal(url.searchParams.get('work_tag'), 'a b')
    assert.equal(url.searchParams.get('bm'), '202610')
    assert.equal(url.searchParams.has('rdm'), true)
    assert.equal([...url.searchParams.keys()].length, 9)
  }
})

test('bookmark API preserves novel/private requests and rejects invalid limits before requesting', async () => {
  const h = harness()
  await h.API.getBookmarkData('2', 'novels', 'x&y', 30, true, 'asc')
  assert.equal(h.calls[0].pathname, '/ajax/user/2/novels/bookmarks')
  assert.equal(h.calls[0].searchParams.get('rest'), 'hide')
  assert.equal(h.calls[0].searchParams.get('limit'), '100')
  for (const limit of [0, -1, 101, 0.5, NaN, Infinity]) {
    await assert.rejects(
      h.API.getBookmarkData(
        '2',
        'novels',
        '',
        0,
        false,
        'desc',
        'all',
        '',
        '',
        limit
      ),
      /bookmark limit/
    )
  }
  assert.equal(h.calls.length, 1)
})
