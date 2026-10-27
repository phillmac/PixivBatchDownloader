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
let consecutiveIds: string[] = []
let active = false

function normalizeUrl(url: string) {
  return url.split('#')[0]
}

function now() {
  return new Date().toISOString()
}

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
  active = false
  return {
    armed: true,
    url: normalized,
    knownCount: knownIds.size,
    requiredConsecutive,
  }
}

export function startKnownOverlap(url: string) {
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
      if (!allowBoundary) {
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
