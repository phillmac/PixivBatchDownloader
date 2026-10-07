import browser from 'webextension-polyfill'
import { Config } from '../Config'
import { PageName, pageType } from '../PageType'
import { states } from '../store/States'
import { settings, settingPersistence } from './Settings'

/** 仅开放编排需要的控制；快捷下载的自动启动是独立设置。 */
export type AutomationSettingKey =
  | 'crawlNumber'
  | 'DonotCrawlAlreadyDownloadedWorks'
  | 'deduplication'
  | 'autoStartDownload'
  | 'autoStartDownloadForQuickDownload'

/** 抓取限制始终带页面类型，默认使用当前页面类型。 */
type SettingOptions = { pageType?: PageName }

/** 本标签页的 API 写入串行执行；跨标签页由后台串行持久化。 */
let queue: Promise<unknown> = Promise.resolve()

/** 检查运行时传入的 key，避免 CDP 绕过 TypeScript 白名单。 */
function validateKey(key: AutomationSettingKey) {
  if (
    ![
      'crawlNumber',
      'DonotCrawlAlreadyDownloadedWorks',
      'deduplication',
      'autoStartDownload',
      'autoStartDownloadForQuickDownload',
    ].includes(key)
  ) {
    throw new Error('Unsupported automation setting')
  }
  if (!settingPersistence.isRestored())
    throw new Error('Settings are not initialized')
}

/** 读取当前标签页有效值与存储值，不修改或强制同步其他设置。 */
export async function getAutomationSetting(
  key: AutomationSettingKey,
  options: SettingOptions = {}
) {
  validateKey(key)
  await settingPersistence.flush()
  const page = options.pageType ?? pageType.type
  const cfg = key === 'crawlNumber' ? settings.crawlNumber[page] : null
  if (key === 'crawlNumber' && (!Number.isInteger(page) || !cfg))
    throw new Error('Unsupported crawl page type')
  const data = await browser.storage.local.get(Config.settingStoreName)
  const stored = data[Config.settingStoreName] as
    Partial<typeof settings> | undefined
  const effectiveValue = cfg ? cfg.value : settings[key]
  const persistedValue = cfg
    ? stored?.crawlNumber?.[page]?.value
    : stored?.[key]
  return {
    apiVersion: 1,
    key,
    pageType: cfg ? page : null,
    pageTypeName: cfg ? PageName[page] : null,
    unit: cfg ? (cfg.page ? 'pages' : cfg.work ? 'works' : 'none') : null,
    min: cfg?.min ?? null,
    max: cfg?.max ?? null,
    supportsUnbounded: cfg ? cfg.max === -1 : false,
    effectiveValue,
    persistedValue: persistedValue ?? null,
    persisted: persistedValue !== undefined,
    verified: Object.is(persistedValue, effectiveValue),
    requiresReload: false,
    crossTab: {
      policy: settings.settingsAcrossDifferentTabs,
      propagation:
        settings.settingsAcrossDifferentTabs === 'synchronizeChanges'
          ? 'storage-event'
          : 'disabled',
      acknowledged: false,
    },
  }
}

/** 严格验证控制值，持久化后通知当前运行时，并读回验证。 */
export function setAutomationSetting(
  key: AutomationSettingKey,
  value: number | boolean,
  options: SettingOptions = {}
) {
  const result = queue.then(async () => {
    validateKey(key)
    if (states.busy)
      throw new Error('Cannot change automation settings while PPBD is busy')
    const previous = await getAutomationSetting(key, options)
    if (key === 'crawlNumber') {
      const page = previous.pageType!
      const cfg = settings.crawlNumber[page]
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        (!cfg.work && !cfg.page) ||
        (value === -1
          ? cfg.max !== -1
          : value < cfg.min || (cfg.max !== -1 && value > cfg.max))
      ) {
        throw new Error('Invalid crawl limit for this page type')
      }
      await settingPersistence.persistControl(key, { ...cfg, value }, page)
    } else {
      if (typeof value !== 'boolean')
        throw new Error('Automation setting requires a boolean')
      await settingPersistence.persistControl(key, value)
    }
    const current = await getAutomationSetting(key, options)
    if (!current.verified || !Object.is(current.effectiveValue, value))
      throw new Error('Automation setting verification failed')
    return {
      ...current,
      previousValue: previous.effectiveValue,
      previousPersistedValue: previous.persistedValue,
      requestedValue: value,
    }
  })
  queue = result.catch(() => undefined)
  return result
}

/** 与其他自动化 API 相同，仅在 PPBD 内容脚本的隔离上下文开放。 */
const automationGlobal = globalThis as typeof globalThis & {
  __PBD_AUTOMATION_GET_SETTING__?: typeof getAutomationSetting
  __PBD_AUTOMATION_SET_SETTING__?: typeof setAutomationSetting
}
automationGlobal.__PBD_AUTOMATION_GET_SETTING__ = getAutomationSetting
automationGlobal.__PBD_AUTOMATION_SET_SETTING__ = setAutomationSetting
