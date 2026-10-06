const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')
const vm = require('node:vm')
function load(file, dependencies = {}, globals = {}) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  vm.runInNewContext(`(function(require,exports){${code}\n})`, {
    console,
    setTimeout,
    clearTimeout,
    ...globals,
  })((name) => dependencies[name], exports)
  return exports
}
const policy = load('src/ts/crawl/CrawlRatePolicy.ts')
const state = () => ({ sessions: {}, nextAt: {}, lastAt: {}, waiting: {} })
for (const count of [40, 50, 51]) {
  test(`${count} works selects ${count > 50 ? 'paced' : 'fast'}`, () => {
    const s = state()
    policy.registerCrawl(s, 'one', '123', 1, count, 0)
    assert.equal(s.sessions.one.paced, count > 50)
    for (let i = 0; i < count; i++)
      assert.equal(
        policy.permitCrawl(s, 'one', i).granted,
        count <= 50 || i === 0
      )
    assert.equal(policy.FAST_ALLOWANCE_WORKS, 100)
    assert.equal(policy.FAST_TO_PACED_THRESHOLD, 50)
  })
}
test('large job and concurrent same-account jobs share one stream', () => {
  const s = state()
  policy.registerCrawl(s, 'a', '123', 1, 500, 0)
  policy.registerCrawl(s, 'b', '123', 2, 500, 0)
  for (let i = 0; i < 200; i++) {
    const id = i % 2 ? 'a' : 'b'
    assert.equal(policy.permitCrawl(s, id, i * 1800).granted, true)
    assert.equal(
      policy.permitCrawl(s, i % 2 ? 'b' : 'a', i * 1800 + 1799).granted,
      false
    )
  }
})
test('small concurrent job is paced; accounts remain independent', () => {
  const s = state()
  policy.registerCrawl(s, 'a', '123', 1, 40, 0)
  policy.registerCrawl(s, 'b', '123', 2, 40, 0)
  policy.registerCrawl(s, 'c', '456', 3, 51, 0)
  assert.equal(s.sessions.a.paced, true)
  assert.equal(s.sessions.b.paced, true)
  policy.permitCrawl(s, 'a', 100)
  assert.equal(policy.permitCrawl(s, 'b', 100).granted, false)
  assert.equal(policy.permitCrawl(s, 'c', 100).granted, true)
})
test('persisted restart and cleanup retain spacing and identity', () => {
  let s = state()
  policy.registerCrawl(s, 'a', '123', 1, 51, 0)
  policy.permitCrawl(s, 'a', 100)
  s = JSON.parse(JSON.stringify(s))
  policy.registerCrawl(s, 'a', '123', 1, 40, 0)
  assert.equal(s.sessions.a.paced, true)
  assert.equal(policy.permitCrawl(s, 'a', 200).granted, false)
  delete s.sessions.a
  assert.throws(() => policy.permitCrawl(s, 'a', 200))
  policy.registerCrawl(s, 'b', '123', 1, 51, 0)
  assert.equal(policy.permitCrawl(s, 'b', 200).granted, false)
})
test('waited permits fence aborted and superseded generations', async () => {
  for (const revokeAfter of ['wait', 'reply']) {
    let valid = true
    let slept = 0
    let permits = 0
    const browser = {
      runtime: {
        connect() {
          let messageListener
          return {
            onMessage: {
              addListener(fn) {
                messageListener = fn
              },
            },
            onDisconnect: { addListener() {} },
            disconnect() {},
            postMessage(msg) {
              if (msg.action === 'permit') permits++
              if (permits === 2 && revokeAfter === 'reply') valid = false
              queueMicrotask(() =>
                messageListener({
                  request: msg.request,
                  granted: msg.action !== 'permit' || permits > 1,
                  retryAfterMs: 1800,
                })
              )
            },
          }
        },
      },
    }
    const { CrawlRateClient } = load(
      'src/ts/crawl/CrawlRateClient.ts',
      {
        'webextension-polyfill': { default: browser },
        './CrawlRatePolicy': policy,
        '../utils/Utils': {
          Utils: {
            async sleep() {
              slept++
              if (revokeAfter === 'wait') valid = false
            },
          },
        },
      },
      { crypto: require('node:crypto'), queueMicrotask }
    )
    const client = new CrawlRateClient('session', '123', 51)
    assert.equal(await client.permit(() => valid), false)
    assert.equal(slept, 1)
    client.finish()
  }
})

