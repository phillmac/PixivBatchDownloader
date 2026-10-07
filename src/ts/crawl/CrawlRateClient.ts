import browser from 'webextension-polyfill'
import {
  CRAWL_RATE_PORT,
  CrawlRateSnapshot,
  FAST_TO_PACED_THRESHOLD,
  PACED_INTERVAL_MS,
} from './CrawlRatePolicy'
import { Utils } from '../utils/Utils'

/** Worker 返回的许可或失败。 */
interface RateReply {
  snapshot?: CrawlRateSnapshot
  granted?: boolean
  retryAfterMs?: number
  error?: string
}
/** 嵌套元数据生产者共用父抓取的许可和取消检查。 */
export interface CrawlMetadataPermit {
  /** 申请一次元数据请求许可。 */
  acquire: () => Promise<boolean>
  /** 系列展开后累加父会话预算，不替换会话身份。 */
  addWorkCount?: (delta: number) => void
  /** 检查父任务是否仍然有效。 */
  valid: () => boolean
}
/** 当前标签页存活的客户端；身份仅用于本地匹配。 */
const clients = new Set<CrawlRateClient>()
/** 优先匹配托管身份或手动主抓取，维护任务只作为独立任务回退。 */
export async function getCrawlRateTelemetry(operationId?: string) {
  const active = [...clients]
  const primary = operationId
    ? active.find((client) => client.matchesMain(operationId))
    : active.find((client) => client.matchesMain('manual'))
  const selected =
    primary ||
    active.find((client) => client.matchesMain('manual')) ||
    active.find((client) => client.isMain()) ||
    active[0]
  return selected?.telemetry() ?? null
}
/** 捕获单次抓取身份，等待期间始终检查代数所有权。 */
export class CrawlRateClient {
  /** 终态不可再次注册或请求许可。 */
  private closed = false
  /** 本地许可计时聚合，不保留逐请求记录。 */
  private permits = 0
  /** 至少等待或重试一次的成功许可数。 */
  private waitedPermits = 0
  /** 成功许可累计等待毫秒数。 */
  private totalPermitWaitMs = 0
  /** 最大成功许可等待时间。 */
  private maxPermitWaitMs = 0
  /** 主抓取身份匹配，不对外公开随机 ID。 */
  public matchesMain(prefix: string) {
    return this.isMain() && this.id.startsWith(`${prefix}:`)
  }
  /** 主抓取角色由入口显式声明。 */
  public isMain() {
    return this.kind === 'main'
  }
  /** 最近一次权威快照；失败回退不推断账号并发或模式。 */
  private lastSnapshot?: CrawlRateSnapshot
  /** 查询失败不影响自动化状态或许可流程。 */
  public async telemetry() {
    if (this.closed) return null
    let coordinatorAvailable = false
    try {
      let registration
      do {
        registration = this.registered
        await registration
      } while (registration !== this.registered)
      const reply = await this.send('status')
      if (!reply.snapshot) throw new Error('Missing crawl rate snapshot')
      this.lastSnapshot = reply.snapshot
      coordinatorAvailable = true
    } catch {
      // 仅复用此前后台返回的字段，绝不从本地客户端数量推断账号状态。
    }
    if (this.closed || !this.lastSnapshot) return null
    const { policy, ...counts } = this.lastSnapshot
    return {
      coordinatorAvailable,
      policy: { ...policy },
      runtime: {
        permits: this.permits,
        waitedPermits: this.waitedPermits,
        maxPermitWaitMs: this.maxPermitWaitMs,
        meanPermitWaitMs: this.permits
          ? this.totalPermitWaitMs / this.permits
          : 0,
        ...counts,
      },
    }
  }
  /** 已登记的最高作品数量，后续只能提升。 */
  private workCount: number
  /** 同一会话的初始注册。 */
  private registered: Promise<RateReply>
  /** 创建手动或托管会话；身份包含随机值，不能以 URL 代替。 */
  constructor(
    private readonly id: string,
    private readonly account: string,
    workCount: number,
    private readonly kind: 'main' | 'maintenance' = 'maintenance'
  ) {
    clients.add(this)
    this.workCount = Math.max(1, workCount)
    this.registered = this.send('register', {
      workCount: this.workCount,
      account,
    })
    // 首次使用时处理失败，避免未消费的拒绝。
    void this.registered.catch(() => undefined)
  }
  /** 专用 port 避免与下载消息监听器竞争响应。 */
  private send(
    action: string,
    data: Record<string, unknown> = {}
  ): Promise<RateReply> {
    const port = browser.runtime.connect({ name: CRAWL_RATE_PORT })
    const request = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        port.disconnect()
        reject(new Error('Crawl coordinator timed out'))
      }, 10000)
      port.onMessage.addListener((value: unknown) => {
        const reply = value as RateReply & { request: string }
        if (settled || reply.request !== request) return
        settled = true
        clearTimeout(timeout)
        port.disconnect()
        if (reply.error) reject(new Error(reply.error))
        else resolve(reply)
      })
      port.onDisconnect.addListener(() => {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          reject(new Error('Crawl coordinator disconnected'))
        }
      })
      port.postMessage({ ...data, action, id: this.id, request })
    })
  }
  /** 在原身份上串行更新数量，许可必须等待提升完成。 */
  public updateWorkCount(workCount: number) {
    if (this.closed || workCount <= this.workCount) return
    this.workCount = workCount
    this.registered = this.registered.then(() => {
      if (this.closed) return {}
      return this.send('register', {
        account: this.account,
        workCount: this.workCount,
      })
    })
    void this.registered.catch(() => undefined)
  }
  /** 为嵌套生产者累加预算，复用原身份的串行登记。 */
  public addWorkCount(delta: number) {
    if (!Number.isFinite(delta) || delta <= 0) return
    this.updateWorkCount(this.workCount + Math.ceil(delta))
  }
  /** 等待实际许可；失去所有权后不能启动元数据请求。 */
  public async permit(valid: () => boolean): Promise<boolean> {
    if (this.closed || !valid()) return false
    const enteredAt = performance.now()
    let waited = false
    while (!this.closed && valid()) {
      try {
        let registration
        do {
          registration = this.registered
          await registration
        } while (registration !== this.registered)
        if (this.closed || !valid()) return false
        const reply = await this.send('permit')
        if (this.closed || !valid()) return false
        if (reply.granted) {
          const waitMs = Math.max(0, performance.now() - enteredAt)
          this.permits++
          if (waited) this.waitedPermits++
          this.totalPermitWaitMs += waitMs
          this.maxPermitWaitMs = Math.max(this.maxPermitWaitMs, waitMs)
          return true
        }
        waited = true
        await Utils.sleep(
          Math.max(100, reply.retryAfterMs || PACED_INTERVAL_MS)
        )
      } catch {
        waited = true
        if (this.closed || !valid()) return false
        // 过期或 worker/存储故障后保守重登记，不能恢复快速额度。
        await Utils.sleep(PACED_INTERVAL_MS)
        if (this.closed || !valid()) return false
        this.workCount = Math.max(this.workCount, FAST_TO_PACED_THRESHOLD + 1)
        this.registered = this.send('register', {
          account: this.account,
          workCount: this.workCount,
        })
        void this.registered.catch(() => undefined)
      }
    }
    return false
  }
  /** 立即封锁本地会话，再尽力清理后台；失败时残留状态只会减速。 */
  public finish() {
    if (this.closed) return
    this.closed = true
    clients.delete(this)
    void this.registered
      .then(() => this.send('finish'))
      .catch((error) =>
        console.warn('Failed to finish crawl rate session', error)
      )
  }
}
