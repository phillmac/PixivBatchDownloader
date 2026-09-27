import browser from 'webextension-polyfill'
import { Utils } from '../utils/Utils'

/** 全局下载租约协议使用的消息名称。 */
const globalDownloadLeaseMsg = {
  acquire: 'global_download_lease_acquire',
  renew: 'global_download_lease_renew',
  release: 'global_download_lease_release',
} as const

/** 全局下载租约专用的 runtime port 名称。 */
const globalDownloadLeasePortName = 'global-download-lease'

/** 向 Service Worker 发送的全局下载租约消息。 */
interface GlobalDownloadLeaseMessage {
  msg: (typeof globalDownloadLeaseMsg)[keyof typeof globalDownloadLeaseMsg]
  requestId: string
  fileId?: string
  leaseId?: string
}

/** Service Worker 对全局下载租约请求的响应。 */
interface GlobalDownloadLeaseReply {
  granted: boolean
  leaseId?: string
  retryAfterMs?: number
}

/** 读取受全局租约保护的响应体之后返回的数据。 */
interface GlobalDownloadBodyResult<T extends Blob | ArrayBuffer> {
  response: Response
  data: T | null
}

/** 全局下载租约的续租间隔。只有读取到响应体进度时才会调用续租。 */
const renewIntervalMs = 10000

/** 租约被其他标签页占用时的默认重试间隔。 */
const defaultRetryAfterMs = 500

/** 通过专用 port 发送一次租约请求，避免和现有 onMessage 监听器竞争响应。 */
function sendGlobalDownloadLeaseMessage(
  message: GlobalDownloadLeaseMessage
): Promise<GlobalDownloadLeaseReply> {
  const port = browser.runtime.connect({ name: globalDownloadLeasePortName })

  return new Promise((resolve, reject) => {
    let settled = false

    port.onMessage.addListener((reply: unknown) => {
      if (settled) return
      settled = true
      resolve(reply as GlobalDownloadLeaseReply)
      port.disconnect()
    })

    port.onDisconnect.addListener(() => {
      if (settled) return
      settled = true
      reject(new Error('Global download lease port disconnected before reply'))
    })

    port.postMessage(message)
  })
}

/** 当前下载已经失去全局租约时抛出的错误。 */
class GlobalDownloadLeaseLostError extends Error {
  /** 创建租约失效错误。 */
  constructor() {
    super('Global download lease lost')
    this.name = 'GlobalDownloadLeaseLostError'
  }
}

/** 表示一个跨标签页互斥的媒体下载租约。 */
class GlobalDownloadLease {
  /** 标记这个租约是否已经释放。 */
  private released = false

  /** 最近一次成功续租的时间。 */
  private lastRenewAt = Date.now()

  /** 只能通过 acquire() 创建租约实例。 */
  private constructor(
    private readonly requestId: string,
    private readonly leaseId: string
  ) {}

  /** 等待并获取一个全局下载租约；取消等待时返回 null。 */
  public static async acquire(
    fileId: string,
    cancelled: () => boolean
  ): Promise<GlobalDownloadLease | null> {
    const requestId = crypto.randomUUID()

    while (!cancelled()) {
      const reply = await sendGlobalDownloadLeaseMessage({
        msg: globalDownloadLeaseMsg.acquire,
        requestId,
        fileId,
      })

      if (reply?.granted && reply.leaseId) {
        const lease = new GlobalDownloadLease(requestId, reply.leaseId)
        if (cancelled()) {
          await lease.release()
          return null
        }
        return lease
      }

      const retryAfterMs = Math.max(
        100,
        Math.min(reply?.retryAfterMs || defaultRetryAfterMs, 1000)
      )
      await Utils.sleep(retryAfterMs)
    }

    return null
  }

  /** 在响应体确实取得进度后续租；force 用于 EOF 的 fencing 检查。 */
  public async renew(force = false): Promise<void> {
    if (this.released) {
      throw new GlobalDownloadLeaseLostError()
    }

    if (!force && Date.now() - this.lastRenewAt < renewIntervalMs) {
      return
    }

    const reply = await sendGlobalDownloadLeaseMessage({
      msg: globalDownloadLeaseMsg.renew,
      requestId: this.requestId,
      leaseId: this.leaseId,
    })

    if (!reply?.granted) {
      throw new GlobalDownloadLeaseLostError()
    }

    this.lastRenewAt = Date.now()
  }

  /** 尽力释放租约；释放失败时让后台 TTL 最终回收它。 */
  public async release(): Promise<void> {
    if (this.released) {
      return
    }
    this.released = true

    try {
      await sendGlobalDownloadLeaseMessage({
        msg: globalDownloadLeaseMsg.release,
        requestId: this.requestId,
        leaseId: this.leaseId,
      })
    } catch (error) {
      // 释放失败时仍然有后台 TTL 兜底，不应把已经成功获取的文件变成下载失败
      console.warn('Failed to release global download lease', error)
    }
  }
}

/**
 * 在持有全局租约时下载并完整读取一个媒体响应。
 * 读取每个响应块时检查续租，确保长时间网络传输不会被其他标签页并发取代。
 */
async function fetchGlobalDownloadBody(
  url: string,
  fileId: string,
  type: 'blob',
  init?: RequestInit,
  cancelled?: () => boolean
): Promise<GlobalDownloadBodyResult<Blob> | null>
async function fetchGlobalDownloadBody(
  url: string,
  fileId: string,
  type: 'arrayBuffer',
  init?: RequestInit,
  cancelled?: () => boolean
): Promise<GlobalDownloadBodyResult<ArrayBuffer> | null>
async function fetchGlobalDownloadBody(
  url: string,
  fileId: string,
  type: 'blob' | 'arrayBuffer',
  init?: RequestInit,
  cancelled?: () => boolean
): Promise<GlobalDownloadBodyResult<Blob | ArrayBuffer> | null>
async function fetchGlobalDownloadBody(
  url: string,
  fileId: string,
  type: 'blob' | 'arrayBuffer',
  init?: RequestInit,
  cancelled: () => boolean = () => false
): Promise<GlobalDownloadBodyResult<Blob | ArrayBuffer> | null> {
  const lease = await GlobalDownloadLease.acquire(fileId, cancelled)
  if (!lease) return null

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let bodyComplete = false

  try {
    const response = await fetch(url, init)
    if (!response.ok) {
      await response.body?.cancel()
      return { response, data: null }
    }

    reader = response.body?.getReader()
    const chunks: Uint8Array[] = []

    if (reader) {
      while (true) {
        if (cancelled()) {
          await reader.cancel()
          return null
        }

        const { done, value } = await reader.read()
        await lease.renew(done)
        if (done) {
          bodyComplete = true
          break
        }
        chunks.push(value)
      }
    } else {
      await lease.renew(true)
      bodyComplete = true
    }

    const contentType =
      response.headers.get('Content-Type')?.split(';')[0].trim() ||
      'application/octet-stream'
    const blob = new Blob(chunks as BlobPart[], { type: contentType })
    const data = type === 'blob' ? blob : await blob.arrayBuffer()
    return { response, data }
  } finally {
    if (reader && !bodyComplete) {
      try {
        await reader.cancel()
      } catch (error) {
        // 取消失败不能覆盖原始下载/租约错误，租约仍然必须立即释放
        console.warn('Failed to cancel abandoned global download body', error)
      }
    }
    await lease.release()
  }
}

export {
  fetchGlobalDownloadBody,
  GlobalDownloadLease,
  GlobalDownloadLeaseLostError,
}
