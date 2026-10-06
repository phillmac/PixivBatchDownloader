import './CrawlRateCoordinator'
import './ManageFollowing'
import './CheckDownloadCount'
import { DonwloadListData, SendToBackEndData } from '../download/DownloadType'
import browser from 'webextension-polyfill'
import { Config } from '../Config'
import { downloadWorkerDiagnostics } from './DownloadWorkerDiagnostics'

// 当点击扩展图标时，显示/隐藏下载面板
browser.action.onClicked.addListener(function (tab) {
  // 如果在本程序没有权限的页面上点击扩展图标，url 始终是 undefined，此时不发送消息
  if (!tab.url) {
    return
  }

  browser.tabs.sendMessage(tab.id!, {
    msg: 'click_icon',
  })
})

// 当扩展被安装、被更新、或者浏览器升级时，初始化数据
browser.runtime.onInstalled.addListener(() => {
  browser.storage.local.set({ batchNo: {}, idList: {} })
})

// 存储每个下载任务的数据，这是因为下载完成的顺序和前台发送的顺序可能不一致，所以需要把数据保存起来以供使用
const dlData: DonwloadListData = {}
// 当浏览器开始下载一个由前台传递的文件时，会把一些数据保存到 dlData 里
// 当浏览器把这个文件下载完毕之后，从 dlData 里取出保存的数据
// 注意：虽然 Service worker 被回收时，变量也会被清空，但是这对于 dlData 的使用没有影响
// 只要在 Service worker 被回收之前，浏览器把传递给它的文件保存到了硬盘（使该下载项的状态变成 complete)，dlData 里保存的数据也就不再需要使用了，所以即使此时被清空了也无所谓。
// 如果 Service worker 在文件保存的途中就被回收，那么会有影响（文件下载完成之后找不到之前保存的数据了）。但是理论上，浏览器保存文件是很快的，这个 Service worker 不会在此期间被回收，所以不会导致问题。

type batchNoType = { [key: string]: number }
type idListType = { [key: string]: string[] }

/** 页面请求 worker 返回当前下载诊断状态的消息。 */
interface GetDownloadWorkerDiagnosticsMessage {
  msg: 'get_download_worker_diagnostics'
}

/** 页面请求 worker 持久化疑似卡住诊断报告的消息。 */
interface RecordDownloadHangDiagnosticMessage {
  msg: 'record_download_hang_diagnostic'
  report: unknown
}

/** 下载诊断专用的 runtime 消息。 */
type DownloadDiagnosticMessage =
  GetDownloadWorkerDiagnosticsMessage | RecordDownloadHangDiagnosticMessage

/** 使用每个标签页的 tabId 作为索引，储存此标签页里当前下载任务的编号。用来判断不同批次的下载 */
let batchNo: batchNoType = {}

/** 使用每个标签页的 tabId 作为索引，储存此标签页发送到 SW 的每个下载请求的作品 id，用来判断重复的任务 */
let idList: idListType = {}

// batchNo 和 idList 需要持久化存储（但是当浏览器关闭并重新启动时可以清空，因为此时前台的下载任务必然和浏览器关闭之前的不是同一批了，所以旧的数据已经没用了）
// 如果不进行持久化存储，如果前台任务处于下载途中，后台 SW 被回收了，那么变量也会被清除。之后前台传递过来的可能还是同一批下载里的任务，但是后台却丢失了记录。这可能会导致下载出现重复文件等异常。
// 实际上，下载时后台 SW 会持续存在很长时间，不会轻易被回收的。持久化存储只是为了以防万一

async function setData(data: { [key: string]: any }) {
  return browser.storage.local.set(data)
}

/** 立即持久化 worker 侧异常，避免 MV3 worker 休眠后丢失证据。 */
async function persistDownloadWorkerIncident(
  tabId: number,
  reason: string,
  details: Record<string, unknown> = {}
) {
  const worker = await downloadWorkerDiagnostics.snapshot(tabId, {
    memoryBatchNo: batchNo[tabId],
    memoryIdList: idList[tabId] ? [...idList[tabId]] : [],
  })
  await downloadWorkerDiagnostics.persist(tabId, {
    schemaVersion: 1,
    diagnosticsVersion: 'download-hang-v1',
    source: 'service-worker',
    capturedAt: new Date().toISOString(),
    reason,
    details,
    worker,
  })
}

