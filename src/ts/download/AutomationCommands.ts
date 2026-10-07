import { PageName, pageType } from '../PageType'
import { states } from '../store/States'
import { store } from '../store/Store'
import { getAutomationStatus } from './AutomationStatus'
import {
  getAutomationCommandBindings,
  consumeAutomationCommandToken,
} from './AutomationCommandBindings'
import {
  getManagedCrawlArm,
  managedCrawlRequiresReload,
  managedCrawlBlocksDownload,
  getManagedCrawl,
} from './ManagedCrawlAutomation'

/** 仅开放编排使用的五个命令；托管抓取停止继续使用 abort API。 */
type AutomationCommand =
  | 'crawl.start'
  | 'crawl.stop'
  | 'download.start'
  | 'download.pause'
  | 'download.stop'
/** URL 和单次许可必须来自当前文档的只读准备查询。 */
type CommandRequest = {
  command: AutomationCommand
  url: string
  token: string
  operationId?: string
}
/** 与托管操作保持一致，只忽略 fragment。 */
function currentUrl() {
  return window.location.href.split('#')[0]
}
/** 限定与普通 readyCrawl 同义的页面，排除其他特殊抓取按钮。 */
function profilePageType() {
  const url = new URL(currentUrl())
  if (url.origin !== 'https://www.pixiv.net') return null
  if (
    /^\/(?:en\/)?users\/\d+\/request(?:\/(?:artworks|novels|sent(?:\/(?:artworks|novels))?))?$/.test(
      url.pathname
    )
  )
    return PageName.UserRequest
  if (
    /^\/(?:en\/)?users\/\d+\/bookmarks\/(?:artworks|novels)\/?$/.test(
      url.pathname
    )
  )
    return PageName.Bookmark
  if (
    /^\/(?:en\/)?users\/\d+(?:\/(?:artworks|illustrations|manga|novels))?\/?$/.test(
      url.pathname
    )
  )
    return PageName.UserHome
  return null
}
/** 只读准备查询；上下文出现或按钮挂载不等于初始化完成。 */
export async function getAutomationCommands() {
  const before = getAutomationCommandBindings().token
  const url = currentUrl()
  const status = await getAutomationStatus()
  const bindings = getAutomationCommandBindings()
  const stable = before === bindings.token && url === currentUrl()
  return {
    apiVersion: 1,
    url,
    token: before,
    ready: stable && states.settingInitialized && !!bindings.download,
    crawlReady:
      stable &&
      !!bindings.crawl &&
      bindings.crawl.pageType === pageType.type &&
      profilePageType() === pageType.type,
    downloadReady: stable && !!bindings.download?.prepared(),
    status,
  }
}
/** 检查许可后同步调用原生控制器；回执不冒充抓取或文件保存完成。 */
export async function runAutomationCommand(request: CommandRequest) {
  if (
    !request ||
    ![
      'crawl.start',
      'crawl.stop',
      'download.start',
      'download.pause',
      'download.stop',
    ].includes(request.command) ||
    typeof request.url !== 'string' ||
    typeof request.token !== 'string'
  )
    throw new TypeError('Invalid automation command request')
  const refused = (reason: string) => ({
    apiVersion: 1,
    command: request.command,
    outcome: 'refused' as const,
    state: null,
    reason,
  })
  if (request.url.split('#')[0] !== currentUrl()) return refused('url-mismatch')
  if (request.token !== getAutomationCommandBindings().token)
    return refused('stale-token')
  const snapshot = await getAutomationCommands()
  // 所有异步读取之后再次检查。没有 await 位于最后检查与命令消费之间。
  if (request.url.split('#')[0] !== currentUrl()) return refused('url-mismatch')
  if (request.token !== getAutomationCommandBindings().token)
    return refused('stale-token')
  if (!snapshot.ready) return refused('not-ready')
  const bindings = getAutomationCommandBindings()
  if (request.command === 'crawl.start') {
    const arm = getManagedCrawlArm()
    if (
      !arm ||
      arm.operationId !== request.operationId ||
      arm.url !== currentUrl()
    )
      return refused('ownership-mismatch')
    if (managedCrawlRequiresReload()) return refused('reload-required')
    if (
      states.bookmarkMode ||
      states.crawlTagList ||
      states.quickCrawl ||
      states.timedCrawlMode
    )
      return refused('non-default-crawl-mode')
    if (!snapshot.crawlReady || !bindings.crawl)
      return refused('unsupported-page')
    if (states.busy || snapshot.status.phase !== 'IDLE')
      return refused('busy-or-existing-task')
    // 不弹出覆盖已有未下载队列的确认窗口。
    if (
      store.result.length &&
      states.crawlCompleteTime > states.downloadCompleteTime
    )
      return refused('existing-results')
    consumeAutomationCommandToken()
    // readyCrawl 在第一个 await 之前发出 crawlStart；后续网络请求仍由原生流程负责。
    void bindings.crawl.start().catch((error: unknown) => console.error(error))
    const owned = getManagedCrawl()
    if (
      owned?.operationId !== request.operationId ||
      owned.state !== 'crawling'
    )
      return refused('not-started')
    return {
      apiVersion: 1,
      command: request.command,
      outcome: 'accepted' as const,
      state: 'pending' as const,
      reason: null,
      operationId: owned.operationId,
      url: owned.url,
    }
  }
  if (request.command === 'crawl.stop') {
    if (!bindings.stopCrawl) return refused('not-ready')
    if (getManagedCrawl()?.state === 'crawling')
      return refused('use-managed-abort')
    if (!states.busy || snapshot.status.phase !== 'CRAWLING')
      return refused('not-crawling')
    if ((store.URLWhenCrawlStart || '').split('#')[0] !== currentUrl())
      return refused('queue-url-mismatch')
    consumeAutomationCommandToken()
    bindings.stopCrawl()
    return {
      apiVersion: 1,
      command: request.command,
      outcome: 'accepted' as const,
      state: 'pending' as const,
      reason: null,
      url: currentUrl(),
    }
  }
  if (!bindings.download) return refused('not-ready')
  const taskUrl = (store.URLWhenCrawlStart || '').split('#')[0]
  if (taskUrl !== currentUrl()) return refused('queue-url-mismatch')
  if (managedCrawlBlocksDownload()) return refused('revoked-crawl')
  const phase = snapshot.status.phase
  if (request.command === 'download.start') {
    if (!snapshot.downloadReady) return refused('not-ready')
    if (
      states.busy ||
      !['READY', 'PAUSED_RESUMABLE', 'STOPPED'].includes(phase)
    )
      return refused('not-startable')
    if (!store.result.length) return refused('empty-queue')
  } else if (!states.downloading || phase !== 'DOWNLOADING') {
    return refused('not-downloading')
  }
  consumeAutomationCommandToken()
  if (request.command === 'download.start') bindings.download.start()
  else if (request.command === 'download.pause') bindings.download.pause()
  else bindings.download.stop()
  if (request.command === 'download.start' && !states.downloading)
    return refused('not-started')
  if (request.command !== 'download.start' && states.downloading)
    return refused('not-stopped')
  // 暂停/停止发出生命周期事件时，在途文件仍可能完成，回执始终是 pending。
  return {
    apiVersion: 1,
    command: request.command,
    outcome: 'accepted' as const,
    state: 'pending' as const,
    reason: null,
    url: taskUrl,
  }
}
/** 撤销尚未消费的精确许可。已消费/替换同样保证该许可不能再启动迟到命令。 */
export function invalidateAutomationCommand(token: string) {
  if (typeof token !== 'string' || !token)
    throw new TypeError('Invalid command token')
  const matches = token === getAutomationCommandBindings().token
  if (matches) consumeAutomationCommandToken()
  return {
    apiVersion: 1,
    token,
    outcome: matches ? ('invalidated' as const) : ('superseded' as const),
  }
}
/** 与状态 API 一样只挂载在扩展的 isolated world。 */
const automationGlobal = globalThis as typeof globalThis & {
  __PBD_AUTOMATION_COMMANDS__?: typeof getAutomationCommands
  __PBD_AUTOMATION_COMMAND__?: typeof runAutomationCommand
  __PBD_AUTOMATION_INVALIDATE_COMMAND__?: typeof invalidateAutomationCommand
}
automationGlobal.__PBD_AUTOMATION_COMMANDS__ = getAutomationCommands
automationGlobal.__PBD_AUTOMATION_COMMAND__ = runAutomationCommand

automationGlobal.__PBD_AUTOMATION_INVALIDATE_COMMAND__ =
  invalidateAutomationCommand
