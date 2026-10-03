import browser from 'webextension-polyfill'

/** 单个诊断阶段允许无进展的最长时间。 */
export const DOWNLOAD_DIAGNOSTIC_TIMEOUT_MS = 300000
/** 页面侧最近事件的最大保留数量。 */
const EVENT_LIMIT = 240
/** 下载进度事件写入诊断环形缓冲区的最小间隔。 */
const PROGRESS_EVENT_INTERVAL_MS = 30000
/** 有字节进展时刷新卡住计时器的最小间隔。 */
const WATCHDOG_REFRESH_INTERVAL_MS = 1000
/** 页面侧诊断回退快照使用的 DOM 元素 id。 */
const FALLBACK_ELEMENT_ID = 'xz-download-hang-diagnostic'

/** 建立下载诊断任务所需的稳定上下文。 */
export interface DownloadDiagnosticContext {
  workId: string
  index: number
  progressBarIndex: number
  taskBatch: number
  workType: number
}

/** 页面侧诊断事件。 */
interface DiagnosticEvent {
  at: string
  elapsedMs: number
  diagnosticId: string
  stage: string
  details?: Record<string, unknown>
}

/** 页面侧仍在运行的诊断任务。 */
interface ActiveTask extends DownloadDiagnosticContext {
  diagnosticId: string
  startedAt: string
  startedMs: number
  stage: string
  stageAt: string
  stageMs: number
  fileName?: string
  loaded?: number
  total?: number
  lastProgressAt?: string
  lastProgressMs?: number
  lastProgressEventMs?: number
  lastWatchdogRefreshMs?: number
  timeline: { stage: string; at: string; elapsedMs: number }[]
}

/** 提供完整下载诊断控制器状态的只读回调。 */
type PageStateProvider = () => Record<string, unknown>
/** 提供高频自动化轮询所需轻量状态的只读回调。 */
type AutomationStateProvider = () => Record<string, unknown>

/** 手动请求当前页面下载诊断报告的 runtime 消息。 */
interface GetDownloadDiagnosticsMessage {
  msg: 'get_download_diagnostics'
}

/** 判断未知 runtime 消息是否是页面诊断快照请求。 */
function isGetDownloadDiagnosticsMessage(
  msg: unknown
): msg is GetDownloadDiagnosticsMessage {
  return (
    !!msg &&
    typeof msg === 'object' &&
    (msg as Record<string, unknown>).msg === 'get_download_diagnostics'
  )
}

/** 跟踪页面侧下载阶段，并在疑似卡住时保留诊断状态。 */
class DownloadDiagnostics {
  /** 当前页面内诊断 id 的递增序号。 */
  private sequence = 0
  /** 当前仍在运行的页面侧下载诊断任务。 */
  private readonly active = new Map<string, ActiveTask>()
  /** 最近的页面侧诊断事件。 */
  private readonly events: DiagnosticEvent[] = []
  /** 每个活动任务当前对应的阶段超时计时器。 */
  private readonly watchdogs = new Map<string, number>()
  /** 获取当前下载控制器状态的回调。 */
  private pageStateProvider: PageStateProvider = () => ({})
  /** 获取自动化轮询轻量状态的回调。 */
  private automationStateProvider: AutomationStateProvider = () => ({})

  /** 注册只读诊断快照消息处理器。 */
  constructor() {
    browser.runtime.onMessage.addListener((msg: unknown) => {
      if (isGetDownloadDiagnosticsMessage(msg)) {
        return this.getReport()
      }
    })
  }

  /** 设置用于快照的下载控制器状态提供器。 */
  public setPageStateProvider(provider: PageStateProvider) {
    this.pageStateProvider = provider
  }

  /** 设置高频自动化轮询使用的轻量状态提供器。 */
  public setAutomationStateProvider(provider: AutomationStateProvider) {
    this.automationStateProvider = provider
  }

