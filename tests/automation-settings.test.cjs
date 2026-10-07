const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

function load(file, dependencies, extra = {}) {
  const exports = {}
  const context = vm.createContext({
    exports,
    require: (name) => {
      if (!(name in dependencies)) throw new Error(name)
      return dependencies[name]
    },
    console,
    ...extra,
  })
  vm.runInContext(
    ts.transpileModule(
      fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }
    ).outputText,
    context
  )
  return { exports, context }
}
const clone = (value) => JSON.parse(JSON.stringify(value))
function harness(sync = 'synchronizeChanges') {
  const cfg = { page: true, work: false, value: 1, min: 1, max: -1, tip: '' }
  const settings = {
    crawlNumber: {
      2: cfg,
      4: { ...cfg, page: false, work: true },
      0: { ...cfg, page: false, max: 0 },
    },
    DonotCrawlAlreadyDownloadedWorks: false,
    deduplication: true,
    autoStartDownload: true,
    autoStartDownloadForQuickDownload: false,
    settingsAcrossDifferentTabs: sync,
    unrelated: 'keep',
  }
  let stored = clone(settings)
  const other = clone(settings)
  let fail = false
  let ready = true
  const events = []
  const states = { busy: false }
  const persistence = load('src/ts/setting/SettingPersistence.ts', {}).exports
  const { exports: worker } = load(
    'src/ts/serviceWorker/SettingPersistence.ts',
    {
      'webextension-polyfill': {
        default: {
          storage: {
            local: {
              get: async () => ({ xzSetting: clone(stored) }),
              set: async (data) => {
                if (fail) throw new Error('disk failure')
                stored = clone(data.xzSetting)
                if (sync === 'synchronizeChanges')
                  Object.assign(other, clone(stored))
              },
            },
          },
        },
      },
      '../Config': { Config: { settingStoreName: 'xzSetting' } },
      '../setting/SettingPersistence': persistence,
    }
  )
  const persistControl = async (key, value, crawlPage) => {
    await worker.handleSettingPatch({
      msg: persistence.SETTING_PATCH_MESSAGE,
      patch: { [key]: value },
      crawlPage,
    })
    settings[key] =
      crawlPage === undefined ? value : { ...settings[key], [crawlPage]: value }
    events.push(key)
  }
  const api = load('src/ts/setting/AutomationSettings.ts', {
    'webextension-polyfill': {
      default: {
        storage: { local: { get: async () => ({ xzSetting: clone(stored) }) } },
      },
    },
    '../Config': { Config: { settingStoreName: 'xzSetting' } },
    '../PageType': {
      PageName: { 2: 'UserHome', 4: 'Bookmark', 0: 'Home' },
      pageType: { type: 2 },
    },
    '../store/States': { states },
    './Settings': {
      settings,
      settingPersistence: {
        isRestored: () => ready,
        flush: async () => {},
        persistControl,
      },
    },
  }).exports
  return {
    api,
    settings,
    other,
    states,
    events,
    worker,
    persistence,
    stored: () => stored,
    fail: (value) => (fail = value),
    ready: (value) => (ready = value),
  }
}

test('crawl limits preserve page context, -1 sentinel and unrelated settings', async () => {
  const h = harness()
  const before = clone(h.stored())
  for (const value of [-1, 1000, 1]) {
    const reply = await h.api.setAutomationSetting('crawlNumber', value, {
      pageType: 2,
    })
    assert.equal(reply.effectiveValue, value)
    assert.equal(reply.unit, 'pages')
    assert.equal(reply.pageTypeName, 'UserHome')
    assert.equal(reply.verified, true)
    assert.equal(reply.requiresReload, false)
    assert.equal(h.other.crawlNumber[2].value, value)
    assert.deepEqual(h.stored().crawlNumber[4], before.crawlNumber[4])
    assert.equal(h.stored().unrelated, 'keep')
  }
  assert.deepEqual(h.stored(), before)
  assert.equal(
    (await h.api.getAutomationSetting('crawlNumber', { pageType: 4 })).unit,
    'works'
  )
})

