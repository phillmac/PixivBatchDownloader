import { ownsCrawl } from '../crawl/CrawlGeneration'
// 初始化 本站的最新作品 artwork 页面
import { InitPageBase } from '../crawl/InitPageBase'
import { lang } from '../Language'
import { NewIllustOption } from '../crawl/CrawlArgument'
import { NewIllustData } from '../crawl/CrawlResult'
import { filter, FilterOption } from '../filter/Filter'
import { API } from '../API'
import { store } from '../store/Store'
import { log } from '../Log'
import { Tools } from '../Tools'
import { Utils } from '../utils/Utils'
import { states } from '../store/States'
import { settings } from '../setting/Settings'
import { pageType } from '../PageType'

class InitNewArtworkFromAllUsersPage extends InitPageBase {
  constructor() {
    super()
    this.init()
  }

  private option: NewIllustOption = this.resetOption()

  private readonly limitMax = 20 // 每次请求的数量最大是 20

  private fetchCount = 0 // 已请求的作品数量

  protected addCrawlBtns() {
    this.addInitPageBtn(
      'crawlBtns',
      '_开始抓取',
      '_下载大家的新作品',
      'startCrawling',
      'brand'
    ).addEventListener('click', () => {
      this.readyCrawl()
    })

    this.addStartTimedCrawlBtn(this.readyCrawl.bind(this))
    this.addCancelTimedCrawlBtn()
  }

  protected initAny() {}

  protected getWantPage() {
    this.crawlNumber = settings.crawlNumber[pageType.type].value
    log.warning(lang.transl('_从本页开始抓取x个', this.crawlNumber.toString()))
  }

  protected nextStep() {
    this.setSlowCrawl()
    this.initFetchURL()
    this.getIdList()
  }

  private resetOption(): NewIllustOption {
    return {
      lastId: '0',
      limit: '20', // 每次请求的数量，可以比 20 小
      type: '',
      r18: '',
    }
  }

  // 组织要请求的 url
  private initFetchURL() {
    this.option = this.resetOption()

    if (this.crawlNumber < this.limitMax) {
      this.option.limit = this.crawlNumber.toString()
    } else {
      this.option.limit = this.limitMax.toString()
    }

    // 当前页面的作品类型，默认是 illust
    this.option.type =
      Utils.getURLSearchField(location.href, 'type') || 'illust'
    // 是否是 R18 模式
    this.option.r18 = (location.href.includes('_r18.php') || false).toString()
  }

  /** 使用本轮抓取所有权，防止旧回调影响新任务。 */
  protected async getIdList() {
    const generation = this.generation
    if (!ownsCrawl(generation)) return

    if (states.stopCrawl) {
      return this.getIdListFinished(generation)
    }

    let data: NewIllustData
    try {
      data = await API.getNewIllustData(this.option)
      if (!ownsCrawl(generation)) return
    } catch (error) {
      if (!ownsCrawl(generation)) return
      this.getIdList()
      return
    }

    if (states.stopCrawl) {
      return this.getIdListFinished(generation)
    }

    let useData = data.body.illusts

    for (const nowData of useData) {
      // 抓取够了指定的数量
      if (this.fetchCount + 1 > this.crawlNumber) {
        break
      } else {
        this.fetchCount++
      }

      // 排除广告信息
      if (nowData.isAdContainer) {
        continue
      }

      const filterOpt: FilterOption = {
        aiType: nowData.aiType,
        id: nowData.id,
        isOriginal: nowData.isOriginal,
        width: nowData.pageCount === 1 ? nowData.width : 0,
        height: nowData.pageCount === 1 ? nowData.height : 0,
        pageCount: nowData.pageCount,
        bookmarkData: nowData.bookmarkData,
        workType: nowData.illustType,
        tags: nowData.tags,
        title: nowData.title,
        userId: nowData.userId,
        createDate: nowData.createDate,
        xRestrict: nowData.xRestrict,
      }

      const passesFilter = await filter.check(filterOpt)
      if (!ownsCrawl(generation)) return
      if (passesFilter) {
        store.idList.push({
          type: Tools.getWorkTypeString(nowData.illustType),
          id: nowData.id,
        })
      }
    }

    log.log(
      lang.transl('_新作品进度', this.fetchCount.toString()),
      'initNewArtworkPageFetchProgress'
    )

    // 抓取完毕
    if (
      this.fetchCount >= this.crawlNumber ||
      this.fetchCount >= this.maxCount
    ) {
      log.log(lang.transl('_开始获取作品页面'))
      this.getIdListFinished(generation)
      return
    }

    // 继续抓取
    this.option.lastId = data.body.lastId
    if (states.slowCrawlMode) {
      await Utils.sleep(settings.slowCrawlDealy)
      if (!ownsCrawl(generation)) return
    }
    this.getIdList()
  }

  protected resetGetIdListStatus() {
    this.fetchCount = 0
  }
}
export { InitNewArtworkFromAllUsersPage }