test('metadata permit finalizes only a stopped current generation', async () => {
  const source = ts.createSourceFile(
    'InitPageBase.ts',
    fs.readFileSync('src/ts/crawl/InitPageBase.ts', 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const declaration = source.statements.find(ts.isClassDeclaration)
  const method = declaration.members.find(
    (member) => member.name?.getText(source) === 'waitForMetadataPermit'
  )
  // Execute the actual method in isolation from the content-script UI.
  const code = ts.transpileModule(
    `class Worker { ${method.getText(source)} } Worker`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText
  for (const scenario of [
    'stopped',
    'superseded',
    'closed',
    'granted',
    'already stopped',
  ]) {
    const generation = {}
    let current = generation
    const states = { stopCrawl: scenario === 'already stopped' }
    const Worker = vm.runInNewContext(code, {
      states,
      ownsCrawl: (value) => value === current,
    })
    const worker = new Worker()
    const finalized = []
    let permits = 0
    worker.crawlFinished = (value) => finalized.push(value)
    worker.rateSession = {
      generation,
      client: {
        async permit(valid) {
          permits++
          assert.equal(valid(), true)
          // Change ownership/stop while the permit is pending.
          await Promise.resolve()
          if (scenario === 'stopped' || scenario === 'superseded')
            states.stopCrawl = true
          if (scenario === 'superseded') current = {}
          return scenario === 'granted'
        },
      },
    }
    assert.equal(
      await worker.waitForMetadataPermit(generation),
      scenario === 'granted'
    )
    assert.deepEqual(
      finalized,
      scenario === 'stopped' || scenario === 'already stopped'
        ? [generation]
        : []
    )
    assert.equal(permits, scenario === 'already stopped' ? 0 : 1)
  }
})

test('fast starts move both gates; boundary is exactly 1800ms', () => {
  const s = state()
  policy.registerCrawl(s, 'fast', '123', 1, 40, 0)
  for (const now of [0, 10, 20])
    assert.equal(policy.permitCrawl(s, 'fast', now).granted, true)
  assert.equal(s.lastAt['123'], 20)
  assert.equal(s.nextAt['123'], 1820)
  policy.registerCrawl(s, 'paced', '123', 2, 51, 20)
  assert.equal(policy.permitCrawl(s, 'paced', 1819).granted, false)
  assert.equal(s.sessions.fast.paced, true)
  assert.equal(s.sessions.paced.paced, true)
  assert.equal(policy.permitCrawl(s, 'fast', 1819).granted, false)
  assert.equal(policy.permitCrawl(s, 'fast', 1820).granted, false)
  assert.deepEqual(Array.from(s.waiting['123']), ['paced', 'fast'])
  assert.equal(policy.permitCrawl(s, 'paced', 1820).granted, true)
  assert.equal(policy.permitCrawl(s, 'paced', 3619).granted, false)
  assert.equal(policy.permitCrawl(s, 'paced', 3620).granted, false)
  assert.equal(policy.permitCrawl(s, 'fast', 3620).granted, true)
})
test('expiry refreshes on registration and denied permits, retaining the gate', () => {
  const s = state()
  const ttl = policy.SESSION_TTL_MS
  policy.registerCrawl(s, 'a', '123', 1, 51, 0)
  policy.registerCrawl(s, 'a', '123', 1, 40, ttl - 1)
  assert.equal(s.sessions.a.expiresAt, 2 * ttl - 1)
  policy.permitCrawl(s, 'a', 2 * ttl - 2)
  policy.permitCrawl(s, 'a', 2 * ttl - 1)
  assert.equal(s.sessions.a.expiresAt, 3 * ttl - 1)
  policy.expireCrawls(s, 3 * ttl - 1)
  assert.equal(s.sessions.a, undefined)
  assert.equal(s.nextAt['123'], 2 * ttl - 2 + 1800)
  assert.throws(() => policy.permitCrawl(s, 'a', 3 * ttl))
})
test('storage validation initializes all fields and migrates legacy state safely', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(policy.readCrawlRateState(undefined, 0))),
    state()
  )
  const legacy = {
    sessions: { a: { account: '123', tabId: 1, paced: true, started: 1 } },
    nextAt: { 123: 1900 },
  }
  const restored = policy.readCrawlRateState(legacy, 100)
  assert.equal(restored.sessions.a.expiresAt, 100 + policy.SESSION_TTL_MS)
  assert.equal(policy.permitCrawl(restored, 'a', 1899).granted, false)
  assert.equal(policy.permitCrawl(restored, 'a', 1900).granted, true)
  for (const broken of [
    null,
    {},
    { sessions: {}, nextAt: { 123: 'bad' } },
    { sessions: { a: {} }, nextAt: {} },
  ])
    assert.throws(() => policy.readCrawlRateState(broken, 0))
})
test('main path has one integration, preserves cache and existing slow fallback', () => {
  const source = fs.readFileSync('src/ts/crawl/InitPageBase.ts', 'utf8')
  assert.doesNotMatch(source, /SharedCrawlRate|this\.crawlRate/)
  assert.equal(
    (source.match(/await this.waitForMetadataPermit\(generation\)/g) || [])
      .length,
    2
  )
  assert.match(source, /if \(!cacheWorkData.get\(id, 'novel'\)\)/)
  assert.match(source, /Utils.sleep\(settings.slowCrawlDealy\)/)
  assert.equal(
    (
      fs
        .readFileSync('src/ts/serviceWorker/background.ts', 'utf8')
        .match(/import '.\/CrawlRateCoordinator'/g) || []
    ).length,
    1
  )
})

