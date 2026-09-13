import browser from 'webextension-polyfill'
import { EVT } from '../EVT'
import { UgoiraInfo } from '../crawl/CrawlResult'
import { APNGDiagnostics, APNGErrorInfo } from './APNGDiagnostics'

class ToAPNG {
  /** 多次转换共用的编码 worker */
  private worker!: Worker
  /** 防止并发重复加载 worker */
  private workerReady: Promise<void> | null = null
  /** worker 创建时间，用于判断多次失败是否复用了同一个实例 */
  private workerCreatedAt = ''
  /** worker 资源的加载状态 */
  private readonly workerResources: { path: string; status: number }[] = []
  /** 最近的 worker 运行错误，包括没有活动请求时发生的启动错误 */
  private workerError: APNGErrorInfo | null = null
  /** 超时不终止 worker，记录次数以便识别旧任务可能仍在运行的情况 */
  private workerTimeouts = 0
  /** 自增请求 ID，用来匹配并发转换的响应 */
  private messageId = 0
  /** 仍在等待响应的请求，不包括已经超时但可能仍在 worker 中运行的任务 */
  private readonly pendingRequests = new Set<number>()

  /** 加载扩展内的脚本，并在 pako 和 UPNG 后面拼接 worker 入口 */
  private async loadWorker(): Promise<void> {
    const scripts = await Promise.all(
      ['lib/pako.min.js', 'lib/UPNG.js', 'lib/apng.worker.js'].map(
        async (path) => {
          const response = await fetch(browser.runtime.getURL(path))
          this.workerResources.push({ path, status: response.status })
          if (!response.ok) {
            throw new Error(
              `APNG worker resource ${path}: HTTP ${response.status}`
            )
          }
          return response.text()
        }
      )
    )
    const blob = new Blob([scripts.join('\n')], {
      type: 'application/javascript',
    })
    const url = URL.createObjectURL(blob)
    try {
      this.worker = new Worker(url)
      this.workerCreatedAt = new Date().toISOString()
    } finally {
      URL.revokeObjectURL(url)
    }
    this.worker.onerror = (ev) => {
      this.workerError = {
        name: 'WorkerError',
        message: ev.message || 'APNG worker error (no message supplied)',
        stack: `${ev.filename}:${ev.lineno}:${ev.colno}`,
      }
      console.error('[PPD APNG worker error]', this.workerError, ev)
    }
  }

  /** 提取 RGBA 像素，并把每次失败前的阶段和帧信息保存在诊断里 */
  public async convert(
    imageBitmapList: ImageBitmap[],
    info: UgoiraInfo,
    diagnostic: APNGDiagnostics
  ): Promise<Blob> {
    diagnostic.enter('load-worker')
    if (!this.workerReady) {
      this.workerReady = this.loadWorker()
    }
    try {
      await this.workerReady
    } finally {
      diagnostic.details.workerResources = this.workerResources.slice()
      diagnostic.details.workerCreatedAt = this.workerCreatedAt
      diagnostic.details.previousWorkerError = this.workerError
    }

    diagnostic.enter('read-frame-pixels')
    diagnostic.details.bitmapCount = imageBitmapList.length
    if (imageBitmapList.length === 0) {
      throw new Error('No decoded frames available for APNG conversion')
    }
    const width = imageBitmapList[0].width
    const height = imageBitmapList[0].height
    diagnostic.details.width = width
    diagnostic.details.height = height
    // 仅为输入像素体积，不是 UPNG 的峰值内存；编码时还需要额外缓冲区。
    diagnostic.details.inputRGBABytes =
      width * height * 4 * imageBitmapList.length
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      throw new Error('Could not create a 2D canvas context for APNG')
    }

    const arrayBuffList: ArrayBuffer[] = []
    imageBitmapList.forEach((imageBitmap, index) => {
      diagnostic.details.frame = {
        index,
        file: info.frames[index]?.file,
        width: imageBitmap.width,
        height: imageBitmap.height,
      }
      diagnostic.details.frameOperation = 'drawImage'
      ctx.drawImage(imageBitmap, 0, 0)
      diagnostic.details.frameOperation = 'getImageData'
      arrayBuffList.push(
        ctx.getImageData(0, 0, width, height).data.buffer as ArrayBuffer
      )
      diagnostic.details.framesRead = index + 1
    })
    const delayList = info.frames.map((frame) => frame.delay)
    diagnostic.details.delaySummary = delayList.reduce(
      (summary, delay) => ({
        minMs: Math.min(summary.minMs, delay),
        maxMs: Math.max(summary.maxMs, delay),
        totalMs: summary.totalMs + delay,
      }),
      { minMs: delayList[0] ?? 0, maxMs: 0, totalMs: 0 }
    )