/** 全局下载租约协议使用的消息名称。 */
const globalDownloadLeaseMsg = {
  acquire: 'global_download_lease_acquire',
  renew: 'global_download_lease_renew',
  release: 'global_download_lease_release',
} as const
/** 全局下载租约专用的 runtime port 名称。 */
const globalDownloadLeasePortName = 'global-download-lease'
/** 在 session storage 中保存全局下载租约的键名。 */
const globalDownloadLeaseStorageKey = 'globalDownloadLease'
/** 没有进度续租时，一个下载租约最多保留 45 秒。 */
const globalDownloadLeaseTtlMs = 45000

/** 前台通过专用 port 发送的租约操作。 */
interface GlobalDownloadLeaseMessage {
  msg:
    | typeof globalDownloadLeaseMsg.acquire
    | typeof globalDownloadLeaseMsg.renew
    | typeof globalDownloadLeaseMsg.release
  requestId: string
  fileId?: string
  leaseId?: string
}

/** 后台对租约操作返回的结果。 */
interface GlobalDownloadLeaseReply {
  granted: boolean
  leaseId?: string
  retryAfterMs?: number
  error?: string
}

/** 持久化在 session storage 中的当前租约。 */
interface StoredGlobalDownloadLease {
  leaseId: string
  requestId: string
  tabId: number
  fileId: string
  expiresAt: number
}

/** 当前 Service Worker 实例缓存的租约；undefined 表示尚未从存储加载。 */
let activeGlobalDownloadLease: StoredGlobalDownloadLease | null | undefined
/** 串行化租约读写，避免两个标签页同时修改 session storage。 */
let globalDownloadLeaseOperationQueue: Promise<void> = Promise.resolve()

/** 当前用于持久化租约的存储区域；旧浏览器没有 session 时退回 local。 */
let globalDownloadLeaseStorageArea: browser.Storage.StorageArea =
  browser.storage.session || browser.storage.local

/** 标记租约是否已经退回 local storage，避免失败后重复尝试 session。 */
let globalDownloadLeaseUsesLocalStorage = !browser.storage.session

/**
 * 执行一次租约存储操作。session 不可用或运行时拒绝时改用 local；
 * local 中残留的租约仍受 45 秒 TTL 限制，不会永久阻塞下一次浏览器会话。
 */
async function useGlobalDownloadLeaseStorage<T>(
  operation: (storage: browser.Storage.StorageArea) => Promise<T>
): Promise<T> {
  try {
    return await operation(globalDownloadLeaseStorageArea)
  } catch (error) {
    if (globalDownloadLeaseUsesLocalStorage) throw error
    globalDownloadLeaseUsesLocalStorage = true
    globalDownloadLeaseStorageArea = browser.storage.local
    console.warn(
      'storage.session unavailable; using storage.local for lease',
      error
    )
    return operation(globalDownloadLeaseStorageArea)
  }
}

