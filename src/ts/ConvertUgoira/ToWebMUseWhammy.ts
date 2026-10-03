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
    const zipFileBuffer = await file.arrayBuffer()
    const indexList = Tools.getJPGContentIndex(zipFileBuffer)
    if (indexList.length === 0) {
      throw new Error('No Ugoira frames found for WebM conversion')
    }

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
          id,
          {
            type: 'frame',
            index,
            bitmap,
            delay: info.frames[index]?.delay ?? 0,
          },
          [bitmap],
          'frame-complete'
        )
      }

      const response = await this.postAndWait(
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
      if (workerJobStarted) {
        try {
          this.worker.postMessage({ id, type: 'cancel' })
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

  private postAndWait(
    id: number,
    message: Record<string, unknown>,
    transfer: Transferable[],
    expectedType: 'ready' | 'frame-complete' | 'result'
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup()
        reject(new Error(`Whammy worker inactivity timeout waiting for ${expectedType}`))
      }, 120000)
      const cleanup = () => {
        window.clearTimeout(timeoutId)
        this.worker.removeEventListener('message', handler)
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
      this.worker.addEventListener('message', handler)
      try {
        this.worker.postMessage({ id, ...message }, transfer)
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
