import browser from 'webextension-polyfill'
import { Utils } from '../utils/Utils'
const globalDownloadLeaseMsg = {
  acquire: 'global_download_lease_acquire',
  renew: 'global_download_lease_renew',
  release: 'global_download_lease_release',
} as const

interface GlobalDownloadLeaseReply {
  granted: boolean
  leaseId?: string
  retryAfterMs?: number
}

const renewIntervalMs = 10000
const defaultRetryAfterMs = 500

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
      const reply = (await browser.runtime.sendMessage({
        msg: globalDownloadLeaseMsg.acquire,
        requestId,
        fileId,
      })) as GlobalDownloadLeaseReply | undefined

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

    const reply = (await browser.runtime.sendMessage({
      msg: globalDownloadLeaseMsg.renew,
      requestId: this.requestId,
      leaseId: this.leaseId,
    })) as GlobalDownloadLeaseReply | undefined

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
      await browser.runtime.sendMessage({
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