/** 把一个租约操作排到前一个租约操作之后执行。 */
function serializeGlobalDownloadLease<T>(
  operation: () => Promise<T>
): Promise<T> {
  const result = globalDownloadLeaseOperationQueue.then(operation, operation)
  globalDownloadLeaseOperationQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

/** 判断 unknown 值是否是可安全读取属性的对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 校验来自 runtime port 的租约消息结构。 */
function isGlobalDownloadLeaseMessage(
  value: unknown
): value is GlobalDownloadLeaseMessage {
  if (!isRecord(value) || typeof value.requestId !== 'string') return false
  if (value.fileId !== undefined && typeof value.fileId !== 'string')
    return false
  if (value.leaseId !== undefined && typeof value.leaseId !== 'string')
    return false
  return (
    value.msg === globalDownloadLeaseMsg.acquire ||
    value.msg === globalDownloadLeaseMsg.renew ||
    value.msg === globalDownloadLeaseMsg.release
  )
}

/** 校验从 session storage 读取出的租约结构。 */
function isStoredGlobalDownloadLease(
  value: unknown
): value is StoredGlobalDownloadLease {
  if (!isRecord(value)) return false
  return (
    typeof value.leaseId === 'string' &&
    typeof value.requestId === 'string' &&
    typeof value.tabId === 'number' &&
    typeof value.fileId === 'string' &&
    typeof value.expiresAt === 'number'
  )
}

/** 从内存缓存或 session storage 读取当前租约。 */
async function loadGlobalDownloadLease(): Promise<StoredGlobalDownloadLease | null> {
  if (activeGlobalDownloadLease !== undefined) {
    return activeGlobalDownloadLease
  }

  const data = await useGlobalDownloadLeaseStorage((storage) =>
    storage.get(globalDownloadLeaseStorageKey)
  )
  const stored = data[globalDownloadLeaseStorageKey]
  activeGlobalDownloadLease = isStoredGlobalDownloadLease(stored)
    ? stored
    : null
  return activeGlobalDownloadLease
}

/** 同时更新 session storage 和当前 Service Worker 的租约缓存。 */
async function storeGlobalDownloadLease(
  lease: StoredGlobalDownloadLease
): Promise<void> {
  await useGlobalDownloadLeaseStorage((storage) =>
    storage.set({ [globalDownloadLeaseStorageKey]: lease })
  )
  activeGlobalDownloadLease = lease
}

/** 清除当前全局下载租约。 */
async function clearGlobalDownloadLease(): Promise<void> {
  await useGlobalDownloadLeaseStorage((storage) =>
    storage.remove(globalDownloadLeaseStorageKey)
  )
  activeGlobalDownloadLease = null
}

/** 检查租约是否仍然属于指定标签页、请求和 fencing token。 */
function globalDownloadLeaseMatches(
  lease: StoredGlobalDownloadLease,
  tabId: number,
  requestId: string,
  leaseId?: string
): boolean {
  return (
    lease.tabId === tabId &&
    lease.requestId === requestId &&
    (!leaseId || lease.leaseId === leaseId)
  )
}

/** 在已经取得串行化锁的情况下执行 acquire、renew 或 release。 */
async function handleGlobalDownloadLeaseMessageLocked(
  msg: GlobalDownloadLeaseMessage,
  tabId: number
): Promise<GlobalDownloadLeaseReply> {
  const now = Date.now()
  const current = await loadGlobalDownloadLease()

  if (msg.msg === globalDownloadLeaseMsg.acquire) {
    if (current && current.expiresAt > now) {
      if (globalDownloadLeaseMatches(current, tabId, msg.requestId)) {
        return { granted: true, leaseId: current.leaseId }
      }

      return {
        granted: false,
        retryAfterMs: Math.min(1000, Math.max(100, current.expiresAt - now)),
      }
    }

    if (!msg.fileId) {
      return { granted: false, retryAfterMs: 1000 }
    }

    const lease: StoredGlobalDownloadLease = {
      leaseId: crypto.randomUUID(),
      requestId: msg.requestId,
      tabId,
      fileId: msg.fileId,
      expiresAt: now + globalDownloadLeaseTtlMs,
    }
    await storeGlobalDownloadLease(lease)
    return { granted: true, leaseId: lease.leaseId }
  }

  if (
    current &&
    msg.leaseId &&
    globalDownloadLeaseMatches(current, tabId, msg.requestId, msg.leaseId)
  ) {
    if (msg.msg === globalDownloadLeaseMsg.renew) {
      // An expired owner may revive only if nobody has replaced its fencing token.
      const renewed = {
        ...current,
        expiresAt: now + globalDownloadLeaseTtlMs,
      }
      await storeGlobalDownloadLease(renewed)
      return { granted: true, leaseId: renewed.leaseId }
    }

    await clearGlobalDownloadLease()
    return { granted: true }
  }

  return { granted: false }
}

/** 串行执行一个来自指定标签页的租约操作。 */
async function handleGlobalDownloadLeaseMessage(
  msg: GlobalDownloadLeaseMessage,
  tabId: number
): Promise<GlobalDownloadLeaseReply> {
  if (!msg.requestId) {
    return { granted: false, retryAfterMs: 1000 }
  }

  return serializeGlobalDownloadLease(() =>
    handleGlobalDownloadLeaseMessageLocked(msg, tabId)
  )
}

/** 如果当前租约属于指定标签页，则立即清除它。 */
async function clearGlobalDownloadLeaseForTab(tabId: number): Promise<void> {
  await serializeGlobalDownloadLease(async () => {
    const current = await loadGlobalDownloadLease()
    if (current?.tabId === tabId) {
      await clearGlobalDownloadLease()
    }
  })
}

browser.tabs.onRemoved.addListener((tabId) => {
  clearGlobalDownloadLeaseForTab(tabId).catch((error) => {
    console.warn('Failed to clear global download lease for closed tab', error)
  })
})

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // 完整导航/刷新和 discarded 都会卸载旧文档，旧 content script 无法保证 finally 能执行。
  if (changeInfo.discarded === true || changeInfo.status === 'loading') {
    clearGlobalDownloadLeaseForTab(tabId).catch((error) => {
      console.warn(
        'Failed to clear global download lease for unloaded tab',
        error
      )
    })
  }
})

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== globalDownloadLeasePortName) return

  const tabId = port.sender?.tab?.id
  if (tabId === undefined) {
    port.disconnect()
    return
  }

  port.onMessage.addListener((msg: unknown) => {
    if (!isGlobalDownloadLeaseMessage(msg)) return

    handleGlobalDownloadLeaseMessage(msg, tabId)
      .then((reply) => port.postMessage(reply))
      .catch((error) => {
        console.error('Global download lease port message failed', error)
        port.postMessage({
          granted: false,
          error: 'Global download lease storage unavailable',
        })
      })
  })
})