test('coordinator serializes, persists restart, rejects storage failure and cleans tabs', async () => {
  const disk = {}
  let fail = false
  let connect, removed, updated
  const area = {
    async get(key) {
      return {
        [key]:
          disk[key] === undefined
            ? undefined
            : JSON.parse(JSON.stringify(disk[key])),
      }
    },
    async set(values) {
      if (fail) throw new Error('storage failed')
      Object.assign(disk, JSON.parse(JSON.stringify(values)))
    },
  }
  const browser = {
    storage: { local: area, session: area },
    tabs: {
      onRemoved: {
        addListener(fn) {
          removed = fn
        },
      },
      onUpdated: {
        addListener(fn) {
          updated = fn
        },
      },
    },
    runtime: {
      onConnect: {
        addListener(fn) {
          connect = fn
        },
      },
    },
  }
  let now = 100
  function restart() {
    load(
      'src/ts/serviceWorker/CrawlRateCoordinator.ts',
      {
        'webextension-polyfill': { default: browser },
        '../crawl/CrawlRatePolicy': policy,
      },
      { Date: { now: () => now } }
    )
  }
  function send(tab, action, id, fields = {}) {
    return new Promise((resolve) => {
      let receive
      const port = {
        name: policy.CRAWL_RATE_PORT,
        sender: { tab: { id: tab } },
        onDisconnect: { addListener() {} },
        onMessage: {
          addListener(fn) {
            receive = fn
          },
        },
        disconnect() {},
        postMessage: resolve,
      }
      connect(port)
      receive({ action, id, request: id, ...fields })
    })
  }
  restart()
  await send(1, 'register', 'a', { account: '', workCount: 51 })
  await send(2, 'register', 'b', { account: 'unavailable', workCount: 51 })
  const replies = await Promise.all([
    send(1, 'permit', 'a'),
    send(2, 'permit', 'b'),
  ])
  assert.equal(replies.filter((r) => r.granted).length, 1)
  assert.equal(disk.ppbdCrawlRateV1.sessions.a.account, policy.UNKNOWN_ACCOUNT)
  restart()
  assert.equal((await send(2, 'permit', 'b')).granted, false)
  now += 1800
  fail = true
  assert.ok((await send(2, 'permit', 'b')).error)
  fail = false
  assert.equal((await send(2, 'permit', 'b')).granted, true)
  await send(2, 'permit', 'b')
  assert.ok(disk.ppbdCrawlRateV1.waiting[policy.UNKNOWN_ACCOUNT].includes('b'))
  updated(2, { status: 'loading' })
  assert.ok((await send(2, 'permit', 'b')).error)
  assert.equal(disk.ppbdCrawlRateV1.waiting[policy.UNKNOWN_ACCOUNT], undefined)
  await send(1, 'permit', 'a')
  removed(1)
  assert.ok((await send(1, 'permit', 'a')).error)
  assert.equal(disk.ppbdCrawlRateV1.waiting[policy.UNKNOWN_ACCOUNT], undefined)
  await send(3, 'register', 'stale', { account: '123', workCount: 51 })
  now += policy.SESSION_TTL_MS
  await send(4, 'register', 'fresh', { account: '123', workCount: 40 })
  assert.equal(disk.ppbdCrawlRateV1.sessions.stale, undefined)
  assert.equal(disk.ppbdCrawlRateV1.sessions.fresh.paced, false)
})

