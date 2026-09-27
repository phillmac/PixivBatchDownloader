import browser from 'webextension-polyfill'

export const DOWNLOAD_DIAGNOSTIC_TIMEOUT_MS = 300000
const EVENT_LIMIT = 240
const PROGRESS_EVENT_INTERVAL_MS = 30000
const WATCHDOG_REFRESH_INTERVAL_MS = 1000
const FALLBACK_ELEMENT_ID = 'xz-download-hang-diagnostic'

export interface DownloadDiagnosticContext {
  workId: string
  index: number
  progressBarIndex: number
  taskBatch: number
  workType: number
}

interface DiagnosticEvent {
  at: string
  elapsedMs: number
  diagnosticId: string
  stage: string
  details?: Record<string, unknown>
}

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

type PageStateProvider = () => Record<string, unknown>

class DownloadDiagnostics {
  private sequence = 0
  private readonly active = new Map<string, ActiveTask>()
  private readonly events: DiagnosticEvent[] = []
  private readonly watchdogs = new Map<string, number>()
  private pageStateProvider: PageStateProvider = () => ({})

  constructor() {
    browser.runtime.onMessage.addListener((msg: any) => {
      if (msg?.msg === 'get_download_diagnostics') {
        return this.getReport()
      }
    })
  }

  public setPageStateProvider(provider: PageStateProvider) {
    this.pageStateProvider = provider
  }

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

  public finishAll(outcome: string) {
    for (const diagnosticId of [...this.active.keys()]) {
      this.finish(diagnosticId, outcome)
    }
  }

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

  public async getReport() {
    let worker: unknown
    try {
      worker = await browser.runtime.sendMessage({
        msg: 'get_download_worker_diagnostics',
      })
    } catch (error) {
      worker = { unavailable: true, error: this.errorDetails(error) }
    }
    return { ...this.pageSnapshot(), worker }
  }

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

  private clearWatchdog(diagnosticId: string) {
    const timer = this.watchdogs.get(diagnosticId)
    if (timer !== undefined) window.clearTimeout(timer)
    this.watchdogs.delete(diagnosticId)
  }

  private async persistHangSnapshot(diagnosticId: string) {
    const page = this.pageSnapshot()
    this.writeFallbackSnapshot(page)
    console.warn('[Powerful Pixiv Downloader] suspected download hang', page)
    try {
      const report = await this.getReport()
      await browser.runtime.sendMessage({
        msg: 'record_download_hang_diagnostic',
        diagnosticId,
        report,
      })
    } catch (error) {
      console.error('Unable to persist download hang diagnostics', error)
    }
  }

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

const downloadDiagnostics = new DownloadDiagnostics()
export { downloadDiagnostics }