/** 判断未知 runtime 消息是否属于只读/持久化下载诊断协议。 */
function isDownloadDiagnosticMessage(
  msg: unknown
): msg is DownloadDiagnosticMessage {
  if (!msg || typeof msg !== 'object') return false
  const value = msg as Record<string, unknown>
  if (value.msg === 'get_download_worker_diagnostics') return true
  return value.msg === 'record_download_hang_diagnostic' && 'report' in value
}

// 类型守卫，这是为了通过类型检查，所以只要求有 msg 属性
// 如果检查了其他属性，那么对于只有 msg 属性的简单消息就会不通过。所以不检查其他属性
function isMsg(msg: any): msg is SendToBackEndData {
  return !!msg.msg
}

browser.runtime.onMessage.addListener(async function (
  msg: unknown,
  sender: browser.Runtime.MessageSender
) {
  const tabId = sender.tab?.id

  if (isDownloadDiagnosticMessage(msg)) {
    if (msg.msg === 'get_download_worker_diagnostics') {
      if (tabId === undefined) return { unavailable: true, reason: 'no-tab-id' }
      const stored = await browser.storage.local.get(['batchNo', 'idList'])
      const storedBatchNo = stored.batchNo as batchNoType | undefined
      const storedIdList = stored.idList as idListType | undefined
      return downloadWorkerDiagnostics.snapshot(tabId, {
        memoryBatchNo: batchNo[tabId],
        memoryIdList: idList[tabId] ? [...idList[tabId]] : [],
        storedBatchNo: storedBatchNo?.[tabId],
        storedIdList: storedIdList?.[tabId] ? [...storedIdList[tabId]] : [],
      })
    }

    if (tabId === undefined) return { stored: false, reason: 'no-tab-id' }
    await downloadWorkerDiagnostics.persist(tabId, msg.report)
    return { stored: true }
  }

  // msg 是 SendToBackEndData 类型，但是 webextension-polyfill 的 msg 是 unknown，
  // 不能直接在上面设置类型为 msg: SendToBackEndData，否则会报错。因此需要使用类型守卫，真麻烦
  if (!isMsg(msg)) {
    console.warn('收到了无效的消息:', msg)
    return false
  }

  if (tabId === undefined) return false

  // 当存在同名文件时，默认覆写，但前台也可以指定处理方式
  const conflictAction = msg.conflictAction || 'overwrite'

  // 下载作品的文件
  if (msg.msg === 'save_work_file') {
    downloadWorkerDiagnostics.enter(
      tabId,
      msg.diagnosticId,
      'save-request-received',
      {
        workId: msg.id,
        fileName: msg.fileName,
      }
    )
    // 当处于初始状态时，或者变量被回收了，就从存储中读取数据储存在变量中
    // 之后每当要使用这两个数据时，从变量读取，而不是从存储中获得。这样就解决了数据不同步的问题，而且性能更高
    if (Object.keys(batchNo).length === 0) {
      const data = await browser.storage.local.get(['batchNo', 'idList'])
      batchNo = data.batchNo as batchNoType
      idList = data.idList as idListType
    }

    // 如果开始了新一批的下载，重设批次编号，并清空下载索引
    if (batchNo[tabId] !== msg.taskBatch) {
      batchNo[tabId] = msg.taskBatch
      idList[tabId] = []
      setData({ batchNo, idList })
      // 这里存储数据时不需要使用 await，因为后面使用的是全局变量，所以不需要关心存储数据的同步问题
    }

    // 检查任务是否重复，不重复则下载
    if (!idList[tabId].includes(msg.id)) {
      // 储存该任务的索引
      idList[tabId].push(msg.id)
      setData({ idList })

      // 开始下载
      const _url = await getFileURL(msg)
      downloadWorkerDiagnostics.enter(
        tabId,
        msg.diagnosticId,
        'browser-download-create-pending',
        { workId: msg.id, fileName: msg.fileName }
      )
      browser.downloads
        .download({
          url: _url,
          filename: msg.fileName,
          conflictAction,
          saveAs: false,
        })
        .then((id) => {
          downloadWorkerDiagnostics.enter(
            tabId,
            msg.diagnosticId,
            'browser-download-created',
            {
              workId: msg.id,
              fileName: msg.fileName,
              browserDownloadId: id,
            }
          )
          // id 是新建立的下载项的 id，使用它作为 key 保存数据
          dlData[id] = {
            blobURLFront: msg.blobURL,
            blobURLBack: _url.startsWith('blob:') ? _url : '',
            id: msg.id,
            tabId: tabId,
            uuid: false,
            diagnosticId: msg.diagnosticId,
            browserDownloadId: id,
          }
        })
        .catch((error) => {
          downloadWorkerDiagnostics.enter(
            tabId,
            msg.diagnosticId,
            'browser-download-create-rejected',
            {
              workId: msg.id,
              fileName: msg.fileName,
              error: String(error),
            }
          )
          console.error('downloads.download 失败', error)
          void persistDownloadWorkerIncident(
            tabId,
            'browser-download-create-rejected',
            { workId: msg.id, fileName: msg.fileName, error: String(error) }
          )
        })
    } else {
      downloadWorkerDiagnostics.enter(
        tabId,
        msg.diagnosticId,
        'save-request-deduplicated',
        {
          workId: msg.id,
          fileName: msg.fileName,
          idListLength: idList[tabId].length,
        }
      )
      await persistDownloadWorkerIncident(tabId, 'save-request-deduplicated', {
        workId: msg.id,
        fileName: msg.fileName,
        idListLength: idList[tabId].length,
      })
    }
  }

  // 有些文件本身不在抓取结果 store.result 里，所以也不会出现在下载进度条上
  // 对于这些文件直接下载，不需要返回下载结果
  if (
    msg.msg === 'no_reply' ||
    msg.msg === 'save_description_file' ||
    msg.msg === 'save_novel_cover_file' ||
    msg.msg === 'save_novel_embedded_image' ||
    msg.msg === 'save_novel_series_file'
  ) {
    const _url = await getFileURL(msg)
    browser.downloads
      .download({
        url: _url,
        filename: msg.fileName,
        conflictAction,
        saveAs: false,
      })
      .then((id) => {
        dlData[id] = {
          blobURLFront: msg.blobURL,
          blobURLBack: _url.startsWith('blob:') ? _url : '',
          id: msg.id,
          tabId: tabId,
          uuid: false,
          noReply: true,
        }
      })
  }

  // 使用 a.download 来下载文件时，不调用 downloads API，并且直接返回下载成功的模拟数据
  if (msg.msg === 'save_work_file_a_download') {
    const tabId = sender.tab!.id!
    const data = {
      msg: 'downloaded',
      data: {
        url: '',
        id: msg.id,
        tabId,
        uuid: false,
        diagnosticId: msg.diagnosticId,
      },
      err: '',
    }
    downloadWorkerDiagnostics.finish(
      tabId,
      msg.diagnosticId,
      'a-download-simulated-complete',
      { workId: msg.id, fileName: msg.fileName }
    )
    browser.tabs.sendMessage(tabId, data).catch((error) => {
      console.error('回发 downloaded 消息失败', error)
      void persistDownloadWorkerIncident(tabId, 'result-message-rejected', {
        workId: msg.id,
        diagnosticId: msg.diagnosticId,
        error: String(error),
      })
    })
  }

  if (msg.msg === 'clearDownloadsTempData') {
    if (sender.tab?.id) {
      const tabId = sender.tab.id
      delete idList[tabId]
      delete batchNo[tabId]

      setData({ batchNo, idList })
    }
  }

  return false
})

