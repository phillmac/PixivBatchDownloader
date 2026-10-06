import { ownsCrawl } from '../crawl/CrawlGeneration'
// 初始化插画/漫画的系列作品页面
import { InitPageBase } from '../crawl/InitPageBase'
import { API } from '../API'
import { lang } from '../Language'
import { Tools } from '../Tools'
import { filter, FilterOption } from '../filter/Filter'
import { store } from '../store/Store'
import { log } from '../Log'
import { Utils } from '../utils/Utils'
import { states } from '../store/States'
import { pageType } from '../PageType'
import { settings } from '../setting/Settings'

class InitArtworkSeriesPage extends InitPageBase {
  constructor() {
    super()
    this.init()
  }

  protected getIdListLogKey = 'crawlSeriesPageIdListProgress'

  private seriesId = ''

  protected addCrawlBtns() {
    this.addInitPageBtn(
      'crawlBtns',
      '_开始抓取',
      '_默认下载多页',
      'startCrawling',
      'brand'
    ).addEventListener('click', () => {
      this.readyCrawl()
    })
  }

  protected initAny() {}

  protected getWantPage() {
    this.crawlNumber = settings.crawlNumber[pageType.type].value
    log.warning(lang.transl('_从本页开始抓取x页', this.crawlNumber.toString()))
  }

  protected nextStep() {
    // 设置起始页码
    const p = Utils.getURLSearchField(location.href, 'p')
    this.startpageNo = parseInt(p) || 1

    // 获取系列 id
    this.seriesId = Tools.getSeriesId()

    this.getIdList()
  }

  /** 使用本轮抓取所有权，防止旧回调影响新任务。 */
  protected async getIdList() {
    const generation = this.generation
    if (!ownsCrawl(generation)) return

    if (states.stopCrawl) {
      return this.getIdListFinished(generation)
    }

    let p = this.startpageNo + this.listPageFinished

    const data = await API.getSeriesData(this.seriesId, p)
    if (!ownsCrawl(generation)) return
    this.listPageFinished++

    if (states.stopCrawl) {
      return this.getIdListFinished(generation)
    }

    // 保存本页面的作品的 id 列表
    const idList: string[] = []
    for (const info of data.body.page.series) {
      idList.push(info.workId)
    }
    // data.body.page.series 里的才是本页面的作品，illust 里则不同，有时它的作品数量比页面上的更多

    // 从 illust 里查找 id 对应的数据，进行过滤
    for (const work of data.body.thumbnails.illust) {
      if (!idList.includes(work.id)) {
        continue
      }
      if (work.isAdContainer) {
        continue
      }

      // 过滤器进行检查
      const filterOpt: FilterOption = {
        aiType: work.aiType,
        id: work.id,
        isOriginal: work.isOriginal,
        tags: work.tags,
        title: work.title,
        bookmarkData: !!work.bookmarkData,
        width: work.pageCount === 1 ? work.width : 0,
        height: work.pageCount === 1 ? work.height : 0,
        workType: work.illustType,
        userId: work.userId,
        createDate: work.createDate,
        xRestrict: work.xRestrict,
      }

      // 因为这个 api 的 illust 数据可能是插画也可能是漫画，所以 type 是 unknown
      const passesFilter = await filter.check(filterOpt)
      if (!ownsCrawl(generation)) return
      if (passesFilter) {
        store.idList.push({
          type: 'illusts',
          id: work.id,
        })
      }
    }

    // 如果 data.body.page.series 为空，就是到了最后一页
    const endFlag = data.body.page.series.length === 0

    // 抓取完毕
    if (
      endFlag ||
      p >= this.maxCount ||
      this.listPageFinished === this.crawlNumber
    ) {
      log.log(lang.transl('_列表页抓取完成'))
      this.getIdListFinished(generation)
    } else {
      // 继续抓取
      log.log(
        '➡️' + lang.transl('_列表页抓取进度', this.listPageFinished.toString()),
        this.getIdListLogKey
      )

      this.getIdList()
    }
  }

  protected resetGetIdListStatus() {
    this.listPageFinished = 0
  }
}
export { InitArtworkSeriesPage }
