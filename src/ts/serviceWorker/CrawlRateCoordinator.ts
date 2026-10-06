import browser from 'webextension-polyfill'
import {
  CRAWL_RATE_PORT,
  CrawlRateState,
  registerCrawl,
  finishCrawl,
  permitCrawl,
  UNKNOWN_ACCOUNT,
  readCrawlRateState,
} from '../crawl/CrawlRatePolicy'

/** 仅 PPBD 使用的持久化键。 */
const storageKey = 'ppbdCrawlRateV1'
/** 全部读改写操作共用串行锁，许可返回前必须持久化成功。 */
let queue: Promise<unknown> = Promise.resolve()
/** session 不可用时退回 local；每次操作重新读取，避免失败污染缓存。 */
let storage = browser.storage.session || browser.storage.local
/** 执行可恢复的存储操作。 */
async function useStorage<T>(
  op: (area: browser.Storage.StorageArea) => Promise<T>
) {
  try {
    return await op(storage)
  } catch (error) {
    if (storage === browser.storage.local) throw error
    storage = browser.storage.local
    return op(storage)
  }
}
/** 读取状态并串行持久化；存储失败绝不授予许可。 */
function mutate<T>(op: (state: CrawlRateState) => T): Promise<T> {
  const result = queue.then(async () => {
    // local 镜像作为恢复基准，防止重启后 session 再次可用而遗漏旧 fallback 屏障。
    const localData = await browser.storage.local.get(storageKey)
    const sessionData = await useStorage((area) => area.get(storageKey))
    const data = localData[storageKey] !== undefined ? localData : sessionData
    const state = readCrawlRateState(data[storageKey], Date.now())
    const reply = op(state)
    await browser.storage.local.set({ [storageKey]: state })
    await useStorage((area) => area.set({ [storageKey]: state }))
    return reply
  })
  queue = result.catch(() => undefined)
  return result
}
/** 导航/关闭撤销旧标签页全部会话；保留账号时间屏障。 */
function removeTab(tabId: number) {
  void mutate((state) => {
    for (const [id, session] of Object.entries(state.sessions)) {
      if (session.tabId === tabId) finishCrawl(state, id)
    }
  }).catch(console.warn)
}
browser.tabs.onRemoved.addListener(removeTab)
browser.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' || change.discarded) removeTab(tabId)
})
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== CRAWL_RATE_PORT) return
  const tabId = port.sender?.tab?.id
  if (tabId === undefined) return port.disconnect()
  let connected = true
  port.onDisconnect.addListener(() => {
    connected = false
  })
  port.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== 'object') return
    const msg = message as Record<string, unknown>
    if (
      typeof msg.id !== 'string' ||
      !msg.id ||
      typeof msg.request !== 'string'
    )
      return
    const id = msg.id
    const result = mutate((state) => {
      if (!connected) throw new Error('Crawl document disconnected')
      if (msg.action === 'register') {
        if (
          typeof msg.workCount !== 'number' ||
          !Number.isFinite(msg.workCount) ||
          msg.workCount < 1
        )
          throw new Error('Invalid work count')
        const account =
          typeof msg.account === 'string' && /^\d+$/.test(msg.account)
            ? msg.account
            : UNKNOWN_ACCOUNT
        registerCrawl(state, id, account, tabId, msg.workCount, Date.now())
        return { granted: true }
      }
      if (state.sessions[id]?.tabId !== tabId)
        throw new Error('Crawl session ownership lost')
      if (msg.action === 'finish') {
        finishCrawl(state, id)
        return { granted: true }
      }
      if (msg.action !== 'permit') throw new Error('Unknown crawl action')
      return permitCrawl(state, id, Date.now())
    })
    void result.then(
      (reply) => {
        if (connected) port.postMessage({ ...reply, request: msg.request })
      },
      () => {
        if (connected)
          port.postMessage({
            error: 'Crawl coordinator unavailable',
            request: msg.request,
          })
      }
    )
  })
})