const isFirefox = navigator.userAgent.includes('Firefox')

async function getFileURL(msg: SendToBackEndData) {
  // 在 Chrome 的隐私窗口里，使用 dataURL
  if (msg.dataURL) {
    return msg.dataURL
  }

  // 在 Firefox 里，使用 blob 并生成 blob URL
  if (isFirefox && msg.blob) {
    return URL.createObjectURL(msg.blob)
  }

  // 在 Chrome 的正常窗口里，使用 blob URL
  if (msg.blobURL) {
    return msg.blobURL
  }

  console.error('没有找到可用的下载 URL 或数据')
  return ''
}

function revokeBlobURL(url?: string) {
  if (url && url.startsWith('blob:')) {
    if (
      typeof URL !== 'undefined' &&
      typeof URL.revokeObjectURL === 'function'
    ) {
      URL.revokeObjectURL(url)
    }
  }
}

// 判断文件名是否变成了 UUID 格式。因为文件名处于整个绝对路径的中间，所以没加首尾标记 ^ $
const UUIDRegexp =
  /[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/

// 监听下载变化事件
// 每个下载会触发两次 onChanged 事件
// Firefox Android 不支持 downloads API（注册监听器时会抛出 "Not implemented" 错误），所以不注册该监听器
if (!Config.downloadsAPIDisabled) {
  browser.downloads.onChanged.addListener(async function (detail) {
    // 根据 detail.id 取出保存的数据
    const _dlData = dlData[detail.id]
    if (_dlData) {
      let msg = ''
      let err = ''

      // 判断当前文件名是否正常。下载时必定会有一次 detail.filename.current 有值
      if (detail.filename && detail.filename.current) {
        const changedName = detail.filename.current
        if (changedName.match(UUIDRegexp) !== null) {
          // 文件名是 UUID
          _dlData.uuid = true
        }

        _dlData.browserSetFilename = changedName
      }

      if (detail.state && detail.state.current === 'complete') {
        msg = 'downloaded'
        downloadWorkerDiagnostics.finish(
          _dlData.tabId,
          _dlData.diagnosticId,
          'browser-download-complete',
          {
            browserDownloadId: detail.id,
            browserSetFilename: _dlData.browserSetFilename,
          }
        )
      }

      if (detail.error && detail.error.current) {
        msg = 'download_err'
        err = detail.error.current
        downloadWorkerDiagnostics.finish(
          _dlData.tabId,
          _dlData.diagnosticId,
          'browser-download-error',
          { browserDownloadId: detail.id, error: err }
        )
        // 当保存一个文件出错时，从任务记录列表里删除它，以便前台重试下载
        const idIndex = idList[_dlData.tabId].findIndex(
          (val) => val === _dlData.id
        )
        idList[_dlData.tabId][idIndex] = ''
        setData({ idList })
      }

      if (msg) {
        // 返回信息
        if (!_dlData.noReply) {
          browser.tabs
            .sendMessage(_dlData.tabId, { msg, data: _dlData, err })
            .catch((error) => {
              console.error('回发 downloaded 消息失败', error)
              void persistDownloadWorkerIncident(
                _dlData.tabId,
                'result-message-rejected',
                {
                  workId: _dlData.id,
                  diagnosticId: _dlData.diagnosticId,
                  browserDownloadId: detail.id,
                  resultMessage: msg,
                  error: String(error),
                }
              )
            })
        }

        // 吊销前后台生成的 blob URL
        revokeBlobURL(_dlData?.blobURLFront)
        revokeBlobURL(_dlData?.blobURLBack)
        // 删除保存的数据
        delete dlData[detail.id]
        dlData[detail.id] = null
      }
    }
  })
}

// 清除不需要的数据，避免数据体积越来越大
async function clearData() {
  for (const key of Object.keys(idList)) {
    const tabId = parseInt(key)
    try {
      await browser.tabs.get(tabId)
    } catch (error) {
      // 如果建立下载任务的标签页已经不存在，则会触发错误，如：
      // Unchecked runtime.lastError: No tab with id: 1943988409.
      // 此时删除对应的数据
      delete idList[tabId]
      delete batchNo[tabId]
    }
  }

  setData({ batchNo, idList })
}

setInterval(() => {
  clearData()
}, 3600000)