test('expired client re-registers paced and closed client cannot resume', async () => {
  const messages = []
  let permits = 0
  const browser = {
    runtime: {
      connect() {
        let receive
        return {
          onMessage: {
            addListener(fn) {
              receive = fn
            },
          },
          onDisconnect: { addListener() {} },
          disconnect() {},
          postMessage(msg) {
            messages.push(msg)
            const expired = msg.action === 'permit' && ++permits === 1
            queueMicrotask(() =>
              receive({
                request: msg.request,
                ...(expired ? { error: 'expired' } : { granted: true }),
              })
            )
          },
        }
      },
    },
  }
  const { CrawlRateClient } = load(
    'src/ts/crawl/CrawlRateClient.ts',
    {
      'webextension-polyfill': { default: browser },
      './CrawlRatePolicy': policy,
      '../utils/Utils': { Utils: { async sleep() {} } },
    },
    { crypto: require('node:crypto'), queueMicrotask }
  )
  const client = new CrawlRateClient('manual:unique', '123', 40)
  assert.equal(await client.permit(() => true), true)
  assert.deepEqual(
    messages.filter((m) => m.action === 'register').map((m) => m.workCount),
    [40, 51]
  )
  client.updateWorkCount(45)
  await client.permit(() => true)
  assert.equal(messages.filter((m) => m.action === 'register').length, 2)
  client.addWorkCount(1)
  await client.permit(() => true)
  assert.equal(
    messages.filter((m) => m.action === 'register').at(-1).workCount,
    52
  )
  assert.equal(new Set(messages.map((m) => m.id)).size, 1)
  client.finish()
  const count = permits
  assert.equal(await client.permit(() => true), false)
  assert.equal(permits, count)
})

test('paced FIFO survives repeated fixed-order polling and storage reloads', () => {
  let s = state()
  for (const [i, id] of ['a', 'b', 'c'].entries())
    policy.registerCrawl(s, id, '123', i, 51, 0)
  s.nextAt['123'] = 1800
  for (const id of ['a', 'b', 'c'])
    assert.equal(policy.permitCrawl(s, id, 0).granted, false)
  const grants = []
  // Every round polls a first: fairness must come from the queue, not call order.
  for (let round = 0; round < 9; round++) {
    const now = (round + 1) * 1800
    for (const id of ['a', 'b', 'c']) {
      if (policy.permitCrawl(s, id, now).granted) grants.push(id)
      policy.permitCrawl(s, id, now + 1)
    }
    s = policy.readCrawlRateState(JSON.parse(JSON.stringify(s)), now + 1)
  }
  assert.deepEqual(grants, ['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c'])
})

test('queue migration validates, deduplicates and removes dead waiters', () => {
  const s = state()
  for (const [i, id] of ['a', 'b', 'c'].entries())
    policy.registerCrawl(s, id, '123', i, 51, 0)
  s.waiting = { 123: ['a', 'a', 'missing', 'b', 'c'], 456: ['b'] }
  const restored = policy.readCrawlRateState(s, 0)
  assert.deepEqual(Array.from(restored.waiting['123']), ['a', 'b', 'c'])
  assert.equal(restored.waiting['456'], undefined)
  policy.finishCrawl(restored, 'a')
  assert.deepEqual(Array.from(restored.waiting['123']), ['b', 'c'])
  restored.sessions.b.expiresAt = 1
  policy.expireCrawls(restored, 1)
  assert.deepEqual(Array.from(restored.waiting['123']), ['c'])
  assert.equal(policy.permitCrawl(restored, 'c', 1).granted, true)
  for (const waiting of [null, [], { 123: 'a' }, { 123: [1] }])
    assert.throws(() => policy.readCrawlRateState({ ...state(), waiting }, 0))
  const legacy = state()
  delete legacy.waiting
  assert.deepEqual(
    Object.keys(policy.readCrawlRateState(legacy, 0).waiting),
    []
  )
})

