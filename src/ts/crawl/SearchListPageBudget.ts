/**
 * One crawl's list-page allocation and completion accounting.
 * A page may be retried after a failed request, but only one attempt may own it
 * at a time, and successful pages are counted exactly once.
 */
export class SearchListPageBudget {
  private nextOffset = 0
  private readonly inFlight = new Set<number>()
  private readonly completed = new Set<number>()
  private closed = false

  constructor(
    readonly startPage: number,
    readonly totalPages: number,
    readonly crawlUrl: string
  ) {
    if (
      !Number.isSafeInteger(startPage) ||
      startPage < 1 ||
      !Number.isSafeInteger(totalPages) ||
      totalPages < 1
    ) {
      throw new Error('Invalid list-page range')
    }
  }

  /** Reserve the next page or a specific failed page for retry. */
  claim(retryPage?: number): number | undefined {
    if (this.closed) return
    const page = retryPage ?? this.startPage + this.nextOffset
    if (
      !this.inRange(page) ||
      this.inFlight.has(page) ||
      this.completed.has(page)
    ) {
      return
    }
    if (retryPage === undefined) this.nextOffset++
    this.inFlight.add(page)
    return page
  }

  /** Failed attempts remain eligible for retry, without increasing the page count. */
  abandon(page: number) {
    this.inFlight.delete(page)
  }

  /** Returns false for stale/duplicate callbacks. */
  complete(page: number): boolean {
    if (
      this.closed ||
      !this.inFlight.delete(page) ||
      this.completed.has(page)
    ) {
      return false
    }
    this.completed.add(page)
    return true
  }

  canScheduleNext(): boolean {
    return !this.closed && this.nextOffset < this.totalPages
  }

  isComplete(): boolean {
    return this.completed.size === this.totalPages
  }

  accepts(currentUrl: string): boolean {
    return !this.closed && currentUrl === this.crawlUrl
  }

  get finishedCount(): number {
    return this.completed.size
  }

  cancel() {
    this.closed = true
    this.inFlight.clear()
  }

  private inRange(page: number): boolean {
    return (
      Number.isSafeInteger(page) &&
      page >= this.startPage &&
      page < this.startPage + this.totalPages
    )
  }
}
