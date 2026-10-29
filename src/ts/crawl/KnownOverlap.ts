export type KnownOverlapStopReason =
  'known-overlap' | 'source-exhausted' | 'crawl-limit'

export type KnownOverlapSnapshot = {
  url: string
  knownCount: number
  requiredConsecutive: number
  scannedCount: number
  unknownCount: number
  knownSeenCount: number
  currentConsecutive: number
  boundaryReached: boolean
  boundaryIds: string[]
  stopReason: KnownOverlapStopReason | null
  armedAt: string
  startedAt: string | null
  finishedAt: string | null
}

type KnownOverlapArm = {
  url: string
  knownIds: Set<string>
  requiredConsecutive: number
  armedAt: string
}

let arm: KnownOverlapArm | null = null
let activeKnownIds: Set<string> | null = null
let snapshot: KnownOverlapSnapshot | null = null
/** 当前连续出现、且在本轮抓取中首次观察到的已知 ID。 */
let consecutiveIds: string[] = []
/** 本轮抓取已观察的已知 ID；跨响应、未知项和禁用边界的扫描保留记录。 */
const seenKnownIds = new Set<string>()
let active = false

function normalizeUrl(url: string) {
  return url.split('#')[0]
}

function now() {
  return new Date().toISOString()
}

/** 为下一次匹配 URL 的抓取配置重叠边界；空集合仍记录源耗尽。 */
export function configureKnownOverlap(
  url: string,
  ids: string[] | null,
  requiredConsecutive = 3
) {
  if (ids === null) {
    arm = null
    activeKnownIds = null
    snapshot = null
    consecutiveIds = []
    seenKnownIds.clear()
    active = false
    return { armed: false, knownCount: 0, requiredConsecutive }
  }
  if (!Number.isSafeInteger(requiredConsecutive) || requiredConsecutive < 1) {
    throw new RangeError('requiredConsecutive must be a positive safe integer')
  }
  const normalized = normalizeUrl(url)
  const knownIds = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) {
      throw new TypeError('known overlap IDs must be numeric strings')
    }
    knownIds.add(id)
  }
  arm = {
    url: normalized,
    knownIds,
    requiredConsecutive,
    armedAt: now(),
  }
  snapshot = null
  consecutiveIds = []
  seenKnownIds.clear()
  active = false
  return {
    armed: true,
    url: normalized,
    knownCount: knownIds.size,
    requiredConsecutive,
  }
}

/** 一次性启用匹配的配置，并重置本轮已知 ID 的观察记录。 */
export function startKnownOverlap(url: string) {
  seenKnownIds.clear()
  const normalized = normalizeUrl(url)
  if (!arm || arm.url !== normalized) {
    activeKnownIds = null
    snapshot = null
    consecutiveIds = []
    active = false
    return null
  }

  // The automation arm is one-shot. Consume it on the first matching crawl so
  // a later manual/full crawl in the same content-script lifetime cannot inherit it.
  const activeArm = arm
  arm = null
  activeKnownIds = new Set(activeArm.knownIds)
  snapshot = {
    url: normalized,
    knownCount: activeKnownIds.size,
    requiredConsecutive: activeArm.requiredConsecutive,
    scannedCount: 0,
    unknownCount: 0,
    knownSeenCount: 0,
    currentConsecutive: 0,
    boundaryReached: false,
    boundaryIds: [],
    stopReason: null,
    armedAt: activeArm.armedAt,
    startedAt: now(),
    finishedAt: null,
  }
  consecutiveIds = []
  active = true
  return getKnownOverlapSnapshot(normalized)
}

/**
 * 按源顺序保留候选项，仅连续首次出现的不同已知 ID 可以建立边界。
 * 已知 ID 在本轮抓取中只能投票一次；任何重复项都会清空连续记录，且不作为
 * 新连续记录的起点。未知项和 allowBoundary=false 同样清空连续记录，
 * 但不清除已观察 ID，因此跨响应重放不能重新投票或连接前后的连续记录。
 */
export function consumeKnownOverlap<T extends { id: string }>(
  items: T[],
  allowBoundary = true
): { items: T[]; boundaryReached: boolean; scannedCount: number } {
  if (!activeKnownIds || !snapshot || !active) {
    return {
      items,
      boundaryReached: false,
      scannedCount: items.length,
    }
  }

  const result: T[] = []
  let scannedCount = 0
  for (const item of items) {
    scannedCount += 1
    snapshot.scannedCount += 1
    // Membership controls only where discovery may stop. It never decides
    // whether a discovered work is eligible for metadata/download; PPBD's
    // independent filters (including only-undownloaded) own that decision.
    result.push(item)
    if (activeKnownIds.has(item.id)) {
      snapshot.knownSeenCount += 1
      const repeated = seenKnownIds.has(item.id)
      seenKnownIds.add(item.id)
      if (!allowBoundary || repeated) {
        consecutiveIds = []
        snapshot.currentConsecutive = 0
        continue
      }
      consecutiveIds.push(item.id)
      if (consecutiveIds.length > snapshot.requiredConsecutive) {
        consecutiveIds.shift()
      }
      snapshot.currentConsecutive = consecutiveIds.length
      if (snapshot.currentConsecutive >= snapshot.requiredConsecutive) {
        snapshot.boundaryReached = true
        snapshot.boundaryIds = [...consecutiveIds]
        snapshot.stopReason = 'known-overlap'
        snapshot.finishedAt = now()
        active = false
        activeKnownIds = null
        seenKnownIds.clear()
        break
      }
      continue
    }

    consecutiveIds = []
    snapshot.currentConsecutive = 0
    snapshot.unknownCount += 1
  }

  return {
    items: result,
    boundaryReached: snapshot.boundaryReached,
    scannedCount,
  }
}

/** 记录源耗尽或抓取限额，结束尚未到达重叠边界的扫描。 */
export function finishKnownOverlap(
  reason: Exclude<KnownOverlapStopReason, 'known-overlap'>
) {
  if (!snapshot || snapshot.stopReason) {
    return getKnownOverlapSnapshot(snapshot?.url)
  }
  snapshot.stopReason = reason
  snapshot.finishedAt = now()
  active = false
  activeKnownIds = null
  seenKnownIds.clear()
  return getKnownOverlapSnapshot(snapshot.url)
}

export function getKnownOverlapSnapshot(url?: string) {
  if (!snapshot) return null
  if (url && snapshot.url !== normalizeUrl(url)) return null
  return {
    ...snapshot,
    boundaryIds: [...snapshot.boundaryIds],
  }
}