  /** 返回不复制任务列表/下载状态数组的轻量自动化状态。 */
  public automationSnapshot() {
    return this.automationStateProvider()
  }

  /** 建立一个新的页面侧下载诊断任务。 */
  public start(context: DownloadDiagnosticContext) {
    const diagnosticId = `${context.taskBatch}:${context.index}:${++this.sequence}`
    const now = performance.now()
    const at = new Date().toISOString()
    this.active.set(diagnosticId, {
      ...context,
      diagnosticId,
      startedAt: at,
      startedMs: now,
      stage: 'created',
      stageAt: at,
      stageMs: now,
      timeline: [{ stage: 'created', at, elapsedMs: 0 }],
    })
    this.record(diagnosticId, 'created')
    this.arm(diagnosticId)
    return diagnosticId
  }

  /** 记录任务进入新的诊断阶段，并重新启动阶段看门狗。 */
  public enter(
    diagnosticId: string,
    stage: string,
    details?: Record<string, unknown>
  ) {
    const task = this.active.get(diagnosticId)
    if (!task) return
    const now = performance.now()
    task.stage = stage
    task.stageAt = new Date().toISOString()
    task.stageMs = now
    task.timeline.push({
      stage,
      at: task.stageAt,
      elapsedMs: Math.round(now - task.startedMs),
    })
    if (task.timeline.length > 32) task.timeline.shift()
    if (typeof details?.fileName === 'string') task.fileName = details.fileName
    this.record(diagnosticId, stage, details)
    this.arm(diagnosticId)
  }

  /** 记录字节进展，并在不过量记录事件的情况下刷新看门狗。 */
  public progress(
    diagnosticId: string,
    loaded: number,
    total: number,
    fileName?: string
  ) {
    const task = this.active.get(diagnosticId)
    if (!task) return
    const now = performance.now()
    task.loaded = loaded
    task.total = total
    task.lastProgressAt = new Date().toISOString()
    task.lastProgressMs = now
    if (fileName) task.fileName = fileName

    if (
      task.lastWatchdogRefreshMs === undefined ||
      now - task.lastWatchdogRefreshMs >= WATCHDOG_REFRESH_INTERVAL_MS
    ) {
      task.lastWatchdogRefreshMs = now
      this.arm(diagnosticId)
    }

    if (
      task.lastProgressEventMs === undefined ||
      now - task.lastProgressEventMs >= PROGRESS_EVENT_INTERVAL_MS
    ) {
      task.lastProgressEventMs = now
      this.record(diagnosticId, 'body-progress', { loaded, total, fileName })
    }
  }

  /** 完成一个诊断任务并取消其看门狗。 */
  public finish(
    diagnosticId: string,
    outcome: string,
    details?: Record<string, unknown>
  ) {
    if (!this.active.has(diagnosticId)) return
    this.record(diagnosticId, outcome, details)
    this.clearWatchdog(diagnosticId)
    this.active.delete(diagnosticId)
  }

  /** 以相同结果完成所有页面侧诊断任务。 */
  public finishAll(outcome: string) {
    for (const diagnosticId of [...this.active.keys()]) {
      this.finish(diagnosticId, outcome)
    }
  }

  /** 把未知异常转换为可序列化的诊断信息。 */
  public errorDetails(error: unknown) {
    if (error && typeof error === 'object') {
      const value = error as Record<string, unknown>
      return {
        name: typeof value.name === 'string' ? value.name : 'Error',
        message:
          typeof value.message === 'string' ? value.message : String(error),
        stack: typeof value.stack === 'string' ? value.stack : undefined,
      }
    }
    return { name: 'Error', message: String(error) }
  }

