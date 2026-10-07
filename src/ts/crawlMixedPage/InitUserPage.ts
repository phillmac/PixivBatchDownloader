import { registerAutomationCrawl } from '../download/AutomationCommandBindings'
import { beginCrawl, ownsCrawl } from '../crawl/CrawlGeneration'
import { consumeKnownOverlap, finishKnownOverlap } from '../crawl/KnownOverlap'
// 初始化用户页面
import { InitPageBase } from '../crawl/InitPageBase'
import { lang } from '../Language'
import { API } from '../API'
import { store } from '../store/Store'
import { EVT } from '../EVT'
import { log } from '../Log'
import { Tools } from '../Tools'
import { userWorksType, tagPageFlag } from '../crawl/CrawlArgument'
import { UserImageWorksWithTag, UserNovelsWithTag } from '../crawl/CrawlResult'
import { IDData, WorkTypeString } from '../store/StoreType'
import { states } from '../store/States'
import '../pageFunciton/SaveAvatarIcon'
import '../pageFunciton/SaveAvatarImage'
import '../pageFunciton/SaveUserCover'
import { BookmarkAllWorks, IDList } from '../pageFunciton/BookmarkAllWorks'
import { Utils } from '../utils/Utils'
import { Config } from '../Config'
import { pageType } from '../PageType'
import { settings } from '../setting/Settings'
import { toast } from '../Toast'

enum ListType {
  UserHome,
  Artworks,
  Illustrations,
  Manga,
  Novels,
}

class InitUserPage extends InitPageBase {
  constructor() {
    super()
    this.init()
    registerAutomationCrawl(pageType.type, this.readyCrawl.bind(this))
  }

  private listType: ListType = ListType.UserHome // 当前页面应该获取哪些类型的作品

  private onceNumber = 48 // 每页作品个数，插画是 48 个，小说是 30 个

  private bookmarkAll = new BookmarkAllWorks()

  // 添加中间按钮
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

