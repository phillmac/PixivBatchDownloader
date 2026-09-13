/** 可导出的异常信息，保留 worker 和跨 realm 异常的名称、消息与堆栈 */
export interface APNGErrorInfo {
  name: string
  message: string
  stack?: string
  cause?: APNGErrorInfo
}

/** 将异常转为普通数据，不依赖跨 realm 的 instanceof Error */
export function describeAPNGError(error: unknown, depth = 0): APNGErrorInfo {
  if (error !== null && typeof error === 'object') {
    const value = error as Record<string, unknown>
    return {
      name: typeof value.name === 'string' ? value.name : 'Error',
      message:
        typeof value.message === 'string' ? value.message : String(error),
      stack: typeof value.stack === 'string' ? value.stack : undefined,
      cause:
        value.cause !== undefined && depth < 2
          ? describeAPNGError(value.cause, depth + 1)
          : undefined,
    }
  }
  return { name: 'Error', message: String(error) }
}

/** 每次转换单独保存少量诊断数据，不保留 ZIP、位图或像素缓冲区 */
export class APNGDiagnostics {
  /** 本次转换开始的墙上时间，用于比较多次重试 */
  private readonly startedAt = new Date().toISOString()
  /** 本次转换的单调时钟起点 */
  private readonly started = performance.now()
  /** 转换开始时的主线程堆内存快照（浏览器支持时） */
  private readonly initialHeap = this.readHeap()
  /** 当前阶段，包括等待转换配额的时间 */
  private stage = 'wait-conversion-slot'
  /** 阶段时间线；逐帧进度只更新 details，避免产生大量日志 */
  private readonly timeline = [{ stage: this.stage, elapsedMs: 0 }]
  /** 本次转换的标量与元数据 */
  public readonly details: Record<string, unknown> = {}

  /** 复制本次任务的元信息 */
  constructor(context: Record<string, unknown>) {
    Object.assign(this.details, context)
  }

  /** 标记阶段切换 */
  public enter(stage: string) {
    this.stage = stage
    this.timeline.push({ stage, elapsedMs: this.elapsed() })
  }

  /** 返回本次转换已经经过的毫秒数 */
  private elapsed() {
    return Math.round(performance.now() - this.started)
  }

  /** 读取可选的 Chromium 主线程内存数据；这不是 worker 或进程总内存 */
  private readHeap() {
    const memory = (
      performance as Performance & {
        memory?: {
          usedJSHeapSize: number
          totalJSHeapSize: number
          jsHeapSizeLimit: number
        }
      }
    ).memory
    return memory
      ? {
          usedJSHeapSize: memory.usedJSHeapSize,
          totalJSHeapSize: memory.totalJSHeapSize,
          jsHeapSizeLimit: memory.jsHeapSizeLimit,
        }
      : undefined
  }

  /** 在清理之前记录失败快照，并保留原始异常 */
  public failure(error: unknown) {
    return new APNGConversionError(
      {
        schemaVersion: 1,
        diagnosticsVersion: 'apng-failure-v3',
        startedAt: this.startedAt,
        failedAt: new Date().toISOString(),
        elapsedMs: this.elapsed(),
        stage: this.stage,
        timeline: this.timeline.slice(),
        details: { ...this.details },
        environment: {
          userAgent: navigator.userAgent,
          hardwareConcurrency: navigator.hardwareConcurrency,
          visibilityState: document.visibilityState,
          mainThreadHeapAtStart: this.initialHeap,
          mainThreadHeapAtFailure: this.readHeap(),
        },
        error: describeAPNGError(error),
      },
      error
    )
  }
}

/** APNG 失败快照的结构 */
type APNGFailureReport = {
  schemaVersion: number
  diagnosticsVersion: string
  startedAt: string
  failedAt: string
  elapsedMs: number
  stage: string
  timeline: { stage: string; elapsedMs: number }[]
  details: Record<string, unknown>
  environment: Record<string, unknown>
  error: APNGErrorInfo
}

/** 把诊断快照随异常传递给下载器的日志入口 */
export class APNGConversionError extends Error {
  /** 保留快照与原始异常 */
  constructor(
    public readonly report: APNGFailureReport,
    cause: unknown
  ) {
    super(report.error.message, { cause })
    this.name = 'APNGConversionError'
  }

  /** 用 textContent 转义异常内容，使页面和导出的 HTML 日志都能安全显示 */
  public toLogHTML(label: string) {
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = `${label}: ${this.report.stage} — ${this.report.error.name}: ${this.report.error.message}`
    const pre = document.createElement('pre')
    pre.style.whiteSpace = 'pre-wrap'
    pre.textContent = JSON.stringify(this.report, null, 2)
    details.append(summary, pre)
    return details.outerHTML
  }
}
