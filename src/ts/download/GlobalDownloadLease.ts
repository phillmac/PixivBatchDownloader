import browser from 'webextension-polyfill'
import { Utils } from '../utils/Utils'
const globalDownloadLeaseMsg = {
  acquire: 'global_download_lease_acquire',
  renew: 'global_download_lease_renew',
  release: 'global_download_lease_release',
} as const
const globalDownloadLeasePortName = 'global-download-lease'

interface GlobalDownloadLeaseMessage {
  msg: (typeof globalDownloadLeaseMsg)[keyof typeof globalDownloadLeaseMsg]
  requestId: string
  fileId?: string
  leaseId?: string
}

interface GlobalDownloadLeaseReply {
  granted: boolean
  leaseId?: string
  retryAfterMs?: number
}

const renewIntervalMs = 10000
const defaultRetryAfterMs = 500

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

class GlobalDownloadLeaseLostError extends Error {
  constructor() {
    super('Global download lease lost')
    this.name = 'GlobalDownloadLeaseLostError'
  }
}

class GlobalDownloadLease {
  private released = false
  private lastRenewAt = Date.now()

  private constructor(
    private readonly requestId: string,
    private readonly leaseId: string
  ) {}

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
      // The stored lease expires, so a failed best-effort release must not
      // turn a successfully fetched file into a download failure.
      console.warn('Failed to release global download lease', error)
    }
  }
}

export { GlobalDownloadLease, GlobalDownloadLeaseLostError }
