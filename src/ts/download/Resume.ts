import { EVT } from '../EVT'
import { log } from '../Log'
import { lang } from '../Language'
import { store } from '../store/Store'
import { states } from '../store/States'
import { downloadStates, DLStatesI, DLStateSummary } from './DownloadStates'
import { Result } from '../store/StoreType'
import { IndexedDB } from '../utils/IndexedDB'
import { Utils } from '../utils/Utils'
import { toast } from '../Toast'

interface TaskMeta {
  id: number
  url: string
  URLWhenCrawlStart: string
  part: number
  date: Date
  stateSummary?: DLStateSummary
}

interface TaskData {
  id: number
  data: Result[]
}

interface TaskStates {
  id: number
  states: DLStatesI
}

interface SaveSnapshot {
  url: string
  URLWhenCrawlStart: string
  results: Result[]
  states: DLStatesI
  stateSummary: DLStateSummary
  date: Date
  generation: number
  sharedGeneration: number
}

interface PendingSaveRequest {
  url: string
  generation: number
  sharedGeneration: number
  waiters: Array<{ resolve: () => void; reject: (reason?: unknown) => void }>
}

// 断点续传。恢复未完成的下载
class Resume {
  constructor() {
    this.IDB = new IndexedDB()
    this.ready = this.init()
  }

  private IDB: IndexedDB
  /** 初始化断点续传数据库和事件绑定的 Promise。 */
  private readonly ready: Promise<void>
  private readonly DBName = 'PBD'
  private readonly DBVer = 4
  private metaName = 'taskMeta' // 下载任务元数据的表名
  private dataName = 'taskData' // 下载任务数据的表名
  private statesName = 'taskStates' // 下载状态列表的表名
  /** 跨标签页共享的断点续传控制记录表。 */
  private readonly controlName = 'resumeControl'
  /** 共享控制记录的固定主键。 */
  private readonly controlKey = 'shared'
  // 本模块所操作的下载数据的 id
  private taskId!: number

  // 尝试存储抓取结果时，单次存储的数量不能超过这个数字。因为超过这个数字可能会碰到单次存储的上限
  // 由于每个结果的体积可能不同，所以这只是一个预估值
  // 这有助于减少尝试次数。因为存储的思路是存储失败时改为上次数量的 1/2。例如有 100 w 个结果，存储算法会依次尝试存入 100 w、50 w、25 w、12.5 w 以此类推，直到最后有一次能成功存储一批数据。这样的话就进行了 4 次尝试才成功存入一批数据。但通过直接指定一批数据的大小为 onceMax，理想情况下可以只尝试一次就成功存入一批数据。
  // 非理想情况下，即这个数量的结果已经超过了单次存储上限（目前推测这可能会在大量抓取小说、动图时出现；如果抓取的作品大部分是插画、漫画，这个数量的结果应该不可能超出存储上限），那么这不会减少尝试数量，但因为每次尝试存储的数量不会超过这个数字，这依然有助于减少每次尝试时的资源占用、耗费时间。
  private readonly onceMax = 150000

  private readonly putStatesTime = 1000 // 每隔指定时间存储一次最新的下载状态

  private needPutStates = false // 指示是否需要更新存储的下载状态
  /** 当前活动持久化任务的元数据；清除/切换所有权时必须同步失效。 */
  private currentMeta: TaskMeta | null = null
  /** 每次恢复尝试递增；用于阻止旧 SPA 路由的异步恢复落地。 */
  private restoreGeneration = 0
  /** Tombstones deleted task ids so async reads issued before deletion cannot reclaim ownership. */
  private readonly invalidatedRestoreTaskIds = new Set<number>()
  /** 表示恢复因 busy 被跳过或中途打断，下一次 idle 时必须重试。 */
  private restorePending = false
  /** 清除持久化数据时递增；使已排队/进行中的保存请求失效。 */
  private persistenceGeneration = 0
  /** 自动化放弃部分抓取后，禁止同 URL 的迟到 resultChange 重新保存，直到下一次 crawlStart。 */
  private readonly suppressedSaveUrls = new Set<string>()
  /** 旧版无摘要任务的进程内标量缓存，避免状态轮询反复读取大数组。 */
  private readonly legacySummaryCache = new Map<number, DLStateSummary>()