test('boolean controls are independent and local runtime updates with sync disabled', async () => {
  const h = harness('doNotSynchronizeChanges')
  for (const key of [
    'DonotCrawlAlreadyDownloadedWorks',
    'deduplication',
    'autoStartDownload',
    'autoStartDownloadForQuickDownload',
  ]) {
    const before = clone(h.stored())
    const result = await h.api.setAutomationSetting(key, !before[key])
    assert.equal(result.previousValue, before[key])
    assert.equal(result.crossTab.propagation, 'disabled')
    assert.equal(result.crossTab.acknowledged, false)
    assert.equal(h.settings[key], !before[key])
    assert.equal(h.other[key], before[key])
    for (const other of Object.keys(before).filter((k) => k !== key))
      assert.deepEqual(h.stored()[other], before[other])
  }
})

test('invalid, uninitialized and busy requests fail before mutation', async () => {
  const h = harness()
  const before = clone(h.stored())
  for (const [key, value, options] of [
    ['unrelated', true],
    ['deduplication', 1],
    ['crawlNumber', 0],
    ['crawlNumber', -2],
    ['crawlNumber', 1.5],
    ['crawlNumber', Infinity],
    ['crawlNumber', 1, { pageType: 99 }],
    ['crawlNumber', 1, { pageType: 0 }],
  ])
    await assert.rejects(h.api.setAutomationSetting(key, value, options))
  h.ready(false)
  await assert.rejects(
    h.api.getAutomationSetting('deduplication'),
    /initialized/
  )
  h.ready(true)
  h.states.busy = true
  await assert.rejects(
    h.api.setAutomationSetting('deduplication', false),
    /busy/
  )
  assert.deepEqual(h.stored(), before)
})

test('failed persistence leaves runtime intact and the queue recovers', async () => {
  const h = harness()
  h.fail(true)
  await assert.rejects(
    h.api.setAutomationSetting('crawlNumber', -1),
    /disk failure/
  )
  assert.equal(h.settings.crawlNumber[2].value, 1)
  h.fail(false)
  assert.equal(
    (await h.api.setAutomationSetting('crawlNumber', -1)).verified,
    true
  )
})

test('background serializes concurrent tab patches and preserves other page limits', async () => {
  const h = harness()
  await Promise.all([
    h.worker.handleSettingPatch({
      msg: h.persistence.SETTING_PATCH_MESSAGE,
      patch: { deduplication: false },
    }),
    h.worker.handleSettingPatch({
      msg: h.persistence.SETTING_PATCH_MESSAGE,
      patch: { autoStartDownload: false },
    }),
    h.worker.handleSettingPatch({
      msg: h.persistence.SETTING_PATCH_MESSAGE,
      patch: { crawlNumber: { ...h.settings.crawlNumber[2], value: 1000 } },
      crawlPage: 2,
    }),
  ])
  assert.equal(h.stored().deduplication, false)
  assert.equal(h.stored().autoStartDownload, false)
  assert.equal(h.stored().crawlNumber[2].value, 1000)
  assert.equal(h.stored().crawlNumber[4].value, 1)
})

