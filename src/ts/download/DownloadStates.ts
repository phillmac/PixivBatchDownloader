import { EVT } from '../EVT'
import { store } from '../store/Store'

// 每个任务会在数组中的对应位置用一个数字表示它的下载状态。数字和含义：
// -1 未开始下载
// 0 下载中
// 1 下载完成
type DLStatesI = (-1 | 0 | 1)[]

interface DLStateSummary {
  total: number
  pending: number
  inProgress: number
  completed: number
}

// 下载状态列表
class DownloadStates {
  constructor() {
    this.bindEvents()
  }

  public states: DLStatesI = []
  private pending = 0
  private inProgress = 0
  private completed = 0

  private bindEvents() {
    // 初始化下载状态
    const evs = [EVT.list.crawlComplete, EVT.list.resultChange]
    for (const ev of evs) {
      window.addEventListener(ev, () => {
        this.init()
      })
    }
  }

  // 创建新的状态列表
  public init() {
    this.states = new Array(store.result.length).fill(-1)
    this.pending = this.states.length
    this.inProgress = 0
    this.completed = 0
  }

  // 统计下载完成的数量
  public downloadedCount() {
    return this.completed
  }

  // 返回无需遍历完整队列即可读取的状态摘要。
  public summary(): DLStateSummary {
    return {
      total: this.states.length,
      pending: this.pending,
      inProgress: this.inProgress,
      completed: this.completed,
    }
  }

  // 接受传入的状态数据
  // 目前只有在恢复下载的时候使用
  public replace(states: DLStatesI) {
    this.states = states
    this.pending = 0
    this.inProgress = 0
    this.completed = 0
    for (const value of states) {
      if (value === -1) this.pending++
      else if (value === 0) this.inProgress++
      else if (value === 1) this.completed++
    }
  }

  // 恢复之前的下载任务
  // 这会把之前的“下载中”标记复位到“未开始下载”，以便再次下载
  public resume() {
    const length = this.states.length
    for (let i = 0; i < length; i++) {
      if (this.states[i] === 0) {
        this.setState(i, -1)
      }
    }
  }

  // 获取第一个“未开始下载”标记的索引
  public getFirstDownloadItem() {
    const length = this.states.length
    for (let i = 0; i < length; i++) {
      if (this.states[i] === -1) {
        this.setState(i, 0)
        return i
      }
    }
    return undefined
  }

  // 设置已下载列表中的标记
  public setState(index: number, value: -1 | 0 | 1) {
    const previous = this.states[index]
    if (previous === value) return
    if (previous === -1) this.pending--
    else if (previous === 0) this.inProgress--
    else if (previous === 1) this.completed--
    this.states[index] = value
    if (value === -1) this.pending++
    else if (value === 0) this.inProgress++
    else this.completed++
  }

  public clear() {
    this.states = []
    this.pending = 0
    this.inProgress = 0
    this.completed = 0
  }
}

const downloadStates = new DownloadStates()
export { downloadStates, DLStatesI, DLStateSummary }
