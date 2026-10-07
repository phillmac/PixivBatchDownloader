import { EVT } from '../EVT'

/** 仅绑定已审计的用户主页/收藏页/约稿页抓取控制器。 */
let crawl: { pageType: number; start: () => Promise<void> } | null = null
/** 下载控制器只提供三个原生命令及准备状态。 */
let download: {
  start: () => void
  pause: () => void
  stop: () => void
  prepared: () => boolean
} | null = null
/** 普通抓取停止沿用控制器的事件与 stopCrawl 标记。 */
let stopCrawl: (() => void) | null = null
/** 文档随机标记避免刷新后复用旧命令许可。 */
const documentId = crypto.getRandomValues(new Uint32Array(4)).join('-')
/** 生命周期事件使旧许可失效；同一许可最多执行一次命令。 */
let revision = 0

/** 页面控制器初始化完毕后登记原生方法，不保存 DOM 元素。 */
export function registerAutomationCrawl(
  pageType: number,
  start: () => Promise<void>
) {
  crawl = { pageType, start }
  revision++
}
/** 下载控制器和事件监听器初始化完毕后登记原生方法。 */
export function registerAutomationDownload(
  commands: NonNullable<typeof download>
) {
  download = commands
  revision++
}
/** 登记原生抓取停止命令，不绕过其状态标记。 */
export function registerAutomationCrawlStop(stop: () => void) {
  stopCrawl = stop
  revision++
}
/** 读取同步注册状态和单次许可。 */
export function getAutomationCommandBindings() {
  return { crawl, download, stopCrawl, token: `${documentId}:${revision}` }
}
/** 调用前消费许可；拒绝或异常后也不自动重试。 */
export function consumeAutomationCommandToken() {
  revision++
}
window.addEventListener(EVT.list.pageSwitchedTypeChange, () => {
  crawl = null
  revision++
})
for (const event of [
  EVT.list.pageSwitch,
  EVT.list.crawlStart,
  EVT.list.crawlComplete,
  EVT.list.crawlEmpty,
  EVT.list.stopCrawl,
  EVT.list.resultChange,
  EVT.list.resume,
  EVT.list.downloadStart,
  EVT.list.downloadPause,
  EVT.list.downloadStop,
  EVT.list.downloadComplete,
]) {
  window.addEventListener(event, () => revision++)
}
