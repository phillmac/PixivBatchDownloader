/** 快速抓取预算；与 v1 的模式切换阈值保持独立。 */
export const FAST_ALLOWANCE_WORKS = 100
/** v1 单次抓取超过此数量时立即采用限速模式。 */
export const FAST_TO_PACED_THRESHOLD = 50
/** 同一账号的限速作品请求启动间隔。 */
export const PACED_INTERVAL_MS = 1800
/** 长时间未注册或申请许可的会话失效；保留账号屏障。 */
export const SESSION_TTL_MS = 5 * 60 * 1000
/** PPBD 元数据限速专用端口。 */
export const CRAWL_RATE_PORT = 'ppbd-crawl-rate'
/** 无法识别登录账号时仍共用稳定作用域。 */
export const UNKNOWN_ACCOUNT = 'unknown-account'
/** 一次真实抓取的持久化记录。 */
export interface CrawlRateSession {
  account: string
  tabId: number
  paced: boolean
  started: number
  expiresAt: number
}
/** Worker 重启后仍保留会话和最近一次许可时间。 */
export interface CrawlRateState {
  /** 每个账号按首次等待顺序排列的限速会话。 */
  waiting: Record<string, string[]>
  sessions: Record<string, CrawlRateSession>
  nextAt: Record<string, number>
  /** 包含快速模式的最近开始时间，供并发切换时衔接。 */
  lastAt: Record<string, number>
}
/** 在持有 worker 串行锁时注册；重连不能重置预算或模式。 */
export function registerCrawl(
  state: CrawlRateState,
  id: string,
  account: string,
  tabId: number,
  workCount: number,
  now = Date.now()
) {
  expireCrawls(state, now)
  if (state.sessions[id]) {
    const existing = state.sessions[id]
    if (existing.account !== account || existing.tabId !== tabId)
      throw new Error('Crawl session ownership mismatch')
    existing.paced ||= workCount > FAST_TO_PACED_THRESHOLD
    existing.expiresAt = now + SESSION_TTL_MS
    return
  }
  state.sessions[id] = {
    account,
    tabId,
    paced:
      workCount > FAST_TO_PACED_THRESHOLD ||
      (state.nextAt[account] || 0) > now ||
      Object.values(state.sessions).some((s) => s.account === account),
    started: 0,
    expiresAt: now + SESSION_TTL_MS,
  }
}
/** 不预订未来许可；实际授予时持久化下一次最早启动时间。 */
export function permitCrawl(state: CrawlRateState, id: string, now: number) {
  expireCrawls(state, now)
  const session = state.sessions[id]
  if (!session) throw new Error('Crawl session no longer active')
  session.expiresAt = now + SESSION_TTL_MS
  if (session.started >= FAST_ALLOWANCE_WORKS) session.paced = true
  const next = Math.max(
    state.nextAt[session.account] || 0,
    (state.lastAt[session.account] ?? -PACED_INTERVAL_MS) + PACED_INTERVAL_MS
  )
  if (session.paced) {
    const waiting = (state.waiting[session.account] ||= [])
    if (!waiting.includes(id)) waiting.push(id)
    if (next > now || waiting[0] !== id)
      return { granted: false, retryAfterMs: Math.max(0, next - now) }
    waiting.shift()
    if (!waiting.length) delete state.waiting[session.account]
  }
  session.started++
  state.lastAt[session.account] = now
  state.nextAt[session.account] = now + PACED_INTERVAL_MS
  return { granted: true, retryAfterMs: 0 }
}

/** 完成或关闭标签页时撤销会话和等待位置，保留账号屏障。 */
export function finishCrawl(state: CrawlRateState, id: string) {
  delete state.sessions[id]
  pruneWaiting(state)
}
/** 清除已撤销、跨账号或非限速会话，保持存活会话的顺序。 */
function pruneWaiting(state: CrawlRateState) {
  for (const [account, ids] of Object.entries(state.waiting)) {
    const live = ids.filter(
      (id) =>
        state.sessions[id]?.account === account && state.sessions[id].paced
    )
    if (live.length) state.waiting[account] = live
    else delete state.waiting[account]
  }
}
/** 过期仅撤销会话，不能删除最近许可留下的账号屏障。 */
export function expireCrawls(state: CrawlRateState, now: number) {
  for (const [id, session] of Object.entries(state.sessions)) {
    if (session.expiresAt <= now) delete state.sessions[id]
  }
  pruneWaiting(state)
}
/** 检查持久化对象，拒绝损坏状态以免绕过账号屏障。 */
export function readCrawlRateState(
  value: unknown,
  now: number
): CrawlRateState {
  if (value === undefined)
    return { sessions: {}, nextAt: {}, lastAt: {}, waiting: {} }
  if (!isRecord(value) || !isRecord(value.sessions))
    throw new Error('Invalid crawl rate state')
  const nextAt = readTimes(value.nextAt)
  // 旧版本没有 lastAt 时从已持久化的 nextAt 恢复。
  const lastAt = value.lastAt === undefined ? {} : readTimes(value.lastAt)
  const sessions: Record<string, CrawlRateSession> = Object.create(null)
  for (const [id, entry] of Object.entries(value.sessions)) {
    if (
      !isRecord(entry) ||
      typeof entry.account !== 'string' ||
      !Number.isInteger(entry.tabId) ||
      typeof entry.tabId !== 'number' ||
      typeof entry.paced !== 'boolean' ||
      typeof entry.started !== 'number' ||
      !Number.isSafeInteger(entry.started) ||
      entry.started < 0 ||
      (entry.expiresAt !== undefined &&
        (typeof entry.expiresAt !== 'number' ||
          !Number.isFinite(entry.expiresAt)))
    )
      throw new Error('Invalid crawl rate session')
    sessions[id] = {
      account: entry.account,
      tabId: entry.tabId,
      paced: entry.paced,
      started: entry.started,
      expiresAt:
        typeof entry.expiresAt === 'number'
          ? entry.expiresAt
          : now + SESSION_TTL_MS,
    }
  }
  // 旧状态尚无队列；损坏的队列必须拒绝，不能跳过等待者。
  const waiting: Record<string, string[]> = Object.create(null)
  if (value.waiting !== undefined) {
    if (!isRecord(value.waiting)) throw new Error('Invalid crawl rate queue')
    for (const [account, ids] of Object.entries(value.waiting)) {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
        throw new Error('Invalid crawl rate queue')
      waiting[account] = [...new Set(ids)]
    }
  }
  const state = { sessions, nextAt, lastAt, waiting }
  expireCrawls(state, now)
  return state
}
/** unknown 对象缩窄后才能读取字段。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
/** 复制时间屏障并验证所有值。 */
function readTimes(value: unknown): Record<string, number> {
  if (!isRecord(value)) throw new Error('Invalid crawl rate timestamps')
  const result: Record<string, number> = Object.create(null)
  for (const [account, time] of Object.entries(value)) {
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0)
      throw new Error('Invalid crawl rate timestamp')
    result[account] = time
  }
  return result
}
