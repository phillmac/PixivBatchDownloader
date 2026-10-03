import browser from 'webextension-polyfill'
import { EVT } from '../EVT'
import { UgoiraInfo } from '../crawl/CrawlResult'
import { Tools } from '../Tools'

declare const Whammy: any
// https://github.com/antimatter15/whammy

class ToWebM {
  private worker!: Worker
  private workerReady: Promise<void> | null = null

  constructor() {
    this.workerReady = this.loadWorkerJS()
  }

  private async loadWorkerJS(): Promise<void> {
    const [whammyRes, workerRes] = await Promise.all([
      fetch(browser.runtime.getURL('lib/whammy.js')),
      fetch(browser.runtime.getURL('lib/whammy.worker.js')),
    ])
    const [whammyText, workerText] = await Promise.all([
      whammyRes.text(),
      workerRes.text(),
    ])
    const blob = new Blob(
      ['var window = self;\n', whammyText, '\n', workerText],
      {
        type: 'application/javascript',
      }
    )
    const url = URL.createObjectURL(blob)
    this.worker = new Worker(url)
    URL.revokeObjectURL(url)
    this.worker.onerror = (ev) => {
      console.error('Whammy worker error:', ev)
    }
  }

  /**
   * Terminate a failed worker and prepare a fresh instance for the next job.
   * The identity guard prevents an old timeout from replacing a newer worker.
   */
  private resetWorker(failedWorker: Worker): void {
    if (this.worker !== failedWorker) return
    failedWorker.terminate()
    this.workerReady = this.loadWorkerJS()
  }

  /**
   * Stream a ZIP-backed Ugoira to the WebM worker one decoded bitmap at a time.
   * Each bitmap is transferred to the worker and acknowledged before the next
   * frame is decoded, so ownership never spans a complete decoded frame set.
   * Rejects inconsistent frame metadata rather than inventing frame timing.
   */
  public async convertFromZip(
    file: Blob,
    info: UgoiraInfo,
    onStart?: (details: {
      frameCount: number
      width: number
      height: number
      inputRGBABytes: number
    }) => void
  ): Promise<Blob> {
    if (
      typeof Worker === 'undefined' ||
      typeof OffscreenCanvas === 'undefined'
    ) {
      const zipFileBuffer = await file.arrayBuffer()
      const indexList = Tools.getJPGContentIndex(zipFileBuffer)
      const imageBitmapList = await Tools.extractImage(
        zipFileBuffer,
        indexList,
        'ImageBitmap'
      )
      return this.convert(imageBitmapList, info)
    }

    await this.workerReady
    const worker = this.worker
    const zipFileBuffer = await file.arrayBuffer()
    const indexList = Tools.getJPGContentIndex(zipFileBuffer)
    if (indexList.length === 0) {
      throw new Error('No Ugoira frames found for WebM conversion')
    }
    if (info.frames.length !== indexList.length) {
      throw new Error(
        `WebM frame metadata count mismatch: ZIP has ${indexList.length} frames, metadata has ${info.frames.length}`
      )
    }
    const frameDelays = info.frames.map((frame, index) => {
      if (!Number.isFinite(frame.delay)) {
        throw new Error(`Invalid WebM frame delay at index ${index}`)
      }
      return frame.delay
    })

    const id = Date.now() + Math.random()
    let firstBitmap: ImageBitmap | null = await createImageBitmap(
      Tools.extractImageFrameBlob(zipFileBuffer, indexList, 0)
    )
    const width = firstBitmap.width
    const height = firstBitmap.height
    let workerJobStarted = false

    onStart?.({
      frameCount: indexList.length,
      width,
      height,
      inputRGBABytes: width * height * 4 * indexList.length,
    })

    try {
      await this.postAndWait(
        worker,
        id,
        {
          type: 'start',
          frameCount: indexList.length,
          width,
          height,
          quality: 0.9,
        },
        [],
        'ready'
      )
      workerJobStarted = true

      for (let index = 0; index < indexList.length; index++) {
        const bitmap =
          index === 0
            ? firstBitmap!
            : await createImageBitmap(
                Tools.extractImageFrameBlob(zipFileBuffer, indexList, index)
              )
        if (index === 0) {
          firstBitmap = null
        }
        await this.postAndWait(
          worker,
          id,
          {
            type: 'frame',
            index,
            bitmap,
            delay: frameDelays[index],
          },
          [bitmap],
          'frame-complete'
        )
      }

      const response = await this.postAndWait(
        worker,
        id,
        { type: 'finish' },
        [],
        'result'
      )
      workerJobStarted = false
      if (!response.result || typeof response.result.size !== 'number') {
        throw new Error('Invalid Whammy worker response')
      }
      EVT.fire('convertSuccess')
      return response.result
    } catch (error) {
      if (workerJobStarted && this.worker === worker) {
        try {
          worker.postMessage({ id, type: 'cancel' })
        } catch {}
      }
      throw error
    } finally {
      firstBitmap?.close()
    }
  }

