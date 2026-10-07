import browser from 'webextension-polyfill'
import { Config } from '../Config'
import {
  canonicalSettingValue,
  mergeSettingPatch,
  SETTING_PATCH_MESSAGE,
} from '../setting/SettingPersistence'

/** 跨标签页串行合并设置，避免整个旧副本覆盖其他设置。 */
let queue: Promise<unknown> = Promise.resolve()

/** 由唯一的 runtime 消息分发器调用，避免多个异步监听器争抢响应。 */
export function handleSettingPatch(message: unknown) {
  if (!message || typeof message !== 'object') return
  const msg = message as Record<string, unknown>
  if (msg.msg !== SETTING_PATCH_MESSAGE) return
  const result = queue.then(async () => {
    if (
      !msg.patch ||
      typeof msg.patch !== 'object' ||
      Array.isArray(msg.patch)
    ) {
      throw new Error('Invalid settings patch')
    }
    const patch = msg.patch as Record<string, unknown>
    const crawlPage = msg.crawlPage
    if (
      crawlPage !== undefined &&
      (!Number.isInteger(crawlPage) || typeof crawlPage !== 'number')
    ) {
      throw new Error('Invalid crawl page')
    }
    const data = await browser.storage.local.get(Config.settingStoreName)
    const next = mergeSettingPatch(
      (data[Config.settingStoreName] || {}) as Record<string, unknown>,
      patch,
      crawlPage as number | undefined
    )
    await browser.storage.local.set({ [Config.settingStoreName]: next })
    const verified = await browser.storage.local.get(Config.settingStoreName)
    if (
      canonicalSettingValue(verified[Config.settingStoreName]) !==
      canonicalSettingValue(next)
    ) {
      throw new Error('Settings persistence verification failed')
    }
    return { persisted: true }
  })
  queue = result.catch(() => undefined)
  return result
}
