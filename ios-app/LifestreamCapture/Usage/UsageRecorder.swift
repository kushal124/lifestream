import Foundation
import LifestreamCaptureCore

struct UsageCaptureStatus: Sendable {
    var authorization: UsageAuthorization = .notDetermined
    var isRefreshing = false
    var catalogPending = false
    var catalogError: String?
    var lastCompleted: Date?
    var lastSourceUpdate: Date?
    var error: String?
    var backfillNext: Date?
    var backfillEnd: Date?
    var earliest: Date?
}

struct UsageCursor: Codable, Sendable {
    var recentCompleted: Date?
    var catalogCompleted: Date?
    var backgroundAttempt: Date?
    var lastSourceUpdate: Date?
    var auditNext: Date?
    var backfillNext: Date?
    var backfillEnd: Date?

    static func load(_ url: URL) throws -> Self {
        guard let data = try FileDurability.readRegularFileIfPresent(at: url, maximumBytes: 16_384)
        else { return .init() }
        let value = try JSONDecoder.lifestream().decode(Self.self, from: data)
        guard (value.backfillNext == nil) == (value.backfillEnd == nil),
            [value.recentCompleted, value.catalogCompleted, value.backgroundAttempt,
             value.lastSourceUpdate, value.auditNext, value.backfillNext, value.backfillEnd]
                .compactMap({ $0 }).allSatisfy({ $0.timeIntervalSince1970.isFinite })
        else { throw CaptureError.corruptState("Usage refresh state is invalid") }
        return value
    }

    func save(_ url: URL) throws {
        let bytes = try JSONEncoder.lifestream().encode(self)
        try FileDurability.createDirectoryDurably(at: url.deletingLastPathComponent())
        try bytes.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try FileDurability.synchronizeFile(at: url)
        try FileDurability.synchronizeParentDirectory(of: url)
    }
}

enum UsageRefreshReason: Int, Sendable {
    case background, foreground, manual, backfill
}

