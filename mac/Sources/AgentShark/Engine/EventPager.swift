import Foundation

/// Paging cache for one view: pages of 500 rows, an LRU of 64 pages, prefetch of ±2 pages around the visible
/// range, and de-duplication of in-flight requests. Row indexes are 0-based (row `i` is view row number `i + 1`).
@MainActor final class EventPager {
    static let pageSize = 500
    static let maxPages = 64
    static let prefetchPages = 2
    /// A failed page is not requested again automatically for this long.
    static let retryDelay: TimeInterval = 3

    let api: APIClient
    let view: ViewInfo
    let columns: [String]

    /// Called on the main actor with the row indexes that became available.
    var onRowsLoaded: ((IndexSet) -> Void)?
    /// Called when a page fails (for example `view-not-found` after an engine restart).
    var onError: ((APIError) -> Void)?
    private(set) var lastError: APIError?

    private var pages: [Int: [EventRow]] = [:]
    private var recency: [Int] = []
    private var inFlight: [Int: Task<Void, Never>] = [:]
    private var failed: [Int: Date] = [:]
    private var cancelled = false

    init(api: APIClient, view: ViewInfo, columns: [String]) {
        self.api = api
        self.view = view
        self.columns = columns
    }

    var count: Int { view.count }
    var pageCount: Int { (count + Self.pageSize - 1) / Self.pageSize }

    /// The row, or nil while its page loads (the call starts the load).
    func row(at index: Int) -> EventRow? {
        guard index >= 0, index < count else { return nil }
        let page = index / Self.pageSize
        if let rows = pages[page] {
            touch(page)
            let i = index - page * Self.pageSize
            return i < rows.count ? rows[i] : nil
        }
        load(page)
        return nil
    }

    /// Whether the row's page failed to load (show it as failed, not as loading).
    func isFailed(_ index: Int) -> Bool { failed[index / Self.pageSize] != nil }

    func isLoaded(_ index: Int) -> Bool { pages[index / Self.pageSize] != nil }

    /// Load the pages around the visible range.
    func prefetch(around range: Range<Int>) {
        guard count > 0, !range.isEmpty else { return }
        let first = max(0, range.lowerBound / Self.pageSize - Self.prefetchPages)
        let last = min(pageCount - 1, (range.upperBound - 1) / Self.pageSize + Self.prefetchPages)
        guard first <= last else { return }
        // Visible pages first, then outward.
        let visible = (range.lowerBound / Self.pageSize)...((range.upperBound - 1) / Self.pageSize)
        for p in visible where p <= last { load(p) }
        for p in first...last where !visible.contains(p) { load(p) }
    }

    /// Rows for `range`, loading missing pages (for copy and export of a selection).
    func rows(in range: Range<Int>) async throws -> [EventRow] {
        let clamped = range.clamped(to: 0..<count)
        guard !clamped.isEmpty else { return [] }
        var out: [EventRow] = []
        out.reserveCapacity(clamped.count)
        for page in (clamped.lowerBound / Self.pageSize)...((clamped.upperBound - 1) / Self.pageSize) {
            let rows: [EventRow]
            if let cached = pages[page] {
                rows = cached
            } else {
                rows = try await api.rows(view: view.viewId, offset: page * Self.pageSize, limit: Self.pageSize, columns: columns)
                store(rows, page: page)
            }
            let base = page * Self.pageSize
            for (i, r) in rows.enumerated() where clamped.contains(base + i) { out.append(r) }
        }
        return out
    }

    /// The index of an event among cached rows, without a request.
    func cachedIndex(ofEvent id: String) -> Int? {
        for (page, rows) in pages {
            if let i = rows.firstIndex(where: { $0.id == id }) { return page * Self.pageSize + i }
        }
        return nil
    }

    /// Forget failures and load the failed pages again.
    func retryFailedPages() {
        let pagesToRetry = Array(failed.keys)
        failed.removeAll()
        lastError = nil
        for p in pagesToRetry { load(p) }
    }

    /// Cancel every request; the pager is discarded when the view changes.
    func cancel() {
        cancelled = true
        for t in inFlight.values { t.cancel() }
        inFlight.removeAll()
        onRowsLoaded = nil
        onError = nil
    }

    // MARK: Internals

    private func load(_ page: Int) {
        guard !cancelled, page >= 0, page < pageCount, pages[page] == nil, inFlight[page] == nil else { return }
        if let at = failed[page], Date().timeIntervalSince(at) < Self.retryDelay { return }
        let api = api
        let viewID = view.viewId
        let columns = columns
        inFlight[page] = Task { [weak self] in
            do {
                let rows = try await api.rows(view: viewID, offset: page * Self.pageSize, limit: Self.pageSize, columns: columns)
                guard !Task.isCancelled else { return }
                self?.finish(page: page, rows: rows)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                let e = error as? APIError ?? APIError.unreachable(error)
                self?.fail(page: page, error: e)
            }
        }
    }

    private func finish(page: Int, rows: [EventRow]) {
        inFlight[page] = nil
        guard !cancelled else { return }
        failed[page] = nil
        store(rows, page: page)
        let start = page * Self.pageSize
        onRowsLoaded?(IndexSet(integersIn: start..<(start + rows.count)))
    }

    private func fail(page: Int, error: APIError) {
        inFlight[page] = nil
        guard !cancelled else { return }
        failed[page] = Date()
        lastError = error
        onError?(error)
        let start = page * Self.pageSize
        // Let the table redraw the rows as failed.
        onRowsLoaded?(IndexSet(integersIn: start..<min(count, start + Self.pageSize)))
    }

    private func store(_ rows: [EventRow], page: Int) {
        pages[page] = rows
        touch(page)
        while pages.count > Self.maxPages, let oldest = recency.first {
            recency.removeFirst()
            pages[oldest] = nil
        }
    }

    private func touch(_ page: Int) {
        if recency.last == page { return }
        if let i = recency.firstIndex(of: page) { recency.remove(at: i) }
        recency.append(page)
    }
}