  /** 同步捕获当前页面和下载控制器状态。 */
  public pageSnapshot() {
    const now = performance.now()
    return {
      schemaVersion: 1,
      diagnosticsVersion: 'download-hang-v1',
      capturedAt: new Date().toISOString(),
      page: {
        url: location.href,
        title: document.title,
        visibilityState: document.visibilityState,
      },
      controller: this.pageStateProvider(),
      activeTasks: [...this.active.values()].map((task) => ({
        ...task,
        startedMs: undefined,
        stageMs: undefined,
        lastProgressMs: undefined,
        lastProgressEventMs: undefined,
        lastWatchdogRefreshMs: undefined,
        elapsedMs: Math.round(now - task.startedMs),
        stageElapsedMs: Math.round(now - task.stageMs),
        lastProgressAgeMs:
          task.lastProgressMs === undefined
            ? undefined
            : Math.round(now - task.lastProgressMs),
      })),
      recentEvents: this.events.slice(),
    }
  }

  /** 把固定的页面快照与异步 service worker 快照组合成诊断报告。 */
  public async getReport(page = this.pageSnapshot()) {
    let worker: unknown
    try {
      worker = await browser.runtime.sendMessage({
        msg: 'get_download_worker_diagnostics',
      })
    } catch (error) {
      worker = { unavailable: true, error: this.errorDetails(error) }
    }
    return { ...page, worker }
  }

  /** 向有界页面事件缓冲区追加一个诊断事件。 */
  private record(
    diagnosticId: string,
    stage: string,
    details?: Record<string, unknown>
  ) {
    const task = this.active.get(diagnosticId)
    this.events.push({
      at: new Date().toISOString(),
      elapsedMs: task ? Math.round(performance.now() - task.startedMs) : 0,
      diagnosticId,
      stage,
      details,
    })
    if (this.events.length > EVENT_LIMIT) {
      this.events.splice(0, this.events.length - EVENT_LIMIT)
    }
  }

  /** 为任务当前阶段启动或重置卡住看门狗。 */
  private arm(diagnosticId: string) {
    this.clearWatchdog(diagnosticId)
    const task = this.active.get(diagnosticId)
    if (!task) return
    const stage = task.stage
    const timer = window.setTimeout(() => {
      const current = this.active.get(diagnosticId)
      if (!current || current.stage !== stage) return
      this.record(diagnosticId, 'stage-timeout', {
        stage,
        stageElapsedMs: Math.round(performance.now() - current.stageMs),
      })
      void this.persistHangSnapshot(diagnosticId)
    }, DOWNLOAD_DIAGNOSTIC_TIMEOUT_MS)
    this.watchdogs.set(diagnosticId, timer)
  }

  /** 清除一个任务的阶段看门狗。 */
  private clearWatchdog(diagnosticId: string) {
    const timer = this.watchdogs.get(diagnosticId)
    if (timer !== undefined) window.clearTimeout(timer)
    this.watchdogs.delete(diagnosticId)
  }

  /** 在阶段超时时先保留页面状态，再异步组合并持久化完整报告。 */
  private async persistHangSnapshot(diagnosticId: string) {
    const page = this.pageSnapshot()
    this.writeFallbackSnapshot(page)
    console.warn('[Powerful Pixiv Downloader] suspected download hang', page)
    try {
      const report = await this.getReport(page)
      await browser.runtime.sendMessage({
        msg: 'record_download_hang_diagnostic',
        diagnosticId,
        report,
      })
    } catch (error) {
      console.error('Unable to persist download hang diagnostics', error)
    }
  }

  /** 将页面侧回退快照写入 DOM，避免扩展消息链本身故障时丢失证据。 */
  private writeFallbackSnapshot(
    page: ReturnType<DownloadDiagnostics['pageSnapshot']>
  ) {
    let element = document.getElementById(FALLBACK_ELEMENT_ID)
    if (!element) {
      element = document.createElement('script')
      element.id = FALLBACK_ELEMENT_ID
      element.setAttribute('type', 'application/json')
      document.documentElement.append(element)
    }
    element.textContent = JSON.stringify(page)
  }
}

/** 页面侧下载诊断单例。 */
const downloadDiagnostics = new DownloadDiagnostics()
export { downloadDiagnostics }
