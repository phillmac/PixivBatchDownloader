const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const { diagnosticsLoader } = require('./helpers/diagnostics-harness.cjs')

/** 加载真实关注监听器，只替换浏览器 I/O 和后台计时器。 */
async function harness() {
  const listeners = []
  const sent = []
  const stored = { following: [] }
  const browser = {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(listener) {
          listeners.push(listener)
        },
      },
    },
    storage: {
      local: {
        async get() {
          return structuredClone(stored)
        },
        async set(value) {
          Object.assign(stored, structuredClone(value))
        },
      },
    },
    tabs: {
      async sendMessage(tabId, message) {
        sent.push({ tabId, message: structuredClone(message) })
      },
      async query() {
        return [{ id: 7 }]
      },
    },
    webRequest: { onBeforeRequest: { addListener() {} } },
  }
  const context = vm.createContext({
    console,
    setInterval() {
      return 0
    },
  })
  const load = diagnosticsLoader(context, {
    'webextension-polyfill': browser,
    './backgroundAPI': { backgroundAPI: { async sleep() {} } },
  })
  load('serviceWorker/ManageFollowing.ts')
  await flush()
  assert.equal(listeners.length, 1)
  return { listener: listeners[0], listeners, sent, stored }
}

/** 排空派发函数中的短异步链，不等待或启动真实计时器。 */
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** 模拟 polyfill：只有实际返回 Promise 的监听器参与响应竞争。 */
async function dispatch(listeners, message, sender) {
  const replies = listeners
    .map((fn) => fn(message, sender))
    .filter((value) => value && typeof value.then === 'function')
  return Promise.race(replies)
}

test('unrelated and malformed messages synchronously decline without a Promise', async () => {
  const h = await harness()
  for (const message of [
    null,
    undefined,
    1,
    'text',
    {},
    { msg: 'unrelated' },
    { msg: 'get_download_worker_diagnostics' },
    { msg: 'setFollowingData', data: null },
  ]) {
    assert.equal(h.listener(message, { tab: { id: 7 } }), undefined)
  }
  assert.equal(h.sent.length, 0)
})

test('a delayed worker diagnostic response wins over the earlier following listener', async () => {
  const h = await harness()
  let release
  const storage = new Promise((resolve) => {
    release = resolve
  })
  h.listeners.push(async (message) => {
    assert.equal(message.msg, 'get_download_worker_diagnostics')
    await storage
    return { tasks: ['worker-task'], available: true }
  })
  const reply = dispatch(
    h.listeners,
    { msg: 'get_download_worker_diagnostics' },
    { tab: { id: 7 } }
  )
  await flush()
  release()
  assert.deepEqual(await reply, { tasks: ['worker-task'], available: true })
})

test('following update reservation, set, dispatch and reset retain their native behavior', async () => {
  const h = await harness()
  const request = h.listener(
    { msg: 'needUpdateFollowingData' },
    { tab: { id: 7 } }
  )
  assert.equal(typeof request.then, 'function')
  await request
  assert.deepEqual(h.sent, [
    { tabId: 7, message: { msg: 'updateFollowingData' } },
  ])
  await h.listener({ msg: 'needUpdateFollowingData' }, { tab: { id: 8 } })
  assert.equal(
    h.sent.length,
    1,
    'a second tab cannot take the active update reservation'
  )
  const data = {
    user: '1',
    following: ['2'],
    followedUsersInfo: [
      { id: '2', name: 'two', avatar: '', deleteByUser: false, exist: true },
    ],
    total: 1,
  }
  await h.listener({ msg: 'setFollowingData', data }, { tab: { id: 7 } })
  await flush()
  assert.equal(h.stored.following.length, 1)
  assert.deepEqual(h.stored.following[0].following, ['2'])
  await h.listener({ msg: 'requestFollowingData' }, { tab: { id: 8 } })
  await flush()
  assert.equal(h.sent.at(-1).tabId, 8)
  assert.equal(h.sent.at(-1).message.msg, 'dispatchFollowingData')
  await h.listener({ msg: 'resetFollowingData' }, { tab: { id: 7 } })
  await flush()
  assert.deepEqual(h.stored.following, [])
})

test('malformed following payload does not reach the asynchronous mutator', async () => {
  const h = await harness()
  for (const data of [
    {},
    { user: '1', following: 'bad', followedUsersInfo: [], total: 0 },
    { user: 1, following: [], followedUsersInfo: [], total: 0 },
  ]) {
    assert.equal(
      h.listener({ msg: 'setFollowingData', data }, { tab: { id: 7 } }),
      undefined
    )
  }
  assert.deepEqual(h.stored.following, [])
  assert.equal(h.sent.length, 0)
})
