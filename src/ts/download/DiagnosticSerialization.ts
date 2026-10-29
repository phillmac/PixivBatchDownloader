/** 诊断专用的 UTF-8 JSON 字节预算，不影响下载数据和自动化轮询。 */
export const diagnosticLimits = {
  detail: 2048,
  entry: 4096,
  collection: 24 * 1024,
  page: 96 * 1024,
  worker: 96 * 1024,
  report: 200 * 1024,
  retention: 512 * 1024,
  string: 1024,
  entries: 240,
}

/** 计算已经过安全复制的数据的 UTF-8 JSON 字节数。 */
export function diagnosticBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return Infinity
  }
}

/** 按 JSON 编码后的 UTF-8 字节截断文本，且不拆开代理对。 */
export function diagnosticText(
  text: string,
  byteLimit = diagnosticLimits.string
) {
  if (text.length <= byteLimit && diagnosticBytes(text) <= byteLimit)
    return text
  let low = 0
  let high = Math.min(text.length, byteLimit)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (diagnosticBytes(text.slice(0, middle)) + 3 <= byteLimit) low = middle
    else high = middle - 1
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low--
  return text.slice(0, low) + '…'
}

/** 深复制诊断对象并限制深度、节点、文本和总字节；不执行自定义 toJSON。 */
export function diagnosticRecord(
  source: Record<string, unknown>,
  byteLimit = diagnosticLimits.detail
): Record<string, unknown> {
  // 留出固定空间记录截断与序列化失败信息。
  let remaining = byteLimit - 256
  let truncatedValues = 0
  let serializationErrors = 0
  let nodes = 0
  const ancestors = new WeakSet<object>()
  const copy = (value: unknown, depth: number): unknown => {
    if (remaining < 8 || ++nodes > 32768 || depth > 8) {
      truncatedValues++
      remaining -= 4
      return null
    }
    if (typeof value === 'string') {
      const text = diagnosticText(
        value,
        Math.min(remaining, diagnosticLimits.string)
      )
      if (text !== value) truncatedValues++
      remaining -= diagnosticBytes(text)
      return text
    }
    if (value === undefined) {
      remaining -= 4
      return null
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    ) {
      remaining -= diagnosticBytes(value)
      return value
    }
    if (typeof value !== 'object' || ancestors.has(value)) {
      serializationErrors++
      remaining -= 4
      return null
    }
    ancestors.add(value)
    remaining -= 2
    const result: Record<string, unknown> = Object.create(null)
    const array: unknown[] = []
    try {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (remaining < 16 || i >= diagnosticLimits.entries) {
            truncatedValues += value.length - i
            break
          }
          remaining--
          try {
            array.push(copy(value[i], depth + 1))
          } catch {
            serializationErrors++
            remaining -= 4
            array.push(null)
          }
        }
      } else {
        let count = 0
        for (const key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue
          const keyBytes =
            key.length > remaining ? Infinity : diagnosticBytes(key)
          if (remaining < keyBytes + 16 || ++count > diagnosticLimits.entries) {
            truncatedValues++
            break
          }
          remaining -= keyBytes + 2
          try {
            result[key] = copy(
              (value as Record<string, unknown>)[key],
              depth + 1
            )
          } catch {
            serializationErrors++
            remaining -= 4
            result[key] = null
          }
        }
      }
    } catch {
      serializationErrors++
    }
    ancestors.delete(value)
    return Array.isArray(value) ? array : result
  }
  const value = copy(source, 0)
  const result =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  result.diagnosticSerialization = {
    byteLimit,
    truncatedValues,
    serializationErrors,
  }
  return result
}

/** 从迭代器提取有字节上限的详情，并保留准确的总数和省略数量。 */
export function diagnosticSample(
  values: Iterable<Record<string, unknown>>,
  total: number,
  byteLimit = diagnosticLimits.collection
) {
  const items: Record<string, unknown>[] = []
  let bytes = 2
  for (const value of values) {
    const item = diagnosticRecord(value, diagnosticLimits.entry)
    const size = diagnosticBytes(item) + 1
    if (bytes + size > byteLimit || items.length >= diagnosticLimits.entries)
      break
    items.push(item)
    bytes += size
  }
  return { items, total, omitted: total - items.length }
}

/** 原地收缩最近事件环，同时约束条数与序列化字节。 */
export function trimDiagnosticEvents<T>(events: T[]) {
  let bytes = 2
  let start = events.length
  while (start > 0 && events.length - start < diagnosticLimits.entries) {
    const size = diagnosticBytes(events[start - 1]) + 1
    if (bytes + size > diagnosticLimits.collection) break
    bytes += size
    start--
  }
  if (start) events.splice(0, start)
  return start
}