    this.addStartTimedCrawlBtn(this.readyCrawl.bind(this))
    this.addCancelTimedCrawlBtn()
  }

  /** 使用本轮抓取所有权，防止旧回调影响新任务。 */
  protected addAnyElement() {
    this.addInitPageBtn(
      'otherBtns',
      '_保存用户头像',
      '',
      'saveUserAvatar',
      'brand'
    ).addEventListener('click', () => {
      EVT.fire('saveAvatarImage')
    })

    this.addInitPageBtn(
      'otherBtns',
      '_保存用户头像为图标',
      '_保存用户头像为图标说明',
      'saveUserAvatarAsIcon',
      'brand'
    ).addEventListener('click', () => {
      EVT.fire('saveAvatarIcon')
    })

    this.addInitPageBtn(
      'otherBtns',
      '_保存用户封面',
      '',
      'saveUserCoverImage',
      'brand'
    ).addEventListener('click', () => {
      EVT.fire('saveUserCover')
    })

    // 添加收藏本页所有作品的功能
    const bookmarkAllBtn = this.addInitPageBtn(
      'otherBtns',
      '_收藏本页面的所有作品',
      '',
      'bookmarkAllWorksOnPage',
      'brand'
    )

    bookmarkAllBtn.addEventListener('click', async () => {
      if (states.busy) {
        toast.error(lang.transl('_当前任务尚未完成'))
        return
      }

      // 获取这一页里所有作品的 id 列表
      // 模拟了抓取流程，以获取相同的 id 列表
      // 批量收藏复用 ID 抓取流程，也需要独立的 ID 写入所有权。
      this.generation = beginCrawl()
      EVT.fire('bookmarkModeStart')
      store.tag = Tools.getTagFromURL()
      this.crawlNumber = 1 // 设置为只抓取 1 页
      this.readyGetIdList()
    })

    this.bookmarkAll = new BookmarkAllWorks(bookmarkAllBtn)
    window.addEventListener(
      EVT.list.getIdListFinished,
      this.bookmarkAll.getBookmarkIdList
    )
  }

  protected getWantPage() {
    this.crawlNumber = settings.crawlNumber[pageType.type].value
    if (this.crawlNumber === -1) {
      log.warning(lang.transl('_抓取所有页面'))
    } else {
      log.warning(
        lang.transl('_从本页开始抓取x页', this.crawlNumber.toString())
      )
    }
  }

  protected nextStep() {
    this.readyGetIdList()

    log.log(lang.transl('_正在抓取'))
  }

  protected readyGetIdList() {
    // 判断页面类型
    // 匹配 pathname 里用户 id 之后的字符
    const test = location.pathname.match(/\/users\/\d+(\/.+)/)
    if (test === null) {
      // 用户主页
      this.listType = ListType.UserHome
    } else if (test.length === 2) {
      const str = test[1] //取出用户 id 之后的字符
      if (str.includes('/artworks')) {
        // 插画和漫画列表
        this.listType = ListType.Artworks
      } else if (str.includes('/illustrations')) {
        // 插画列表
        this.listType = ListType.Illustrations
      } else if (str.includes('/manga')) {
        // 漫画列表
        this.listType = ListType.Manga
      } else if (str.includes('/novels')) {
        // 小说列表
        this.listType = ListType.Novels
        this.onceNumber = 30 // 如果是在小说列表页，一页有 30 个作品
      }
    }

    store.tag ? this.getIdListByTag() : this.getIdList()
  }

  private getOffset() {
    const nowPage = Utils.getURLSearchField(location.href, 'p') // 判断当前处于第几页，页码从 1 开始。也可能没有页码
    let offset: number = 0
    if (nowPage) {
      offset = (parseInt(nowPage) - 1) * this.onceNumber
    }
    if (offset < 0) {
      offset = 0
    }

    return offset
  }

  // 根据页数设置，计算要下载的个数
  private getRequsetNumber() {
    let requsetNumber = Config.worksNumberLimit
    if (this.crawlNumber !== -1) {
      requsetNumber = this.onceNumber * this.crawlNumber
    }
    return requsetNumber
  }

  /** 获取用户某些类型的作品的 id 列表；使用本轮抓取所有权。 */
  protected async getIdList() {
    const generation = this.generation
    if (!ownsCrawl(generation)) return

    const userId = Tools.getCurrentPageUserId()
    const checkUser = await this.checkUserId(userId)
    if (!ownsCrawl(generation)) return
    if (!checkUser) {
      return this.getIdListFinished(generation)
    }

    let type: userWorksType[] = []

    switch (this.listType) {
      case ListType.UserHome:
        type = ['illusts', 'manga', 'novels']
        break
      case ListType.Artworks:
        type = ['illusts', 'manga']
        break
      case ListType.Illustrations:
        type = ['illusts']
        break
      case ListType.Manga:
        type = ['manga']
        break
      case ListType.Novels:
        type = ['novels']
        break
    }
    let idList = await API.getUserWorksByType(userId, type)
    if (!ownsCrawl(generation)) return

    // 判断是否全都是小说，如果是，把每页的作品个数设置为 30 个
    const allWorkIsNovels = idList.every((data) => {
      return data.type === 'novels'
    })
    allWorkIsNovels && (this.onceNumber = 30)

    // 计算偏移量和需要保留的作品个数
    const offset = this.getOffset()
    const requsetNumber = this.getRequsetNumber()

    // 按照 id 升序排列，之后会删除不需要的部分
    idList.sort(Utils.sortByProperty('id')).reverse()

    // 不带 tag 获取作品时，由于 API 是一次性返回用户的所有作品，可能大于要求的数量，所以需要去掉多余的作品。
    // 删除 offset 需要去掉的部分。删除后面的 id，也就是近期作品
    idList.splice(idList.length - offset, idList.length)

    // 删除超过 requsetNumber 的作品。删除前面的 id，也就是早期作品
    const limitedBySetting = idList.length > requsetNumber
    if (limitedBySetting) {
      idList.splice(0, idList.length - requsetNumber)
    }

    // 已知重叠按最新到最旧扫描；下载器内部仍保留原来的旧到新 ID 顺序。
    // 用户主页同时混有图片与小说，两类 ID 并不是同一时间序列，因此只能过滤已知
    // ID，不能用跨类型的连续 ID 作为提前终止边界。
    const allowBoundary = this.listType !== ListType.UserHome
    const overlap = consumeKnownOverlap([...idList].reverse(), allowBoundary)
    idList = [...overlap.items].reverse()
    if (!overlap.boundaryReached) {
      finishKnownOverlap(limitedBySetting ? 'crawl-limit' : 'source-exhausted')
    }

    // 储存
    store.idList = store.idList.concat(idList)

    this.getIdListFinished(generation)
  }

  /** 获取用户某些类型的作品的 id 列表（附带 tag）；使用本轮抓取所有权。 */
  private async getIdListByTag() {
    const generation = this.generation
    if (!ownsCrawl(generation)) return

    if (states.stopCrawl) {
      return this.getIdListFinished(generation)
    }

    // 这里不用判断用户主页的情况，因为用户主页不会带 tag
    let type: tagPageFlag = 'illustmanga'
    switch (this.listType) {
      case ListType.Artworks:
        type = 'illustmanga'
        break
      case ListType.Illustrations:
        type = 'illusts'
        break
      case ListType.Manga:
        type = 'manga'
        break
      case ListType.Novels:
        type = 'novels'
        break
    }

    // 计算初始偏移量
    let offset = this.getOffset()
    // 计算需要获取多少个作品
    const requsetNumber = this.getRequsetNumber()

    // 循环请求作品，一次请求一页。假设用户的标签页面最大页数不会超过这个数字
    const maxRequest = 1000
    let sourceScanned = 0
    for (const iterator of new Array(maxRequest)) {
      let data = await API.getUserWorksByTypeWithTag(
        Tools.getCurrentPageUserId(),
        type,
        store.tag,
        offset,
        this.onceNumber
      )
      if (!ownsCrawl(generation)) return

      if (states.stopCrawl) {
        return this.getIdListFinished(generation)
      }

      // 图片和小说返回的数据是不同的，小说没有 illustType 标记。
      const pageItems: IDData[] = []
      if (this.listType === ListType.Novels) {
        const d = data as UserNovelsWithTag
        d.body.works.forEach((data) =>
          pageItems.push({
            type: 'novels',
            id: data.id,
          })
        )
      } else {
        const d = data as UserImageWorksWithTag
        d.body.works.forEach((data) => {
          let type: WorkTypeString = 'illusts'
          switch (data.illustType) {
            case 0:
              type = 'illusts'
              break
            case 1:
              type = 'manga'
              break
            case 2:
              type = 'ugoira'
              break
          }
          pageItems.push({
            type,
            id: data.id,
          })
        })
      }

      sourceScanned += data.body.works.length
      const overlap = consumeKnownOverlap(pageItems)
      store.idList = store.idList.concat(overlap.items)
      offset += data.body.works.length
      if (overlap.boundaryReached) {
        return this.getIdListFinished(generation)
      }

      // 有限抓取按源作品数计数，不能因为已知 ID 被过滤后继续越过用户的页数上限。
      const sourceExhausted = data.body.works.length < this.onceNumber
      const crawlLimitReached =
        this.crawlNumber !== -1 && sourceScanned >= requsetNumber
      if (sourceExhausted || crawlLimitReached) {
        finishKnownOverlap(sourceExhausted ? 'source-exhausted' : 'crawl-limit')
        return this.getIdListFinished(generation)
      }
    }
    finishKnownOverlap('crawl-limit')
    this.getIdListFinished(generation)
  }

  protected resetGetIdListStatus() {
    this.listType = ListType.UserHome
  }

  protected sortResult() {
    // 把作品数据按 id 倒序排列，id 大的在前面，这样可以先下载最新作品，后下载早期作品
    store.result.sort(Utils.sortByProperty('id'))
  }

  protected destroy() {
    Tools.clearSlot('crawlBtns')
    Tools.clearSlot('otherBtns')

    window.removeEventListener(
      EVT.list.getIdListFinished,
      this.bookmarkAll.getBookmarkIdList
    )
  }
}
export { InitUserPage }
