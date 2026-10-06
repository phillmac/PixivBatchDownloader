import browser from 'webextension-polyfill'
import {
  CRAWL_RATE_PORT,
  FAST_TO_PACED_THRESHOLD,
  PACED_INTERVAL_MS,
} from './CrawlRatePolicy'
import { Utils } from '../utils/Utils'

/** Worker 返回的许可或失败。 */
interface RateReply {
  granted?: boolean
  retryAfterMs?: number
  error?: string
}
/** 捕获单次抓取身份，等待期间始终检查代数所有权。 */
export class CrawlRateClient {
  /** 终态不可再次注册或请求许可。 */
  private closed = false
  /** 同一会话的初始注册。 */
  private registered: Promise<RateReply>
  /** 创建手动或托管会话；身份包含随机值，不能以 URL 代替。 */
  constructor(
    private readonly id: string,
    private readonly account: string,
    workCount: number
  ) {
    this.registered = this.send('register', { workCount, account })
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
  /** 等待实际许可；失去所有权后不能启动元数据请求。 */
  public async permit(valid: () => boolean): Promise<boolean> {
    if (this.closed || !valid()) return false
    while (!this.closed && valid()) {
      try {
        await this.registered
        if (this.closed || !valid()) return false
        const reply = await this.send('permit')
        if (this.closed || !valid()) return false
        if (reply.granted) return true
        await Utils.sleep(
          Math.max(100, reply.retryAfterMs || PACED_INTERVAL_MS)
        )
      } catch {
        if (this.closed || !valid()) return false
        // 过期或 worker/存储故障后保守重登记，不能恢复快速额度。
        await Utils.sleep(PACED_INTERVAL_MS)
        if (this.closed || !valid()) return false
        this.registered = this.send('register', {
          account: this.account,
          workCount: FAST_TO_PACED_THRESHOLD + 1,
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
    void this.registered
      .then(() => this.send('finish'))
      .catch((error) =>
        console.warn('Failed to finish crawl rate session', error)
      )
  }
}
