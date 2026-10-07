const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

/** 执行真实查询解释与只读 API，并记录唯一的网络请求。 */
function harness(url, total = 1000) {
  const context = vm.createContext({ URL, location: { href: url } })
  const pageType = { type: 4, list: { Bookmark: 4 } }
  const calls = []
  const modules = {
    '../Tools': {
      Tools: {
        getTagFromURL(value) {
          const u = new URL(value)
          return decodeURIComponent(
            u.pathname.split(/\/bookmarks\/(?:artworks|novels)\//)[1] ||
              u.searchParams.get('tag') ||
              ''
          )
        },
      },
    },
    '../utils/Utils': {
      Utils: {
        getURLSearchField(value, key) {
          return encodeURIComponent(new URL(value).searchParams.get(key) || '')
        },
      },
    },
    '../API': {
      API: {
        async getBookmarkData(...args) {
          calls.push(args)
          return { error: false, body: { total } }
        },
      },
    },
    '../PageType': { pageType },
  }
  function load(file) {
    const source = fs.readFileSync(
      path.join(__dirname, '../src/ts', file),
      'utf8'
    )
    const code = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText
    const exports = {}
    vm.runInContext('(function(require,exports){' + code + '\n})', context)(
      (name) => {
        assert.ok(modules[name], name)
        return modules[name]
      },
      exports
    )
    return exports
  }
  const query = load('crawlMixedPage/BookmarkQuery.ts')
  modules['../crawlMixedPage/BookmarkQuery'] = query
  const info = load('download/AutomationBookmarkInfo.ts')
  return { context, pageType, calls, query, info }
}

test('artwork total 1000 plans 21 UI pages using lightweight PPBD request', async () => {
  const h = harness(
    'https://www.pixiv.net/en/users/117779967/bookmarks/artworks?rest=show&mode=all&p=21'
  )
  const value = await h.context.__PBD_AUTOMATION_BOOKMARK_INFO__()
  assert.equal(value.apiVersion, 1)
  assert.equal(value.total, 1000)
  assert.equal(value.uiPageSize, 48)
  assert.equal(value.lastPage, 21)
  assert.equal(value.offset, 960)
  assert.equal(value.order, 'desc')
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0][9], 1)
  assert.equal(h.calls[0][3], 0)
  assert.equal(new URL(value.canonicalUrl).searchParams.has('p'), false)
  value.total = 1
  assert.equal((await h.info.getAutomationBookmarkInfo()).total, 1000)
})

test('novel UI page size and empty total keep last page at least one', async () => {
  const h = harness('https://www.pixiv.net/users/1/bookmarks/novels?p=3', 61)
  const value = await h.info.getAutomationBookmarkInfo()
  assert.equal(value.bookmarkType, 'novels')
  assert.equal(value.uiPageSize, 30)
  assert.equal(value.lastPage, 3)
  assert.equal(value.offset, 60)
  assert.equal(h.calls[0][1], 'novels')
  assert.equal(
    (
      await harness(
        'https://www.pixiv.net/users/1/bookmarks/novels',
        0
      ).info.getAutomationBookmarkInfo()
    ).lastPage,
    1
  )
})

test('query filters match crawler interpretation and identity excludes navigation page', async () => {
  const h = harness(
    'https://www.pixiv.net/users/1/bookmarks/artworks/R-18?rest=hide&order=asc&mode=r18&work_tag=a%20b&bm=2026-10&p=4'
  )
  const value = await h.info.getAutomationBookmarkInfo()
  assert.deepEqual(Array.from(h.calls[0]), [
    '1',
    'illusts',
    'R-18',
    0,
    true,
    'asc',
    'r18',
    'a%20b',
    '202610',
    1,
  ])
  assert.equal(
    value.queryIdentity,
    h.query.getBookmarkQuery(h.context.location.href.replace('p=4', 'p=5'))
      .queryIdentity
  )
  assert.notEqual(
    value.queryIdentity,
    h.query.getBookmarkQuery(
      h.context.location.href.replace('rest=hide', 'rest=show')
    ).queryIdentity
  )
})

test('info is absent outside real Bookmark pages and rejects invalid total', async () => {
  const h = harness('https://www.pixiv.net/users/1/bookmarks/artworks', -1)
  await assert.rejects(
    h.info.getAutomationBookmarkInfo(),
    /invalid bookmark total/
  )
  h.pageType.type = 2
  assert.equal(h.context.__PBD_AUTOMATION_BOOKMARK_INFO__, undefined)
  await assert.rejects(h.info.getAutomationBookmarkInfo(), /only on Bookmark/)
  assert.equal(h.calls.length, 1)
  h.pageType.type = 4
  h.context.location.href =
    'https://www.pixiv.net/users/1/bookmarks/collections'
  assert.equal(h.context.__PBD_AUTOMATION_BOOKMARK_INFO__, undefined)
})

test('navigation during lookup invalidates the captured total', async () => {
  const h = harness('https://www.pixiv.net/users/1/bookmarks/artworks')
  const pending = h.info.getAutomationBookmarkInfo()
  h.context.location.href += '?p=2'
  await assert.rejects(pending, /changed during info/)
})
