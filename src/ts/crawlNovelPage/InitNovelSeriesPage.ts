import { ownsCrawl } from '../crawl/CrawlGeneration'
//初始化小说系列作品页面
import { InitPageBase } from '../crawl/InitPageBase'
import { store } from '../store/Store'
import { Tools } from '../Tools'
import { API } from '../API'
import { Utils } from '../utils/Utils'
import { MergeNovel } from '../download/MergeNovel'
import { EVT } from '../EVT'

class InitNovelSeriesPage extends InitPageBase {
  constructor() {
    super()
    this.init()
  }

  private readonly limit = 30
  private last = 0

  protected addCrawlBtns() {
    this.addInitPageBtn(
      'crawlBtns',
      '_抓取系列小说',
      '',
      'crawlSeriesNovel',
      'brand'
    ).addEventListener('click', () => {
      this.readyCrawl()
    })
  }

  protected addAnyElement() {
    this.addInitPageBtn(
      'crawlBtns',
      '_合并系列小说',
      '',
      'mergeSeriesNovel',
      'brand'
    ).addEventListener('click', async () => {
      EVT.fire('closeSettingsPanel')
      const seriesId = Tools.getSeriesId()
      let seriseTitle = ''
      // 尝试获取系列标题
      const meta = document.querySelector('meta[property="twitter:title"]')
      if (meta) {
        seriseTitle = meta.getAttribute('content') || ''
      }
      await new MergeNovel().merge(seriesId, seriseTitle)
      EVT.fire('exportLogsTiming')
    })
  }

  /** 使用本轮抓取所有权，防止旧回调影响新任务。 */
  protected async nextStep() {
    const generation = this.generation
    if (!ownsCrawl(generation)) return

    this.getIdList()
  }

  /** 使用本轮抓取所有权，防止旧回调影响新任务。 */
  protected async getIdList() {
    const generation = this.generation
    if (!ownsCrawl(generation)) return

    const seriesId = Tools.getSeriesId()
    const seriesData = await API.getNovelSeriesContent(
      seriesId,
      this.limit,
      this.last,
      'asc'
    )
    if (!ownsCrawl(generation)) return

    const list = seriesData.body.page.seriesContents
    for (const item of list) {
      store.idList.push({
        type: 'novels',
        id: item.id,
      })
    }

    this.last += list.length

    // 如果这一次返回的作品数量达到了每批限制，可能这次没有请求完，继续请求后续的数据
    if (list.length === this.limit) {
      this.getIdList()
    } else {
      this.getIdListFinished(generation)
    }
  }

  protected resetGetIdListStatus() {
    this.last = 0
  }
}

export { InitNovelSeriesPage }