  private async init() {
    if (!Utils.isPixiv()) {
      return
    }

    await this.initDB()
    await this.ensureControlRecord()
    this.bindEvents()

    if (states.settingInitialized) {
      this.restoreData()
    }

    this.regularPutStates()
    this.clearExired()
  }

  /** 仅删除指定 URL 的持久化未完成任务，供外部自动化安全放弃部分抓取结果。 */
  public async discardSavedTask(url = this.getURL()) {
    await this.ready
    const normalizedUrl = this.normalizeURL(url)
    if (!Utils.isPixiv()) {
      return { discarded: false, url: normalizedUrl, taskId: null }
    }

    // 先抑制这个 URL 的后续保存并使已经排队/进行中的旧快照失效，
    // 避免停止抓取后的迟到 resultChange 在删除后又复活部分任务。
    this.suppressedSaveUrls.add(normalizedUrl)
    this.restoreGeneration++
    this.persistenceGeneration++
    this.restorePending = false
    if (this.currentMeta?.url === normalizedUrl) {
      this.invalidateTaskOwnership(this.currentMeta.id)
    }

    // 等正在执行的保存请求退出；旧代数请求会在写入前自行放弃。
    while (this.saveDataDraining) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    }

    const meta = (await this.IDB.get(
      this.metaName,
      normalizedUrl,
      'url'
    )) as TaskMeta | null
    if (!meta) {
      return { discarded: false, url: normalizedUrl, taskId: null }
    }