// Real Settings owner: exercise its setter/event/persistence behavior, rather than
// modeling cross-tab synchronization in the automation harness alone.
async function settingsOwnerHarness(fresh = false) {
  let stored = {
    crawlNumber: {
      2: { work: false, page: true, min: 1, max: -1, value: 1, tip: '' },
    },
    deduplication: true,
    unrelatedFutureKey: 'retain',
  }
  if (fresh) stored = {}
  const listeners = []
  const debounces = []
  const events = []
  const windowListeners = new Map()
  const window = {
    addEventListener(name, fn) {
      if (!windowListeners.has(name)) windowListeners.set(name, [])
      windowListeners.get(name).push(fn)
    },
  }
  const EVT = {
    list: new Proxy({}, { get: (_, name) => name }),
    fire(name, data) {
      events.push({ name, data })
      for (const fn of windowListeners.get(name) || []) fn({ detail: { data } })
    },
  }
  let pageId = -1
  const PageName = new Proxy(
    {},
    {
      get(target, name) {
        if (!(name in target)) target[name] = pageId++
        return target[name]
      },
    }
  )
  // Force the order to match the actual stable enum.
  for (const name of [
    'Unsupported',
    'Home',
    'Artwork',
    'UserHome',
    'BookmarkLegacy',
    'Bookmark',
    'ArtworkSearch',
    'AreaRanking',
    'ArtworkRanking',
    'Pixivision',
    'BookmarkDetail',
    'NewArtworkFromFollowing',
    'Discover',
    'NewArtworkFromAllUsers',
    'Novel',
    'NovelSeries',
    'NovelSearch',
    'NovelRanking',
    'NewNovelFromFollowing',
    'NewNovelFromAllUsers',
    'ArtworkSeries',
    'Following',
    'Request',
    'Unlisted',
    'DiscoverUsers',
    'Dashboard',
    'Contest',
    'SearchUsers',
    'UserRequest',
  ])
    PageName[name]
  const persistence = load('src/ts/setting/SettingPersistence.ts', {}).exports
  const { exports: worker } = load(
    'src/ts/serviceWorker/SettingPersistence.ts',
    {
      'webextension-polyfill': {
        default: {
          storage: {
            local: {
              get: async () => ({ xzSetting: clone(stored) }),
              set: async (data) => {
                stored = clone(data.xzSetting)
                for (const listener of listeners)
                  listener({ xzSetting: { newValue: clone(stored) } }, 'local')
              },
            },
          },
        },
      },
      '../Config': { Config: { settingStoreName: 'xzSetting' } },
      '../setting/SettingPersistence': persistence,
    }
  )
  let sendHook = null
  const owner = load(
    'src/ts/setting/Settings.ts',
    {
      'webextension-polyfill': {
        default: {
          storage: {
            local: { get: async () => ({ xzSetting: clone(stored) }) },
            onChanged: { addListener: (fn) => listeners.push(fn) },
          },
          runtime: {
            sendMessage: (msg) =>
              sendHook ? sendHook(msg) : worker.handleSettingPatch(msg),
          },
        },
      },
      './SettingPersistence': persistence,
      '../EVT': { EVT },
      '../utils/Utils': {
        Utils: {
          deepCopy: clone,
          debounce: (fn) => {
            debounces.push(fn)
            return () => {}
          },
        },
      },
      './ConvertOldSettings': {
        convertOldSettings: { convertString: (_, value) => value },
      },
      '../MsgBox': { msgBox: {} },
      '../Config': { Config: { settingStoreName: 'xzSetting' } },
      '../utils/SecretSignal': { secretSignal: { register() {} } },
      '../Toast': { toast: {} },
      '../Language': { lang: {} },
      '../PageType': { PageName },
      '../PPDTask': { ppdTask: { register() {} } },
      '../Tools': { Tools: {} },
      '../download/SendDownload': { SendDownload: {} },
    },
    { window }
  ).exports
  await new Promise((resolve) => setImmediate(resolve))
  return {
    owner,
    interceptSend: (fn) => {
      sendHook = fn
    },
    worker,
    events,
    debounces,
    stored: () => stored,
    remote: async (patch) => {
      await worker.handleSettingPatch({
        msg: persistence.SETTING_PATCH_MESSAGE,
        patch,
      })
    },
  }
}

test('real Settings setter emits events and patches preserve remote unrelated values', async () => {
  const h = await settingsOwnerHarness()
  assert.equal(h.owner.settingPersistence.isRestored(), true)
  h.owner.setSetting('settingsAcrossDifferentTabs', 'doNotSynchronizeChanges')
  await h.owner.settingPersistence.flush()
  await h.remote({ autoStartDownload: false })
  assert.equal(h.owner.settings.autoStartDownload, true)
  h.owner.setSetting('deduplication', false)
  await h.owner.settingPersistence.flush()
  assert.equal(h.stored().autoStartDownload, false)
  assert.equal(h.stored().unrelatedFutureKey, 'retain')
  await h.owner.settingPersistence.persistControl(
    'crawlNumber',
    { ...h.owner.settings.crawlNumber[2], value: -1 },
    2
  )
  assert.equal(h.owner.settings.crawlNumber[2].value, -1)
  assert.equal(h.stored().crawlNumber[2].value, -1)
  assert.ok(
    h.events.some(
      (e) => e.name === 'settingChange' && e.data.name === 'crawlNumber'
    )
  )
})

