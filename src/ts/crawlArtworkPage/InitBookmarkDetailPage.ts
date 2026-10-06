import { ownsCrawl } from '../crawl/CrawlGeneration'
// 初始化 bookmark_detail 页面
import { InitPageBase } from '../crawl/InitPageBase'
import { lang } from '../Language'
import { Tools } from '../Tools'
import { API } from '../API'
import { store } from '../store/Store'
import { log } from '../Log'
import { pageType } from '../PageType'
import { settings } from '../setting/Settings'

class InitBookmarkDetailPage extends InitPageBase {
  constructor() {
    super()
    this.init()
  }

  protected addCrawlBtns() {
    this.addInitPageBtn(
      'crawlBtns',
      '_抓取相似图片',
      '_抓取相似图片',
      'crawlSimilarImage',
      'brand'
    ).addEventListener(
      'click',
      () => {
        this.readyCrawl()
      },
      false
    )
  }

  protected initAny() {}

  protected getWantPage() {
    this.crawlNumber = settings.crawlNumber[pageType.type].value
    log.warning(lang.transl('_从本页开始抓取x个', this.crawlNumber.toString()))
  }

  /** 获取相似的作品列表；使用本轮抓取所有权。 */
  protected async getIdList() {
    const generation = this.generation
    if (!ownsCrawl(generation)) return

    let data = await API.getRecommenderData(
      Tools.getIllustId(),
      this.crawlNumber
    )
    if (!ownsCrawl(generation)) return

    for (const id of data.recommendations) {
      store.idList.push({
        type: 'illusts',
        id: id.toString(),
      })
    }

    this.getIdListFinished(generation)
  }
}
export { InitBookmarkDetailPage }