  public async convert(
    ImageBitmapList: ImageBitmap[],
    info: UgoiraInfo
  ): Promise<Blob> {
    if (
      typeof Worker === 'undefined' ||
      typeof OffscreenCanvas === 'undefined'
    ) {
      const video = await this.convertInMainThread(ImageBitmapList, info)
      EVT.fire('convertSuccess')
      return video
    }

    await this.workerReady

    const blob = await this.encodeInWorker(ImageBitmapList, info)
    EVT.fire('convertSuccess')
    return blob
  }

  private async convertInMainThread(
    ImageBitmapList: ImageBitmap[],
    info: UgoiraInfo
  ): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const width = ImageBitmapList[0].width
      const height = ImageBitmapList[0].height
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')!
      canvas.width = width
      canvas.height = height

      const encoder = new Whammy.Video()

      ImageBitmapList.forEach((imageBitmap, index) => {
        ctx.drawImage(imageBitmap, 0, 0)
        const url = canvas.toDataURL('image/webp', 0.9)
        encoder.add(url, info.frames![index].delay)
      })

      encoder.compile(false, (video: Blob) => {
        resolve(video)
      })
    })
  }

  /**
   * Send one streaming-protocol message and wait for its acknowledgement.
   * The worker is captured per request so an inactivity timeout can terminate
   * that exact instance before the shared heavy-conversion slot is released.
   */
  private postAndWait(
    worker: Worker,
    id: number,
    message: Record<string, unknown>,
    transfer: Transferable[],
    expectedType: 'ready' | 'frame-complete' | 'result'
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup()
        this.resetWorker(worker)
        reject(
          new Error(
            `Whammy worker inactivity timeout waiting for ${expectedType}`
          )
        )
      }, 120000)
      const cleanup = () => {
        window.clearTimeout(timeoutId)
        worker.removeEventListener('message', handler)
      }
      const handler = (ev: MessageEvent) => {
        if (!ev.data || ev.data.id !== id) return
        if (ev.data.type === 'error') {
          cleanup()
          reject(new Error(ev.data.error || 'Whammy worker error'))
          return
        }
        if (ev.data.type !== expectedType) return
        cleanup()
        resolve(ev.data)
      }
      worker.addEventListener('message', handler)
      try {
        worker.postMessage({ id, ...message }, transfer)
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  }

  /** 使用 worker 进行绘制和 WebM 编码，避免在主线程上执行 canvas.toDataURL 和 Whammy 编码 */
  private encodeInWorker(
    ImageBitmapList: ImageBitmap[],
    info: UgoiraInfo
  ): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const id = Date.now() + Math.random()
      const timeoutId = window.setTimeout(() => {
        this.worker.removeEventListener('message', handler)
        reject(new Error('Whammy encoding timeout'))
      }, 120000)

      const handler = (ev: MessageEvent) => {
        if (ev.data.id !== id) return
        window.clearTimeout(timeoutId)
        this.worker.removeEventListener('message', handler)
        if (ev.data.error) {
          reject(new Error(ev.data.error))
        } else if (ev.data.result && typeof ev.data.result.size === 'number') {
          resolve(ev.data.result)
        } else {
          reject(new Error('Invalid Whammy worker response'))
        }
      }

      this.worker.addEventListener('message', handler)
      // ImageBitmap 是可转移对象。若不提供 transfer list，浏览器会尝试复制
      // 所有帧的像素数据；大体积动图会因此触发 DataCloneError: out of memory。
      this.worker.postMessage(
        {
          id,
          bitmaps: ImageBitmapList,
          delays: info.frames!.map((frame) => frame.delay),
          width: ImageBitmapList[0].width,
          height: ImageBitmapList[0].height,
          quality: 0.9,
        },
        ImageBitmapList
      )
    })
  }
}

const toWebM = new ToWebM()
export { toWebM }
