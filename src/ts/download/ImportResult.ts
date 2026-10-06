import {
  currentCrawl,
  replacementOwner,
  revokeCrawl,
} from '../crawl/CrawlGeneration'
import { EVT } from '../EVT'
import { Result } from '../store/StoreType'
import { lang } from '../Language'
import { Utils } from '../utils/Utils'
import { states } from '../store/States'
import { store } from '../store/Store'
import { toast } from '../Toast'
import { msgBox } from '../MsgBox'
import { filter } from '../filter/Filter'
import { Tools } from '../Tools'

class ImportResult {
  constructor() {
    this.bindEvents()
  }

  private bindEvents() {
    window.addEventListener(EVT.list.importResult, () => {
      if (states.busy) {
        toast.error(lang.transl('_当前任务尚未完成'))
        return
      }

      this.import()
    })
  }

  private async import() {
    const generationAtStart = currentCrawl()
    const loadedJSON = (await Utils.loadJSONFile().catch((err) => {
      return msgBox.error(err)
    })) as Result[]
    if (!loadedJSON) {
      return
    }

    // 要求是数组并且要有内容
    if (!Array.isArray(loadedJSON) || !loadedJSON.length || !loadedJSON[0]) {
      return toast.error(lang.transl('_格式错误'))
    }

    // 检查是否含有必须的字段（只检查了一部分）
    const keys = Object.keys(loadedJSON[0])
    const need = ['idNum', 'id', 'original', 'type', 'ext']
    for (const field of need) {
      if (!keys.includes(field)) {
        return toast.error(lang.transl('_格式错误'))
      }
    }

    // 根据过滤选项，过滤导入的结果
    const temp: Result[] = []
    for (const result of loadedJSON) {
      const check = await filter.check({
        aiType: result.aiType,
        id: result.idNum,
        isOriginal: result.isOriginal,
        workType: result.type,
        IDTypeString: Tools.getWorkTypeString(result.type),
        pageCount: result.pageCount,
        tags: result.tagsWithTransl,
        title: result.title,
        bookmarkCount: result.bmk,
        bookmarkData: result.bookmarked,
        width: result.pageCount === 1 ? result.fullWidth : 0,
        height: result.pageCount === 1 ? result.fullHeight : 0,
        createDate: result.date,
        userId: result.userId,
        xRestrict: result.xRestrict,
      })
      if (check) {
        temp.push(result)
      }
    }

    // 如果没有符合过滤条件的结果
    if (temp.length === 0) {
      msgBox.warning(lang.transl('_没有符合条件的结果'))
      return
    }

    // 文件选择和过滤期间可能开始了新的抓取；导入不能覆盖新的所有者。
    if (states.busy || currentCrawl() !== generationAtStart) {
      return
    }
    if (generationAtStart !== null) {
      revokeCrawl(generationAtStart)
    }

    // 恢复数据
    // 通过 store.addResult 添加数据，可以应用多图作品设置，对导入的结果进行调整
    store.reset()
    // 导入结果属于当前页面，而不是之前抓取/恢复任务遗留的 URL。
    store.URLWhenCrawlStart = window.location.href
    store.crawlCompleteTime = new Date()
    for (const r of temp) {
      store.addResult(replacementOwner, r)
    }

    // 有效导入替换内存队列；旧抓取已撤销权限时释放托管下载保护。
    EVT.fire('importResultLoaded')
    // 发送通知
    EVT.fire('crawlComplete')

    msgBox.success(lang.transl('_导入成功'))
  }
}

new ImportResult()