    const pngFile = await this.encodeInWorker(
      arrayBuffList,
      width,
      height,
      delayList,
      diagnostic
    )
    diagnostic.enter('create-apng-blob')
    const blob = new Blob([pngFile], { type: 'image/vnd.mozilla.apng' })
    EVT.fire('convertSuccess')
    return blob
  }

  /** 记录 worker 排队、编码、消息传输及超时，并在所有退出路径移除监听器 */
  private encodeInWorker(
    arrayBuffList: ArrayBuffer[],
    width: number,
    height: number,
    delayList: number[],
    diagnostic: APNGDiagnostics
  ): Promise<ArrayBuffer> {
    const worker = this.worker
    return new Promise((resolve, reject) => {
      const id = ++this.messageId
      const timeoutMs = 120000
      this.pendingRequests.add(id)
      diagnostic.details.workerRequestId = id
      diagnostic.details.pendingWorkerRequestsAtSubmit =
        this.pendingRequests.size
      diagnostic.details.previousWorkerTimeouts = this.workerTimeouts
      diagnostic.details.workerStarted = false
      diagnostic.details.timeoutMs = timeoutMs
      let lastProgressReceived: number | null = null
      let workerStage = 'encode'

      const cleanup = () => {
        window.clearTimeout(timeoutId)
        worker.removeEventListener('message', handler)
        worker.removeEventListener('error', onError)
        worker.removeEventListener('messageerror', onMessageError)
        this.pendingRequests.delete(id)
      }
      const fail = (error: unknown) => {
        if (lastProgressReceived !== null) {
          diagnostic.details.workerLastProgressAgeMs = Math.round(
            performance.now() - lastProgressReceived
          )
        }
        diagnostic.details.pendingWorkerRequestsAtFailure =
          this.pendingRequests.size
        cleanup()
        reject(error)
      }
      const timeoutId = window.setTimeout(() => {
        this.workerTimeouts++
        diagnostic.details.lastWorkerError = this.workerError
        fail(new Error(`APNG encoding timeout after ${timeoutMs} ms`))
      }, timeoutMs)
      const handler = (ev: MessageEvent) => {
        if (!ev.data || ev.data.id !== id) return
        if (ev.data.type === 'started') {
          diagnostic.details.workerStarted = true
          diagnostic.enter('worker-encode')
          return
        }
        if (ev.data.type === 'progress') {
          lastProgressReceived = performance.now()
          diagnostic.details.workerProgress = ev.data.progress
          // 同阶段的逐帧消息只更新快照，时间线保持为少量阶段切换。
          if (ev.data.progress.stage !== workerStage) {
            workerStage = ev.data.progress.stage
            diagnostic.enter(`worker-${workerStage}`)
          }
          return
        }
        diagnostic.details.workerEncodeMs = ev.data.encodeMs
        if (ev.data.error) {
          diagnostic.details.workerStage = ev.data.stage
          if (ev.data.stage === 'post-result') {
            diagnostic.enter('worker-post-result')
          }
          // 新 worker 返回普通异常对象；也兼容旧 worker 的字符串错误。
          fail(
            typeof ev.data.error === 'string'
              ? new Error(ev.data.error)
              : ev.data.error
          )
        } else if (
          ev.data.result === undefined ||
          ev.data.result === null ||
          typeof ev.data.result.byteLength !== 'number'
        ) {
          diagnostic.enter('worker-response')
          diagnostic.details.responseType = typeof ev.data.result
          fail(new Error('Invalid APNG worker response'))
        } else {
          // Firefox 跨 realm 的 ArrayBuffer 不能通过 instanceof 检测。
          diagnostic.details.outputBytes = ev.data.result.byteLength
          cleanup()
          resolve(ev.data.result)
        }
      }
      const onError = (ev: ErrorEvent) => {
        diagnostic.enter('worker-error')
        fail({
          name: 'WorkerError',
          message: ev.message || 'APNG worker error (no message supplied)',
          stack: `${ev.filename}:${ev.lineno}:${ev.colno}`,
        })
      }
      const onMessageError = () => {
        diagnostic.enter('worker-messageerror')
        fail(new Error('Could not deserialize the APNG worker response'))
      }
      worker.addEventListener('message', handler)
      worker.addEventListener('error', onError)
      worker.addEventListener('messageerror', onMessageError)
      diagnostic.enter('worker-post-message')
      try {
        worker.postMessage(
          { id, arrayBuffList, width, height, delayList },
          arrayBuffList
        )
        diagnostic.enter('wait-worker')
      } catch (error) {
        fail(error)
      }
    })
  }
}

/** 共用的 APNG 转换器 */
const toAPNG = new ToAPNG()
export { toAPNG }