test('real Settings storage synchronization applies remote values and fires runtime events', async () => {
  const h = await settingsOwnerHarness()
  await h.remote({ deduplication: false })
  assert.equal(h.owner.settings.deduplication, false)
  assert.ok(
    h.events.some(
      (e) =>
        e.name === 'settingChange' &&
        e.data.name === 'deduplication' &&
        e.data.value === false
    )
  )
  await h.owner.settingPersistence.flush()
  assert.equal(h.stored().deduplication, false)
})

test('verification ignores storage object-key order but preserves array order', () => {
  const { canonicalSettingValue: canonical } = load(
    'src/ts/setting/SettingPersistence.ts',
    {}
  ).exports
  assert.equal(
    canonical({ b: 2, a: { d: 4, c: 3 } }),
    canonical({ a: { c: 3, d: 4 }, b: 2 })
  )
  assert.notEqual(canonical([1, 2]), canonical([2, 1]))
})

test('derived settings persist with their controlling settings', async () => {
  const h = await settingsOwnerHarness()
  for (const [key, value, derived, expected] of [
    ['restrict', 'yes', 'restrictBoolean', true],
    ['widthTag', 'yes', 'widthTagBoolean', true],
    ['ratio', 'userSet', 'userSetChecked', true],
    ['ugoiraSaveAs', 'gif', 'ugoiraSaveAsGIF', true],
  ]) {
    h.owner.setSetting(key, value)
    await h.owner.settingPersistence.flush()
    assert.equal(h.stored()[derived], expected)
  }
  assert.equal(h.stored().ugoiraSaveAsWebM, false)
})

test('UI single-page writes preserve other tabs page limits and automation emits saved event', async () => {
  const h = await settingsOwnerHarness()
  h.owner.setSetting('settingsAcrossDifferentTabs', 'doNotSynchronizeChanges')
  await h.owner.settingPersistence.flush()
  await h.remote({
    crawlNumber: { 4: { ...h.owner.settings.crawlNumber[4], value: 1000 } },
  })
  h.owner.settingPersistence.setCrawlNumberForPage(2, {
    ...h.owner.settings.crawlNumber[2],
    value: -1,
  })
  await h.owner.settingPersistence.flush()
  assert.equal(h.stored().crawlNumber[4].value, 1000)
  assert.equal(h.stored().crawlNumber[2].value, -1)
  const savedBefore = h.events.filter((e) => e.name === 'settingsStored').length
  await h.owner.settingPersistence.persistControl('deduplication', false)
  assert.equal(
    h.events.filter((e) => e.name === 'settingsStored').length,
    savedBefore + 1
  )
})

test('fresh and upgraded storage page maps do not replace runtime defaults', async () => {
  for (const fresh of [false, true]) {
    const h = await settingsOwnerHarness(fresh)
    const pages = Object.keys(h.owner.settings.crawlNumber)
    h.owner.settingPersistence.setCrawlNumberForPage(2, {
      ...h.owner.settings.crawlNumber[2],
      value: -1,
    })
    await h.owner.settingPersistence.flush()
    assert.deepEqual(Object.keys(h.owner.settings.crawlNumber), pages)
    assert.ok(h.owner.settings.crawlNumber[4])
    await h.remote({
      crawlNumber: { 4: { ...h.owner.settings.crawlNumber[4], value: 1000 } },
    })
    assert.deepEqual(Object.keys(h.owner.settings.crawlNumber), pages)
    assert.equal(h.owner.settings.crawlNumber[4].value, 1000)
    assert.equal(h.owner.settings.crawlNumber[2].value, -1)
  }
})

test('failed flush cannot replay an older value after a newer queued flush succeeds', async () => {
  const h = await settingsOwnerHarness()
  let rejectFirst
  h.interceptSend(() => {
    h.interceptSend(null)
    return new Promise((_resolve, reject) => {
      rejectFirst = reject
    })
  })
  h.owner.setSetting('deduplication', false)
  const first = h.owner.settingPersistence.flush()
  const rejected = assert.rejects(first, /first write failed/)
  await new Promise((resolve) => setImmediate(resolve))
  h.owner.setSetting('deduplication', true)
  const second = h.owner.settingPersistence.flush()
  rejectFirst(new Error('first write failed'))
  await rejected
  await second
  assert.equal(h.stored().deduplication, true)
  await h.owner.settingPersistence.flush()
  assert.equal(h.stored().deduplication, true)
  assert.equal(h.owner.settings.deduplication, true)
})