test('empty crawl immediately finishes session and removes all finish listeners', () => {
  const source = fs.readFileSync('src/ts/crawl/InitPageBase.ts', 'utf8')
  const block = source.slice(
    source.indexOf('    const finish = () => {'),
    source.indexOf('\n  }', source.indexOf('    const finish = () => {'))
  )
  const events = new EventTarget()
  const s = state()
  policy.registerCrawl(s, 'empty', '123', 1, 51, 0)
  policy.permitCrawl(s, 'empty', 0)
  policy.permitCrawl(s, 'empty', 1)
  let finished = 0
  vm.runInNewContext(block, {
    window: events,
    EVT: {
      list: {
        stopCrawl: 'stop',
        crawlComplete: 'complete',
        crawlEmpty: 'empty',
        crawlStart: 'start',
      },
    },
    client: {
      finish() {
        finished++
        policy.finishCrawl(s, 'empty')
      },
    },
  })
  events.dispatchEvent(new Event('empty'))
  assert.equal(s.sessions.empty, undefined)
  assert.equal(s.waiting['123'], undefined)
  for (const event of ['empty', 'stop', 'complete', 'start', 'pagehide'])
    events.dispatchEvent(new Event(event))
  assert.equal(finished, 1)
  assert.equal(s.nextAt['123'], 1800)
})

test('reconnect registration paces all live same-account sessions', () => {
  const s = state()
  policy.registerCrawl(s, 'a', '123', 1, 40, 0)
  policy.registerCrawl(s, 'b', '123', 2, 40, 0)
  policy.registerCrawl(s, 'other', '456', 3, 40, 0)
  // 模拟重启后恢复的旧版本快速会话。
  s.sessions.a.paced = false
  s.sessions.b.paced = false
  policy.registerCrawl(s, 'a', '123', 1, 40, 1)
  assert.equal(s.sessions.a.paced, true)
  assert.equal(s.sessions.b.paced, true)
  assert.equal(s.sessions.other.paced, false)
})

test('direct metadata worker entry creates one rate session before imported workers', () => {
  const generation = {}
  const store = {
    loggedUserID: '123',
    idList: Array.from({ length: 51 }, (_, i) => ({
      id: `${i}`,
      type: 'illusts',
    })),
  }
  const clients = []
  const workers = []
  let managed = { generation, operationId: 'managed-operation' }
  const events = new EventTarget()
  events.setTimeout = (worker) => {
    assert.equal(clients.length, 1)
    workers.push(worker)
  }
  const { InitPageBase } = load(
    'src/ts/crawl/InitPageBase.ts',
    {
      './CrawlRateClient': {
        CrawlRateClient: class {
          constructor(...args) {
            this.args = args
            this.finished = 0
            clients.push(this)
          }
          updateWorkCount() {}
          finish() {
            this.finished++
          }
        },
      },
      './CrawlGeneration': { ownsCrawl: (value) => value === generation },
      '../download/ManagedCrawlAutomation': { getManagedCrawl: () => managed },
      '../store/Store': { store },
      '../store/States': { states: { stopCrawl: false } },
      '../Tools': { Tools: {} },
      '../Language': { lang: { transl: () => '' } },
      '../Log': { log: { log() {}, warning() {} } },
      '../EVT': {
        EVT: {
          list: {
            stopCrawl: 'stop',
            crawlComplete: 'complete',
            crawlEmpty: 'empty',
            crawlStart: 'start',
          },
        },
      },
    },
    { window: events, crypto: { randomUUID: () => 'unique' } }
  )
  const page = new InitPageBase()
  page.generation = generation
  page.idListLength = 999 // 上一代的数量不能用于导入列表。
  page.getWorksData = () => {
    assert.equal(page.rateSession.client, clients[0])
    store.idList.shift()
  }
  page.startGetWorksData()
  assert.equal(clients[0].args[0], 'managed-operation:unique')
  assert.equal(clients[0].args[1], '123')
  assert.equal(clients[0].args[2], 51)
  assert.equal(page.idListLength, 51)
  workers.forEach((worker) => worker())
  page.startGetWorksData()
  assert.equal(clients.length, 1)
  assert.equal(page.idListLength, 51)
  events.dispatchEvent(new Event('empty'))
  assert.equal(clients[0].finished, 1)
  events.dispatchEvent(new Event('stop'))
  assert.equal(clients[0].finished, 1)

  const manual = new InitPageBase()
  manual.generation = generation
  managed = { generation: {}, operationId: 'stale-operation' }
  manual.ensureRateSession(generation, 75)
  assert.equal(clients[1].args[0], 'manual:unique')
  manual.startGetWorksData = InitPageBase.prototype.startGetWorksData
  events.setTimeout = () => {}
  manual.startGetWorksData()
  assert.equal(clients.length, 2)
  assert.equal(clients[1].args[2], 75)
})
