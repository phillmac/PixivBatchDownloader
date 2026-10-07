const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

function load(file, dependencies, extra) {
  const exports = {}
  const context = vm.createContext({
    exports,
    require: (key) => {
      if (!(key in dependencies)) throw new Error(key)
      return dependencies[key]
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
  return exports
}
function harness() {
  const listeners = new Map()
  const window = {
    location: { href: 'https://www.pixiv.net/en/users/1' },
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
  }
  const fire = (name) => {
    for (const fn of listeners.get(name) || []) fn()
  }
  const EVT = { list: new Proxy({}, { get: (_, key) => key }) }
  const extra = {
    window,
    URL,
    crypto: { getRandomValues: (values) => values.fill(7) },
  }
  const bindings = load(
    'src/ts/download/AutomationCommandBindings.ts',
    { '../EVT': { EVT } },
    extra
  )
  const states = {
    settingInitialized: true,
    busy: false,
    downloading: false,
    crawlCompleteTime: 1,
    downloadCompleteTime: 0,
  }
  const store = { URLWhenCrawlStart: window.location.href, result: [] }
  const pageType = { type: 2 }
  const arm = {
    operationId: 'owned',
    url: window.location.href,
    state: 'armed',
  }
  const managed = { operation: null, arm, reload: false, blocked: false }
  const status = { phase: 'IDLE', lifecycle: {} }
  let prepared = false
  const calls = []
  let read = async () => JSON.parse(JSON.stringify(status))
  const api = load(
    'src/ts/download/AutomationCommands.ts',
    {
      '../PageType': {
        PageName: { UserHome: 2, Bookmark: 4, UserRequest: 25 },
        pageType,
      },
      '../store/States': { states },
      '../store/Store': { store },
      './AutomationCommandBindings': bindings,
      './AutomationStatus': { getAutomationStatus: () => read() },
      './ManagedCrawlAutomation': {
        getManagedCrawlArm: () => managed.arm,
        getManagedCrawl: () => managed.operation,
        managedCrawlRequiresReload: () => managed.reload,
        managedCrawlBlocksDownload: () => managed.blocked,
      },
    },
    extra
  )
  const registerCrawl = (
    fn = async () => {
      calls.push('crawl')
      managed.operation = { ...arm, state: 'crawling' }
      managed.arm = null
      states.busy = true
      status.phase = 'CRAWLING'
      fire('crawlStart')
    }
  ) => bindings.registerAutomationCrawl(pageType.type, fn)
  bindings.registerAutomationDownload({
    prepared: () => prepared,
    start: () => {
      calls.push('start')
      states.busy = true
      states.downloading = true
      status.phase = 'DOWNLOADING'
      fire('downloadStart')
    },
    pause: () => {
      calls.push('pause')
      states.busy = false
      states.downloading = false
      status.phase = 'PAUSED_RESUMABLE'
      fire('downloadPause')
    },
    stop: () => {
      calls.push('stop')
      states.busy = false
      states.downloading = false
      status.phase = 'STOPPED'
      fire('downloadStop')
    },
  })
  registerCrawl()
  const request = async (command, patch = {}) => ({
    command,
    url: window.location.href,
    token: (await api.getAutomationCommands()).token,
    operationId: 'owned',
    ...patch,
  })
  return {
    api,
    window,
    states,
    store,
    pageType,
    managed,
    status,
    bindings,
    calls,
    fire,
    request,
    registerCrawl,
    prepared(value) {
      prepared = value
    },
    read(fn) {
      read = fn
    },
  }
}

test('managed start consumes exact arm, reports pending, and never repeats an old token', async () => {
  const h = harness()
  const req = await h.request('crawl.start')
  const reply = await h.api.runAutomationCommand(req)
  assert.equal(reply.outcome, 'accepted')
  assert.equal(reply.state, 'pending')
  assert.equal(reply.operationId, 'owned')
  assert.deepEqual(h.calls, ['crawl'])
  assert.equal((await h.api.runAutomationCommand(req)).reason, 'stale-token')
  assert.deepEqual(h.calls, ['crawl'])
})
test('wrong owner, URL, reload requirement, busy state and existing results refuse before invocation', async () => {
  for (const [change, reason] of [
    [(h) => (h.managed.arm.operationId = 'other'), 'ownership-mismatch'],
    [(h) => (h.managed.reload = true), 'reload-required'],
    [(h) => (h.states.busy = true), 'busy-or-existing-task'],
    [(h) => h.store.result.push({}), 'existing-results'],
    [(h) => (h.status.phase = 'RESTORING'), 'busy-or-existing-task'],
  ]) {
    const h = harness()
    change(h)
    assert.equal(
      (await h.api.runAutomationCommand(await h.request('crawl.start'))).reason,
      reason
    )
    assert.equal(h.calls.length, 0)
  }
  const h = harness()
  const req = await h.request('crawl.start', {
    url: 'https://www.pixiv.net/en/users/2',
  })
  assert.equal((await h.api.runAutomationCommand(req)).reason, 'url-mismatch')
})
test('a refused backing handler is not reported as accepted and its token stays consumed', async () => {
  const h = harness()
  h.registerCrawl(async () => h.calls.push('refused-by-filter'))
  const req = await h.request('crawl.start')
  assert.equal((await h.api.runAutomationCommand(req)).reason, 'not-started')
  assert.equal((await h.api.runAutomationCommand(req)).reason, 'stale-token')
  assert.deepEqual(h.calls, ['refused-by-filter'])
})
test('concurrent command requests cannot invoke twice', async () => {
  const h = harness()
  const req = await h.request('crawl.start')
  const replies = await Promise.all([
    h.api.runAutomationCommand(req),
    h.api.runAutomationCommand(req),
  ])
  assert.equal(replies.filter((r) => r.outcome === 'accepted').length, 1)
  assert.deepEqual(h.calls, ['crawl'])
})
test('settings readiness and controller registration are explicit; SPA switch invalidates bindings', async () => {
  const h = harness()
  h.states.settingInitialized = false
  assert.equal(
    (await h.api.runAutomationCommand(await h.request('crawl.start'))).reason,
    'not-ready'
  )
  h.states.settingInitialized = true
  const previous = await h.request('crawl.start')
  h.pageType.type = 4
  h.fire('pageSwitchedTypeChange')
  assert.equal((await h.api.getAutomationCommands()).crawlReady, false)
  assert.equal(
    (await h.api.runAutomationCommand(previous)).reason,
    'stale-token'
  )
  h.window.location.href += '/bookmarks/artworks'
  h.registerCrawl()
  assert.equal((await h.api.getAutomationCommands()).crawlReady, true)
  h.window.location.href = 'https://www.pixiv.net/en/artworks/1'
  assert.equal((await h.api.getAutomationCommands()).crawlReady, false)
})
test('URL and lifecycle changes during asynchronous status reads refuse before invocation', async () => {
  for (const change of [
    (h) => (h.window.location.href += '/novels'),
    (h) => h.fire('resume'),
  ]) {
    const h = harness()
    const req = await h.request('crawl.start')
    h.read(async () => {
      change(h)
      return h.status
    })
    assert.equal((await h.api.runAutomationCommand(req)).outcome, 'refused')
    assert.deepEqual(h.calls, [])
  }
})
test('download start waits for native delayed preparation and binds exact queue URL', async () => {
  const h = harness()
  h.status.phase = 'READY'
  h.store.result.push({})
  assert.equal(
    (await h.api.runAutomationCommand(await h.request('download.start')))
      .reason,
    'not-ready'
  )
  h.prepared(true)
  h.store.URLWhenCrawlStart += '/novels'
  assert.equal(
    (await h.api.runAutomationCommand(await h.request('download.start')))
      .reason,
    'queue-url-mismatch'
  )
  h.store.URLWhenCrawlStart = h.window.location.href
  const req = await h.request('download.start')
  const reply = await h.api.runAutomationCommand(req)
  assert.equal(reply.outcome, 'accepted')
  assert.equal(reply.state, 'pending')
  assert.equal((await h.api.runAutomationCommand(req)).reason, 'stale-token')
  assert.deepEqual(h.calls, ['start'])
})
test('pause and stop require an active download, do not complete in-flight files, and never affect crawling', async () => {
  for (const command of ['download.pause', 'download.stop']) {
    const h = harness()
    h.status.phase = 'CRAWLING'
    h.states.busy = true
    assert.equal(
      (await h.api.runAutomationCommand(await h.request(command))).reason,
      'not-downloading'
    )
    h.status.phase = 'DOWNLOADING'
    h.states.downloading = true
    const reply = await h.api.runAutomationCommand(await h.request(command))
    assert.equal(reply.state, 'pending')
    assert.equal(reply.outcome, 'accepted')
    assert.deepEqual(h.calls, [command.split('.')[1]])
  }
})
test('revoked managed queue blocks every download command', async () => {
  const h = harness()
  h.managed.blocked = true
  for (const command of ['download.start', 'download.pause', 'download.stop'])
    assert.equal(
      (await h.api.runAutomationCommand(await h.request(command))).reason,
      'revoked-crawl'
    )
  assert.deepEqual(h.calls, [])
})

test('legacy crawl stop uses native control, rejects managed ownership and stale permits', async () => {
  const h = harness()
  h.status.phase = 'CRAWLING'
  h.states.busy = true
  h.bindings.registerAutomationCrawlStop(() => {
    h.calls.push('crawl-stop')
    h.states.stopCrawl = true
    h.fire('stopCrawl')
  })
  h.managed.operation = { ...h.managed.arm, state: 'crawling' }
  assert.equal(
    (await h.api.runAutomationCommand(await h.request('crawl.stop'))).reason,
    'use-managed-abort'
  )
  h.managed.operation = null
  const req = await h.request('crawl.stop')
  assert.equal((await h.api.runAutomationCommand(req)).outcome, 'accepted')
  assert.equal(h.states.stopCrawl, true)
  assert.equal((await h.api.runAutomationCommand(req)).reason, 'stale-token')
  assert.deepEqual(h.calls, ['crawl-stop'])
})

test('download method return alone is not acceptance without its lifecycle transition', async () => {
  const h = harness()
  h.status.phase = 'READY'
  h.store.result.push({})
  h.bindings.registerAutomationDownload({
    prepared: () => true,
    start() {},
    pause() {},
    stop() {},
  })
  const req = await h.request('download.start')
  assert.equal((await h.api.runAutomationCommand(req)).reason, 'not-started')
  assert.equal((await h.api.runAutomationCommand(req)).reason, 'stale-token')
  h.status.phase = 'DOWNLOADING'
  h.states.downloading = true
  assert.equal(
    (await h.api.runAutomationCommand(await h.request('download.pause')))
      .reason,
    'not-stopped'
  )
})

test('all audited request routes register readyCrawl without generic button dispatch', async () => {
  for (const suffix of [
    'request',
    'request/artworks',
    'request/novels',
    'request/sent',
    'request/sent/artworks',
    'request/sent/novels',
  ]) {
    const h = harness()
    h.window.location.href += '/' + suffix
    h.pageType.type = 25
    h.managed.arm.url = h.window.location.href
    h.registerCrawl()
    assert.equal((await h.api.getAutomationCommands()).crawlReady, true)
    assert.equal(
      (await h.api.runAutomationCommand(await h.request('crawl.start')))
        .outcome,
      'accepted'
    )
  }
  const h = harness()
  h.window.location.href += '/request/plans'
  h.pageType.type = 25
  h.registerCrawl()
  assert.equal((await h.api.getAutomationCommands()).crawlReady, false)
})

test('non-default crawl modes refuse before consuming arm or starting unowned work', async () => {
  for (const mode of [
    'bookmarkMode',
    'crawlTagList',
    'quickCrawl',
    'timedCrawlMode',
  ]) {
    const h = harness()
    h.states[mode] = true
    assert.equal(
      (await h.api.runAutomationCommand(await h.request('crawl.start'))).reason,
      'non-default-crawl-mode'
    )
    assert.deepEqual(h.calls, [])
    assert.equal(h.managed.arm.state, 'armed')
  }
})
test('token invalidation prevents a timed-out asynchronous command from starting later', async () => {
  const h = harness()
  const req = await h.request('download.start')
  h.status.phase = 'READY'
  h.store.result.push({})
  h.prepared(true)
  let release
  h.read(() => new Promise((resolve) => (release = resolve)))
  const pending = h.api.runAutomationCommand(req)
  assert.equal(
    h.api.invalidateAutomationCommand(req.token).outcome,
    'invalidated'
  )
  release(h.status)
  assert.equal((await pending).reason, 'stale-token')
  assert.deepEqual(h.calls, [])
  const freshToken = h.bindings.getAutomationCommandBindings().token
  assert.equal(
    h.api.invalidateAutomationCommand(req.token).outcome,
    'superseded'
  )
  assert.equal(h.bindings.getAutomationCommandBindings().token, freshToken)
})
