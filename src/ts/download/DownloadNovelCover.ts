import { log } from '../Log'
import { Utils } from '../utils/Utils'
import { lang } from '../Language'
import { SendDownload } from './SendDownload'
import { settings } from '../setting/Settings'
import { Tools } from '../Tools'
import { fetchGlobalDownloadBody } from './GlobalDownloadLease'

class DownloadNovelCover {
  /**下载小说的封面图片 */
  // 这个模块内部没有添加间隔时间
  public async download(
    coverURL: string,
    novelName: string,
    cancelled: () => boolean = () => false
  ) {
    const blob = await this.getCover(coverURL, 'blob', cancelled)
    if (blob === null || cancelled()) {
      return
    }

    let coverName = Utils.replaceExtension(novelName, coverURL)
    SendDownload.noReply(
      blob,
      coverName,
      Tools.chooseDownloadMethod(!settings.rememberTheLastSaveLocation)
    )
  }

  /**最多重试一定次数，避免无限重试 */
  private readonly retryMax = 5

  public async getCover(
    url: string,
    type: 'blob',
    cancelled?: () => boolean,
    retry?: number
  ): Promise<Blob | null>
  public async getCover(
    url: string,
    type: 'arrayBuffer',
    cancelled?: () => boolean,
    retry?: number
  ): Promise<ArrayBuffer | null>
  public async getCover(
    url: string,
    type: 'blob' | 'arrayBuffer',
    cancelled: () => boolean = () => false,
    retry = 0
  ): Promise<Blob | ArrayBuffer | null> {
    try {
      const download = await fetchGlobalDownloadBody(
        url,
        `novel-cover:${url}`,
        type,
        {
          method: 'get',
          credentials: 'same-origin',
        },
        cancelled
      )
      if (download === null) return null
      const res = download.response
      if (!res.ok || download.data === null) {
        const error = new Error(`${res.status} ${res.statusText}`)
        ;(error as any).status = res.status
        ;(error as any).statusText = res.statusText
        throw error
      }
      return download.data
    } catch (error: Error | any) {
      retry++
      // console.log(retry, url)
      if (retry > this.retryMax) {
        let msg = `${lang.transl('_下载小说封面失败')}: ${url}`
        const status = error.status
        if (status !== undefined) {
          msg += `<br> ${lang.transl('_状态码')}: ${status}`
        }
        log.error(msg)
        return null
      }
      return this.getCover(url, type as any, cancelled, retry)
    }
  }
}

const downloadNovelCover = new DownloadNovelCover()
export { downloadNovelCover }