    this.invalidateTaskOwnership(meta.id)
    await this.deleteTaskRecords(meta)
    return { discarded: true, url: normalizedUrl, taskId: meta.id }
  }

  /** 返回当前 URL 对应的持久化未完成任务摘要。 */
  public async getSavedTaskStatus(url = this.getURL()) {
    await this.ready
    if (!Utils.isPixiv()) {
      return null
    }
    const normalizedUrl = this.normalizeURL(url)
    const meta = (await this.IDB.get(
      this.metaName,
      normalizedUrl,
      'url'
    )) as TaskMeta | null
    if (!meta) {
      return null
    }

    let summary = meta.stateSummary || this.legacySummaryCache.get(meta.id)
    // 兼容旧版保存数据：只在内存里缓存一次标量摘要，避免轮询重写/复活已删除元数据。
    if (!summary) {
      const taskStates = (await this.IDB.get(
        this.statesName,
        meta.id
      )) as TaskStates | null
      const currentMeta = (await this.IDB.get(
        this.metaName,
        meta.id
      )) as TaskMeta | null
      if (!currentMeta || currentMeta.url !== meta.url) {
        return null
      }
      summary =
        currentMeta.stateSummary ||
        this.summarizeStates(taskStates?.states ?? [])
      if (!currentMeta.stateSummary) {
        this.legacySummaryCache.set(meta.id, summary)
      }
    }

    return {
      id: meta.id,
      url: meta.url,
      URLWhenCrawlStart: meta.URLWhenCrawlStart,
      date:
        meta.date instanceof Date
          ? meta.date.toISOString()
          : new Date(meta.date).toISOString(),
      ...summary,
    }
  }

  // 初始化数据库，获取数据库对象
  private async initDB() {
    // 在升级事件里创建表和索引
    const onUpdate = (db: IDBDatabase) => {
      if (!db.objectStoreNames.contains(this.metaName)) {
        const metaStore = db.createObjectStore(this.metaName, {
          keyPath: 'id',
        })
        metaStore.createIndex('id', 'id', { unique: true })
        metaStore.createIndex('url', 'url', { unique: true })
      }

      if (!db.objectStoreNames.contains(this.dataName)) {
        const dataStore = db.createObjectStore(this.dataName, {
          keyPath: 'id',
        })
        dataStore.createIndex('id', 'id', { unique: true })
      }

      if (!db.objectStoreNames.contains(this.statesName)) {
        const statesStore = db.createObjectStore(this.statesName, {
          keyPath: 'id',
        })
        statesStore.createIndex('id', 'id', { unique: true })
      }

      if (!db.objectStoreNames.contains(this.controlName)) {
        db.createObjectStore(this.controlName, { keyPath: 'id' })
      }
    }

    // 打开数据库
    return this.IDB.open(this.DBName, this.DBVer, onUpdate)
  }

  /** 确保跨标签页共享的清除代数记录存在。 */
  private async ensureControlRecord() {
    const current = await this.IDB.get(this.controlName, this.controlKey)
    if (current) return
    try {
      await this.IDB.add(this.controlName, {
        id: this.controlKey,
        generation: 0,
      })
    } catch {
      // 另一个标签页可能已经同时创建了相同记录。
      if (!(await this.IDB.get(this.controlName, this.controlKey)))
        throw new Error('failed to initialize Resume control record')
    }
  }

  /** 读取跨标签页共享的清除代数。 */
  private async getSharedGeneration() {
    const current = (await this.IDB.get(this.controlName, this.controlKey)) as {
      generation?: number
    } | null
    return Number(current?.generation ?? 0)
  }

  private bindEvents() {
    window.addEventListener(EVT.list.crawlStart, () => {
      this.suppressedSaveUrls.delete(this.getURL())
    })

    // 切换页面时，重新检查恢复数据
    const restoreEvt = [EVT.list.pageSwitch, EVT.list.settingInitialized]
    restoreEvt.forEach((evt) => {
      window.addEventListener(evt, () => {
        this.restoreData()
      })
    })

    const restoreRetryEvt = [
      EVT.list.stopCrawl,
      EVT.list.crawlComplete,
      EVT.list.downloadPause,
      EVT.list.downloadStop,
      EVT.list.downloadComplete,
      EVT.list.bookmarkModeEnd,
    ]
    restoreRetryEvt.forEach((evt) => {
      window.addEventListener(evt, () => {
        window.setTimeout(() => {
          if (this.restorePending && !states.busy) {
            this.restoreData()
          }
        }, 0)
      })
    })

    // 抓取完成时，保存这次任务的数据
    const evs = [EVT.list.crawlComplete, EVT.list.resultChange]
    for (const ev of evs) {
      window.addEventListener(ev, async () => {
        this.saveData(store.URLWhenCrawlStart || this.getURL())
      })
    }

    // 当有文件下载完成或者跳过下载时，更新下载状态
    const saveEv = [EVT.list.downloadSuccess, EVT.list.skipDownload]
    saveEv.forEach((val) => {
      window.addEventListener(val, () => {
        this.needPutStates = true
      })
    })

    // 任务下载完毕时，以及停止任务时，清除这次任务的数据
    const clearDataEv = [EVT.list.downloadComplete, EVT.list.downloadStop]
    for (const ev of clearDataEv) {
      window.addEventListener(ev, async () => {
        this.clearData(ev)
      })
    }

    // 清空已保存的抓取结果
    window.addEventListener(EVT.list.clearSavedCrawl, () => {
      this.clearSavedCrawl()
    })
  }

  // 恢复未完成任务的数据
  private async restoreData() {
    const generation = ++this.restoreGeneration
    const restoreUrl = this.getURL()

    // 如果下载器在抓取或者在下载，则记住待恢复状态，在下一次 idle 事件后重试。
    if (states.busy) {
      this.restorePending = true
      return
    }
    this.restorePending = false

    // 1 获取任务的元数据
    const meta = (await this.IDB.get(
      this.metaName,
      restoreUrl,
      'url'
    )) as TaskMeta | null
    if (!meta || this.invalidatedRestoreTaskIds.has(meta.id)) {
      return
    }

    log.log(lang.transl('_正在恢复抓取结果'))

    await states.waitSettingInitialized()
    const dataIdList: number[] = this.createIdList(meta.id, meta.part)
    const snapshot = await this.IDB.getMany([
      { storeName: this.metaName, key: meta.id },
      { storeName: this.statesName, key: meta.id },
      ...dataIdList.map((id) => ({ storeName: this.dataName, key: id })),
    ])
    const sharedMeta = snapshot[0] as TaskMeta | null
    const taskStates = snapshot[1] as TaskStates | null
    const chunks = snapshot.slice(2) as Array<TaskData | null>
    if (
      generation !== this.restoreGeneration ||
      this.getURL() !== restoreUrl ||
      this.invalidatedRestoreTaskIds.has(meta.id) ||
      !sharedMeta ||
      sharedMeta.url !== meta.url ||
      !taskStates ||
      chunks.some((chunk) => !chunk)
    ) {
      return
    }
    if (states.busy) {
      this.restorePending = true
      return
    }

    const restored: Result[] = []
    for (const taskData of chunks) {
      // 单个持久化分块最多可有 150000 项，不能通过 spread 作为函数参数一次性追加。
      for (const data of taskData!.data) {
        restored.push(data)
      }
    }
    store.result = restored
    store.resetDownloadCount()
    if (taskStates) {
      downloadStates.replace(taskStates.states)
    }

    this.taskId = meta.id
    this.currentMeta = meta
    store.crawlCompleteTime = meta.date
    store.URLWhenCrawlStart = this.normalizeURL(
      meta.URLWhenCrawlStart || restoreUrl
    )

    log.success(lang.transl('_已恢复抓取结果'), 'restoreCrawlResult')
    EVT.fire('resume')
  }

  /** 等待持久化的轻量请求；同一 URL 的重复 resultChange 会在这里合并。 */
  private readonly pendingSaveRequests: PendingSaveRequest[] = []
  /** 指示保存队列当前是否有一个快照正在写入 IndexedDB。 */
  private saveDataDraining = false

  private async saveData(url = this.getURL()) {
    const normalizedUrl = this.normalizeURL(url)
    if (this.suppressedSaveUrls.has(normalizedUrl)) return
    const generation = this.persistenceGeneration
    const sharedGeneration = await this.getSharedGeneration()
    return new Promise<void>((resolve, reject) => {
      const pending = this.pendingSaveRequests.find(
        (request) => request.url === normalizedUrl
      )
      if (pending) {
        pending.generation = generation
        pending.sharedGeneration = sharedGeneration
        pending.waiters.push({ resolve, reject })
      } else {
        this.pendingSaveRequests.push({
          url: normalizedUrl,
          generation,
          sharedGeneration,
          waiters: [{ resolve, reject }],
        })
      }
      void this.drainSaveDataQueue()
    })
  }

  /** 串行处理保存请求，并只在真正开始写入时复制大型结果/状态数组。 */
  private async drainSaveDataQueue() {
    if (this.saveDataDraining) return
    this.saveDataDraining = true
    try {
      while (this.pendingSaveRequests.length > 0) {
        const request = this.pendingSaveRequests.shift()!
        try {
          if (request.generation !== this.persistenceGeneration) {
            request.waiters.forEach(({ resolve }) => resolve())
            continue
          }
          const liveTaskUrl = this.normalizeURL(
            store.URLWhenCrawlStart || this.getURL()
          )
          if (liveTaskUrl !== request.url) {
            request.waiters.forEach(({ resolve }) => resolve())
            continue
          }
          const snapshot: SaveSnapshot = {
            url: request.url,
            URLWhenCrawlStart: liveTaskUrl,
            results: [...store.result],
            states: [...downloadStates.states] as DLStatesI,
            stateSummary: { ...downloadStates.summary() },
            date: new Date(store.crawlCompleteTime),
            generation: request.generation,
            sharedGeneration: request.sharedGeneration,
          }
          await this.saveDataInner(snapshot)
          request.waiters.forEach(({ resolve }) => resolve())
        } catch (error) {
          request.waiters.forEach(({ reject }) => reject(error))
        }
      }
    } finally {
      this.saveDataDraining = false
      if (this.pendingSaveRequests.length > 0) {
        void this.drainSaveDataQueue()
      }
    }
  }

  private async saveDataInner(snapshot: SaveSnapshot) {
    if (snapshot.generation !== this.persistenceGeneration) return
    const taskData = (await this.IDB.get(
      this.metaName,
      snapshot.url,
      'url'
    )) as TaskMeta | null

    if (taskData) {
      this.invalidateTaskOwnership(taskData.id)
      await this.deleteTaskRecords(taskData)
    }
    if (snapshot.generation !== this.persistenceGeneration) return
    if (snapshot.stateSummary.completed === snapshot.results.length) return

    const taskId = Date.now()
    const parts: number[] = []
    await this.saveTaskData(
      snapshot.results,
      taskId,
      parts,
      snapshot.generation
    )
    if (snapshot.generation !== this.persistenceGeneration) {
      await this.deleteTaskDataChunks(taskId, parts.length)
      return
    }

    const metaData: TaskMeta = {
      id: taskId,
      url: snapshot.url,
      URLWhenCrawlStart: snapshot.URLWhenCrawlStart,
      part: parts.length,
      date: snapshot.date,
      stateSummary: snapshot.stateSummary,
    }
    const statesData: TaskStates = {
      id: taskId,
      states: snapshot.states,
    }
    const persisted = await this.IDB.putManyIfFieldEquals(
      [
        { storeName: this.metaName, data: metaData },
        { storeName: this.statesName, data: statesData },
      ],
      this.controlName,
      this.controlKey,
      'generation',
      snapshot.sharedGeneration
    )
    if (!persisted) {
      await this.deleteTaskDataChunks(taskId, parts.length)
      return
    }

    // 仅当页面仍属于这份队列时，把后续下载进度 checkpoint 的所有权交给它。
    if (
      this.normalizeURL(store.URLWhenCrawlStart || this.getURL()) ===
      snapshot.URLWhenCrawlStart
    ) {
      this.taskId = taskId
      this.currentMeta = metaData
    }

    log.success(lang.transl('_已保存抓取结果'), 'saveCrawlResult')
  }

  // 存储抓取结果。结果数组和任务 URL 在排队 saveData 时已快照，避免后续抓取污染。
  private async saveTaskData(
    results: Result[],
    taskId: number,
    parts: number[],
    generation: number,
    attempt = 0
  ): Promise<void> {
    if (generation !== this.persistenceGeneration) return
    let tryNum = Math.floor(results.length * Math.pow(0.5, attempt))
    tryNum > this.onceMax && (tryNum = this.onceMax)
    const offset = parts.reduce((total, count) => total + count, 0)
    const data = {
      id: this.numAppendNum(taskId, parts.length),
      data: results.slice(offset, offset + tryNum),
    }

    try {
      await this.IDB.add(this.dataName, data)
      parts.push(data.data.length)
      if (offset + data.data.length < results.length) {
        return this.saveTaskData(results, taskId, parts, generation, 0)
      }
    } catch (error: Error | any) {
      console.error(error)
      if (error.target && error.target.error && error.target.error.message) {
        const msg = error.target.error.message as string
        if (msg.includes('too large')) {
          return this.saveTaskData(
            results,
            taskId,
            parts,
            generation,
            attempt + 1
          )
        }
        log.error('IndexedDB: ' + msg)
        throw error
      }
    }
  }

  /** 删除尚未提交元数据的任务分块，避免取消保存留下孤儿数据。 */
  private async deleteTaskDataChunks(taskId: number, part: number) {
    const entries = this.createIdList(taskId, part).map((id) => ({
      storeName: this.dataName,
      key: id,
    }))
    if (entries.length > 0) await this.IDB.deleteMany(entries)
  }

  /** 原子删除一个完整的持久化任务。 */
  private async deleteTaskRecords(meta: TaskMeta) {
    await this.IDB.deleteMany([
      { storeName: this.metaName, key: meta.id },
      { storeName: this.statesName, key: meta.id },
      ...this.createIdList(meta.id, meta.part).map((id) => ({
        storeName: this.dataName,
        key: id,
      })),
    ])
  }

  // 定时 put 下载状态
  private async regularPutStates() {
    window.setInterval(() => {
      if (this.restorePending && !states.busy) {
        void this.restoreData()
      }
      if (this.needPutStates) {
        // 初次保存尚未提交时没有有效所有权；保留标记，等 currentMeta 建立后再写最新状态。
        if (!this.currentMeta || this.currentMeta.id !== this.taskId) {
          return
        }
        const statesData = {
          id: this.taskId,
          states: [...downloadStates.states] as DLStatesI,
        }
        // 如果此时本次任务已经完成，就不进行保存了
        if (downloadStates.downloadedCount() === store.result.length) {
          this.needPutStates = false
          return
        }
        const updatedMeta = {
          ...this.currentMeta,
          stateSummary: downloadStates.summary(),
        }
        this.needPutStates = false
        void this.IDB.putManyIfPresent(
          [
            { storeName: this.statesName, data: statesData },
            { storeName: this.metaName, data: updatedMeta },
          ],
          this.metaName,
          updatedMeta.id
        ).then((persisted) => {
          if (!persisted) {
            this.invalidateTaskOwnership(updatedMeta.id)
          } else if (this.currentMeta?.id === updatedMeta.id) {
            this.currentMeta = updatedMeta
          }
        })
      }
    }, this.putStatesTime)
  }

  /** 清除指定持久化任务在内存中的 checkpoint 所有权和旧版摘要缓存。 */
  private invalidateTaskOwnership(taskId: number) {
    this.invalidatedRestoreTaskIds.add(taskId)
    this.legacySummaryCache.delete(taskId)
    if (this.currentMeta?.id === taskId) {
      this.currentMeta = null
    }
    if (this.taskId === taskId) {
      this.taskId = 0
      this.needPutStates = false
    }
  }

  private async clearData(ev: string) {
    // 即使初次保存尚未取得 taskId，也必须先取消本标签页所有排队/进行中的保存。
    this.persistenceGeneration++
    if (!this.taskId) {
      return
    }
    const meta = (await this.IDB.get(this.metaName, this.taskId)) as TaskMeta
    if (!meta) {
      this.invalidateTaskOwnership(this.taskId)
      return
    }

    const taskId = this.taskId
    this.invalidateTaskOwnership(taskId)
    await this.deleteTaskRecords(meta)

    // 当因为停止下载而清除保存的抓取结果时，显示提示，让用户知道这个机制
    if (ev === EVT.list.downloadStop) {
      log.warning(lang.transl('_已清除这个URL里保存的抓取结果'))
    }
  }

  // 清除过期的数据
  private async clearExired() {
    // 数据的过期时间，设置为 30 天。30*24*60*60*1000
    const expiryTime = 2592000000

    // 每隔一天检查一次数据是否过期
    const nowTime = Date.now()
    let lastCheckTime = 0
    const storeName = 'lastCheckExired'
    const data = localStorage.getItem(storeName)
    if (data === null) {
      localStorage.setItem(storeName, lastCheckTime.toString())
    } else {
      lastCheckTime = Number.parseInt(data)
    }
    if (nowTime - lastCheckTime < 86400000) {
      return
    }
    localStorage.setItem(storeName, nowTime.toString())

    // 检查数据是否过期
    const callback = (item: IDBCursorWithValue | null) => {
      if (item) {
        const data = item.value as TaskMeta
        if (nowTime - data.id > expiryTime) {
          // 先释放内存 ownership，再以一个跨表事务删除完整任务。
          this.invalidateTaskOwnership(data.id)
          void this.deleteTaskRecords(data)
        }
        item.continue()
      }
    }

    this.IDB.openCursor(this.metaName, callback)
  }

  private summarizeStates(values: DLStatesI): DLStateSummary {
    const summary: DLStateSummary = {
      total: values.length,
      pending: 0,
      inProgress: 0,
      completed: 0,
    }
    for (const value of values) {
      if (value === -1) summary.pending++
      else if (value === 0) summary.inProgress++
      else if (value === 1) summary.completed++
    }
    return summary
  }

  // 统一去掉 hash，保证持久化 key 与恢复/状态查询使用相同 URL。
  private normalizeURL(url: string) {
    return url.split('#')[0]
  }

  // 处理本页面的 url
  private getURL() {
    return this.normalizeURL(window.location.href)
  }

  // 在数字后面追加数字
  // 用于在 task id  后面追加序号数字(part)
  private numAppendNum(id: number, num: number) {
    return parseInt(id.toString() + num)
  }

  // 根据 taskMeta 里的 id 和 part 数量，生成 taskData 里对应的数据的 id 列表
  private createIdList(taskid: number, part: number) {
    // part 记录数据分成了几部分，所以是从 1 开始的，而不是从 0 开始
    // 生成的 id 的结尾是从 0 开始增加的
    const arr = []
    let start = 0
    while (start < part) {
      arr.push(this.numAppendNum(taskid, start))
      start++
    }
    return arr
  }

  // 清空已保存的抓取结果
  private async clearSavedCrawl() {
    this.restoreGeneration++
    this.persistenceGeneration++
    this.restorePending = false
    this.currentMeta = null
    this.needPutStates = false
    this.taskId = 0
    this.legacySummaryCache.clear()
    await this.IDB.incrementFieldAndClear(
      this.controlName,
      this.controlKey,
      'generation',
      [this.metaName, this.dataName, this.statesName]
    )
    toast.success(lang.transl('_数据清除完毕'))
  }
}

/** 断点续传模块单例。 */
const resume = new Resume()
export { resume }