actor UsageRecorder {
    private let store: CaptureStore
    private let source: any UsageActivitySource
    private let cursorURL: URL
    private let inbox: UsageInbox?
    private let admit: @Sendable () async throws -> Void
    private let now: @Sendable () -> Date
    private let start: @Sendable () async -> Date?
    private let calendar: Calendar
    private var cursor = UsageCursor()
    private var loaded = false
    private var status = UsageCaptureStatus()
    private var flight: Task<Void, Never>?
    private var pending: UsageRefreshReason?
    private var catalogFlight: Task<Void, Never>?

    private struct AcquisitionSummary {
        var seen = 0
        var written = 0
        var contexts: [JSONValue] = []
        var sourceUpdate: Date?
    }
    private var queryWritten = 0
    private var querySeen = 0
    private var queryContexts: [JSONValue] = []
    private var contextBytes = 0
    private var querySourceUpdate: Date?

    init(store: CaptureStore, source: any UsageActivitySource, cursorURL: URL,
         inbox: UsageInbox? = nil, calendar: Calendar = .current,
         now: @escaping @Sendable () -> Date = { AppClock.now },
         start: @escaping @Sendable () async -> Date?,
         admit: @escaping @Sendable () async throws -> Void) {
        self.store = store; self.source = source; self.cursorURL = cursorURL
        self.inbox = inbox; self.calendar = calendar; self.now = now; self.start = start; self.admit = admit
    }

    func snapshot() async -> UsageCaptureStatus {
        do { try loadCursor() } catch { status.error = error.localizedDescription }
        status.earliest = await earliest()
        status.authorization = await source.authorization()
        return status
    }

    func requestAuthorization() async throws {
        try await admit()
        try await source.requestAuthorization()
        status.authorization = await source.authorization()
    }

    func refresh(_ reason: UsageRefreshReason = .foreground) async -> UsageCaptureStatus {
        if let flight {
            if pending == nil || reason.rawValue > pending!.rawValue { pending = reason }
            await flight.value
            return status
        }
        let task = Task { await self.runFlight(reason) }
        flight = task
        await task.value
        return status
    }

    func cancelRefresh() {
        pending = nil
        flight?.cancel()
        catalogFlight?.cancel()
    }

    func beginBackfill(from first: Date, through end: Date) async throws {
        try await admit()
        try loadCursor()
        guard first.timeIntervalSince1970.isFinite, end.timeIntervalSince1970.isFinite, first <= end, end <= now() else {
            throw CaptureError.invalidEntry("Choose a past date range in chronological order")
        }
        let next = max(calendar.startOfDay(for: first), await earliest() ?? .distantPast)
        let after = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: end))!
        guard next < after else { throw CaptureError.invalidEntry("Choose days on or after the start") }
        cursor.backfillNext = next
        cursor.backfillEnd = after
        try cursor.save(cursorURL)
        updateStatus()
    }

    private func earliest() async -> Date? {
        HistoryStart.usage(start: await start(), calendar: calendar)
    }

    func stopBackfill() throws {
        try loadCursor()
        cursor.backfillNext = nil; cursor.backfillEnd = nil
        try cursor.save(cursorURL)
        updateStatus()
    }

    func recordMarker(label: String, event: String, createdAt: Date, deliveryID: UUID = UUID()) async throws {
        try await admit()
        guard !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, label.utf8.count <= 256, ["opened", "closed"].contains(event),
              createdAt.timeIntervalSince1970.isFinite else {
            throw CaptureError.invalidEntry("Choose an app label of 1–256 bytes and an opened or closed event")
        }
        let receivedAt = now()
        _ = try await store.append(domain: .usage, draft: .init(
            kind: "shortcut_marker", observedAt: CaptureTime.rfc3339(createdAt), payload: .object([
                "delivery_id": .string(deliveryID.uuidString.lowercased()),
                "configured_app_label": .string(label), "event": .string(event),
                "marker_created_at": Self.dateValue(createdAt),
                "received_at": Self.dateValue(receivedAt),
                "identity_origin": .string("user_configured_shortcuts_label")
            ])))
    }

    private func runFlight(_ initial: UsageRefreshReason) async {
        status.isRefreshing = true
        var reason: UsageRefreshReason? = initial
        while let next = reason {
            pending = nil
            do { try await run(next) } catch { status.error = error.localizedDescription }
            reason = Task.isCancelled ? nil : pending
        }
        status.isRefreshing = false
        flight = nil
    }

    private func run(_ reason: UsageRefreshReason) async throws {
        try await EnergyLedger.shared.measure(.usage) { try await runMeasured(reason) }
    }

    private func runMeasured(_ reason: UsageRefreshReason) async throws {
        try await admit()
        try loadCursor()
        status.error = nil
        let started = now()
        let today = calendar.startOfDay(for: started)
        let earliest = await self.earliest() ?? .distantPast
        do {
            try await drainInbox(try readInbox())
        } catch { status.error = error.localizedDescription }
        if reason == .background,
           let prior = cursor.backgroundAttempt, started.timeIntervalSince(prior) < 3_600 { return }
        if reason == .foreground,
           let prior = cursor.recentCompleted, started.timeIntervalSince(prior) < 900 { return }
        if reason == .background {
            cursor.backgroundAttempt = started
            try cursor.save(cursorURL)
        }
        status.authorization = await source.authorization()
        guard status.authorization == .approvedWithDataAccess else { return }
        let live = reason == .manual || reason == .backfill
        if reason == .backfill {
            try await advanceBackfill(maximumDays: 3, from: earliest, live: true)
            updateStatus()
            return
        }
        let oldestAudit = max(calendar.date(byAdding: .day, value: -30, to: today)!, earliest)
        let auditEnd = calendar.date(byAdding: .day, value: -7, to: today)!
        let old = cursor.auditNext.map { $0 >= oldestAudit && $0 < auditEnd ? $0 : oldestAudit } ?? oldestAudit
        var recentSucceeded = true
        for offset in 0...7 {
            try Task.checkCancellation()
            let start = calendar.date(byAdding: .day, value: -offset, to: today)!
            guard start >= earliest else { break }
            let interval = DateInterval(start: start, end: calendar.date(byAdding: .day, value: 1, to: start)!)
            do { try await acquire(interval, live: live) }
            catch {
                recentSucceeded = false
                status.error = error.localizedDescription
                if error is CancellationError { throw error }
            }
        }
        if recentSucceeded {
            cursor.recentCompleted = now()
            try cursor.save(cursorURL)
            updateStatus()
        }
        try Task.checkCancellation()
        if old < auditEnd {
            do {
                let interval = DateInterval(start: old, end: calendar.date(byAdding: .day, value: 1, to: old)!)
                try await acquire(interval, live: live)
                let following = calendar.date(byAdding: .day, value: 1, to: old)!
                cursor.auditNext = following < auditEnd ? following : oldestAudit
                try cursor.save(cursorURL)
            } catch { status.error = error.localizedDescription }
        }
        if live || cursor.catalogCompleted.map({ !calendar.isDate($0, inSameDayAs: started) }) ?? true {
            startCatalog(day: today)
        }
        try await advanceBackfill(maximumDays: 1, from: earliest, live: live)
        updateStatus()
    }

    private func advanceBackfill(maximumDays: Int, from earliest: Date, live: Bool) async throws {
        if let next = cursor.backfillNext, let end = cursor.backfillEnd, next < earliest {
            cursor.backfillNext = earliest < end ? earliest : nil
            cursor.backfillEnd = earliest < end ? end : nil
            try cursor.save(cursorURL)
        }
        for _ in 0..<maximumDays {
            try Task.checkCancellation()
            guard let next = cursor.backfillNext, let end = cursor.backfillEnd, next < end else { return }
            let nextEnd = min(calendar.date(byAdding: .day, value: 1, to: next)!, end)
            try await acquire(.init(start: next, end: nextEnd), live: live)
            if cursor.backfillNext == next {
                cursor.backfillNext = nextEnd < end ? nextEnd : nil
                cursor.backfillEnd = nextEnd < end ? end : nil
                try cursor.save(cursorURL)
            }
        }
    }

    private func acquire(_ interval: DateInterval, live: Bool) async throws {
        let started = now()
        resetQuery()
        do {
            try Task.checkCancellation()
            guard await source.authorization() == .approvedWithDataAccess else {
                throw CaptureError.invalidEntry("Screen Time data access is no longer approved")
            }
            try await source.fetch(interval: interval, live: live, onContext: { context in
                try await self.receiveContext(context)
            }) { payload, observedAt in
                try Task.checkCancellation()
                try await self.receiveSegment(payload, observedAt: observedAt)
            }
            try Task.checkCancellation()
            try await recordAcquisition(interval, started: started, live: live, outcome: "successful", error: nil)
        } catch {
            try await recordAcquisition(interval, started: started, live: live,
                outcome: error is CancellationError ? "cancelled" : (querySeen > 0 ? "partial" : "failed"), error: error)
            throw error
        }
    }

    private func startCatalog(day: Date) {
        guard catalogFlight == nil, !Task.isCancelled else { return }
        status.catalogPending = true
        status.catalogError = nil
        catalogFlight = Task {
            defer { catalogFlight = nil; status.catalogPending = false }
            do { try await acquireCatalog(day: day) }
            catch { status.catalogError = error.localizedDescription }
        }
    }

    private func acquireCatalog(day: Date) async throws {
        let started = now()
        var summary = AcquisitionSummary()
        let interval = DateInterval(start: day, end: calendar.date(byAdding: .day, value: 1, to: day)!)
        do {
            try Task.checkCancellation()
            try await admit()
            let payload = try await source.catalog()
            try Task.checkCancellation()
            try await admit()
            summary.seen = 1
            summary.written = try await persistSnapshot(payload, kind: "activity_catalog", observedAt: day,
                                                        scope: Self.dateValue(day))
            guard case .object(let members) = payload, members["complete"] == .bool(true) else {
                throw CaptureError.invalidEntry("Some Screen Time catalog fields are unavailable; refresh to retry")
            }
            try await recordAcquisition(interval, started: started, live: false,
                                        outcome: "successful", error: nil, family: "catalog", summary: summary)
            cursor.catalogCompleted = started
            try cursor.save(cursorURL)
        } catch {
            try await recordAcquisition(interval, started: started, live: false,
                outcome: error is CancellationError ? "cancelled" : (summary.seen > 0 ? "partial" : "failed"),
                error: error, family: "catalog", summary: summary)
            throw error
        }
    }

    private func receiveSegment(_ payload: JSONValue, observedAt: Date) async throws {
        querySeen += 1
        let written = try await persistSnapshot(payload, kind: "activity_segment", observedAt: observedAt,
                                                 scope: nil)
        queryWritten += written
    }

    private func persistSnapshot(_ raw: JSONValue, kind: String, observedAt: Date,
                                 scope: JSONValue?) async throws -> Int {
        try Task.checkCancellation()
        guard await source.authorization() == .approvedWithDataAccess else { throw UsageSourceError.unauthorized }
        var members: [String: JSONValue] = ["data": raw]
        if let scope { members["scope"] = scope }
        let payload: JSONValue = .object(members)
        let bytes = try JSONEncoder.lifestream().encode(payload)
        guard bytes.count <= 4 * 1_024 * 1_024 else {
            throw CaptureError.invalidEntry("A usage snapshot exceeds the 4 MiB record limit; no data was truncated")
        }
        var comparison = members
        if kind == "activity_segment", case .object(var fields) = raw {
            for key in ["lastUpdatedDate", "osVersion", "sdk", "xcodeBuild"] { fields.removeValue(forKey: key) }
            if case .object(var interval)? = fields["segmentInterval"] {
                interval.removeValue(forKey: "during")
                fields["segmentInterval"] = .object(interval)
            }
            comparison["data"] = .object(fields)
        }
        let digest = SHA256Digest.hex(try JSONEncoder.lifestream().encode(JSONValue.object(comparison)))
        let written = try await store.appendReplayBatch(domain: .usage, drafts: [.init(
            replayKey: "\(kind):\(digest)",
            draft: .init(kind: kind, observedAt: CaptureTime.rfc3339(observedAt), payload: payload))])
        return written.count
    }

    private func resetQuery() {
        queryWritten = 0; querySeen = 0; queryContexts = []; contextBytes = 0; querySourceUpdate = nil
    }

    private func receiveContext(_ context: JSONValue) throws {
        if queryContexts.contains(context) { return }
        let bytes = try JSONEncoder.lifestream().encode(context).count
        guard queryContexts.count < 64, bytes <= 1_048_576 - contextBytes else {
            throw CaptureError.invalidEntry("Usage returned too much reporting context; request remains incomplete")
        }
        queryContexts.append(context); contextBytes += bytes
        if case .object(let fields) = context,
           case .object(let update)? = fields["lastUpdatedDate"],
           case .number(let epoch)? = update["epochSeconds"] {
            let date = Date(timeIntervalSince1970: epoch)
            querySourceUpdate = max(querySourceUpdate ?? date, date)
        }
    }

    private func recordAcquisition(_ interval: DateInterval, started: Date, live: Bool,
                                   outcome: String, error: (any Error)?, family: String = "activity",
                                   summary: AcquisitionSummary? = nil) async throws {
        let summary = summary ?? AcquisitionSummary(seen: querySeen, written: queryWritten,
                                                     contexts: queryContexts, sourceUpdate: querySourceUpdate)
        _ = try await store.append(domain: .usage, draft: .init(kind: "usage_acquisition",
            observedAt: CaptureTime.rfc3339(started), payload: .object([
                "family": .string(family),
                "request_context": Self.requestContext(family: family),
                "requested_interval": Self.intervalValue(interval),
                "started_at": Self.dateValue(started), "finished_at": Self.dateValue(now()),
                "fetch_policy": family == "catalog" ? .null : .string(live ? "live" : "cached"), "outcome": .string(outcome),
                "new_snapshots": .integer(Int64(summary.written)),
                "returned_snapshots": .integer(Int64(summary.seen)),
                "returned_contexts": .array(summary.contexts),
                "last_source_update": summary.sourceUpdate.map(Self.dateValue) ?? .null,
                "calendar": .string(String(describing: calendar.identifier)),
                "time_zone": .string(calendar.timeZone.identifier),
                "error": error.map(Self.errorValue) ?? .null
            ])))
        if let date = summary.sourceUpdate {
            cursor.lastSourceUpdate = max(cursor.lastSourceUpdate ?? date, date)
            updateStatus()
        }
    }

    private func readInbox() throws -> [(UsageInboxItem, Date)] {
        guard let inbox else { return [] }
        return try inbox.pending(limit: 64).map { item in
            guard case .object(let payload) = item.payload,
                  case .string(let text)? = payload["observed_at"],
                  let date = CaptureTime.date(rfc3339: text) else {
                throw CaptureError.invalidEntry("A usage callback has no valid delivery time; its file was retained")
            }
            return (item, date)
        }
    }

    private func drainInbox(_ dated: [(UsageInboxItem, Date)]) async throws {
        guard let inbox, !dated.isEmpty else { return }
        let drafts = dated.map { item, date in
            ReplayCaptureDraft(replayKey: "monitor_callback:\(item.deliveryID.uuidString.lowercased())",
                draft: .init(kind: "monitor_callback", observedAt: CaptureTime.rfc3339(date), payload: item.payload))
        }
        _ = try await store.appendReplayBatch(domain: .usage, drafts: drafts)
        for (item, _) in dated { try inbox.acknowledge(item) }
    }

    private func loadCursor() throws {
        guard !loaded else { return }
        cursor = try UsageCursor.load(cursorURL)
        loaded = true
        updateStatus()
    }

    private func updateStatus() {
        status.lastCompleted = cursor.recentCompleted
        status.lastSourceUpdate = cursor.lastSourceUpdate
        status.backfillNext = cursor.backfillNext
        status.backfillEnd = cursor.backfillEnd
    }

    static func requestContext(family: String) -> JSONValue {
        .object([
            "osVersion": .string(ProcessInfo.processInfo.operatingSystemVersionString),
            "sdk": (Bundle.main.object(forInfoDictionaryKey: "DTSDKName") as? String).map(JSONValue.string) ?? .null,
            "xcodeBuild": (Bundle.main.object(forInfoDictionaryKey: "DTXcodeBuild") as? String).map(JSONValue.string) ?? .null,
            "scope": family == "catalog" ? .string("family_activity_catalog") : .object([
                "device": .string("current"), "user": .string("current"), "segment": .string("hourly"),
                "applications": .array([]), "categories": .array([]), "webDomains": .array([])
            ])
        ])
    }

    static func dateValue(_ value: Date) -> JSONValue {
        .object(["epoch_seconds": .number(value.timeIntervalSince1970),
                 "rfc3339": .string(CaptureTime.rfc3339(value))])
    }
    static func intervalValue(_ value: DateInterval) -> JSONValue {
        .object(["start": dateValue(value.start), "end": dateValue(value.end)])
    }
    static func errorValue(_ error: any Error) -> JSONValue {
        let error = error as NSError
        return .object(["domain": .string(error.domain), "code": .integer(Int64(error.code)),
                        "description": .string(error.localizedDescription)])
    }
}
