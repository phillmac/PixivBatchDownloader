/** 抓取写入所有权；新抓取自动使旧回调失效。 */
export type CrawlGeneration = number & {
  readonly crawlGeneration: unique symbol
}
/** 单调递增的抓取序号。 */
let sequence = 0
/** 当前允许写入的抓取。 */
let active: CrawlGeneration | null = null
/** 创建并激活真实抓取的写入所有权。 */
export function beginCrawl(): CrawlGeneration {
  active = ++sequence as CrawlGeneration
  return active
}
/** 检查捕获的抓取是否仍拥有写入权限。 */
export function ownsCrawl(g: CrawlGeneration) {
  return active === g
}
/** 仅撤销指定抓取，不影响后来创建的抓取。 */
export function revokeCrawl(g: CrawlGeneration) {
  if (active === g) active = null
}
/** 供同步 crawlStart 监听器绑定当前抓取。 */
export function currentCrawl() {
  return active
}
/** 可信的非抓取队列重建必须显式声明写入来源。 */
export const replacementOwner = 'replacement' as const
