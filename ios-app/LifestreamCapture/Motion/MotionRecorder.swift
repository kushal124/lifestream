@preconcurrency import CoreMotion
import Foundation
import LifestreamCaptureCore

struct MotionActivitySnapshot: Sendable, Equatable {
    let startDate: Date
    let stationary: Bool
    let walking: Bool
    let running: Bool
    let automotive: Bool
    let cycling: Bool
    let unknown: Bool
    let confidence: String
    let confidenceRaw: Int
}

struct PedometerSnapshot: Sendable, Equatable {
    let startDate: Date
    let endDate: Date
    let numberOfSteps: String
    let distance: String?
    let floorsAscended: String?
    let floorsDescended: String?
    let currentPace: String?
    let currentCadence: String?
    let averageActivePace: String?
}

struct MotionQueryWindow: Sendable, Equatable {
    let start: Date
    let end: Date
}

enum MotionQueryPlanning {
    static func utcDayWindows(endingAt end: Date, lookbackDays: Int = 7) -> [MotionQueryWindow] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.gmt
        let today = calendar.startOfDay(for: end)
        guard let first = calendar.date(byAdding: .day, value: -lookbackDays, to: today) else {
            return []
        }
        var windows: [MotionQueryWindow] = []
        var cursor = first
        while cursor < end {
            guard let nextDay = calendar.date(byAdding: .day, value: 1, to: cursor) else { break }
            let windowEnd = min(nextDay, end)
            windows.append(.init(start: cursor, end: windowEnd))
            cursor = nextDay
        }
        return windows
    }
}

enum MotionSerialization {
    private static func replayKey(_ parts: [String]) -> String {
        parts.map { "\($0.utf8.count)#\($0)" }.joined()
    }

    static func activityPayload(_ snapshot: MotionActivitySnapshot, delivery: String) -> JSONValue {
        .object([
            "start_date_rfc3339": .string(CaptureTime.rfc3339(snapshot.startDate)),
            "start_date_unix_seconds": .number(snapshot.startDate.timeIntervalSince1970),
            "stationary": .bool(snapshot.stationary),
            "walking": .bool(snapshot.walking),
            "running": .bool(snapshot.running),
            "automotive": .bool(snapshot.automotive),
            "cycling": .bool(snapshot.cycling),
            "unknown": .bool(snapshot.unknown),
            "confidence": .string(snapshot.confidence),
            "confidence_raw": .integer(Int64(snapshot.confidenceRaw)),
            "delivery": .string(delivery),
        ])
    }

    static func pedometerPayload(_ snapshot: PedometerSnapshot) -> JSONValue {
        .object([
            "start_date_rfc3339": .string(CaptureTime.rfc3339(snapshot.startDate)),
            "start_date_unix_seconds": .number(snapshot.startDate.timeIntervalSince1970),
            "end_date_rfc3339": .string(CaptureTime.rfc3339(snapshot.endDate)),
            "end_date_unix_seconds": .number(snapshot.endDate.timeIntervalSince1970),
            "number_of_steps": .string(snapshot.numberOfSteps),
            "distance": snapshot.distance.map(JSONValue.string) ?? .null,
            "floors_ascended": snapshot.floorsAscended.map(JSONValue.string) ?? .null,
            "floors_descended": snapshot.floorsDescended.map(JSONValue.string) ?? .null,
            "current_pace": snapshot.currentPace.map(JSONValue.string) ?? .null,
            "current_cadence": snapshot.currentCadence.map(JSONValue.string) ?? .null,
            "average_active_pace": snapshot.averageActivePace.map(JSONValue.string) ?? .null,
        ])
    }

    static func travelMode(
        automotive: Bool,
        walking: Bool,
        running: Bool,
        cycling: Bool,
        stationary: Bool
    ) -> MotionTravelMode? {
        if automotive { return .vehicle }
        if walking || running || cycling { return .walking }
        if stationary { return .stationary }
        return nil
    }

    static func activityReplayBase(_ snapshot: MotionActivitySnapshot) -> String {
        replayKey([
            "activity", CaptureTime.rfc3339(snapshot.startDate),
            snapshot.stationary ? "1" : "0", snapshot.walking ? "1" : "0",
            snapshot.running ? "1" : "0", snapshot.automotive ? "1" : "0",
            snapshot.cycling ? "1" : "0", snapshot.unknown ? "1" : "0",
            String(snapshot.confidenceRaw),
        ])
    }

    static func pedometerReplayKey(_ snapshot: PedometerSnapshot) -> String {
        replayKey([
            "pedometer", CaptureTime.rfc3339(snapshot.startDate),
            CaptureTime.rfc3339(snapshot.endDate), snapshot.numberOfSteps,
            snapshot.distance ?? "null", snapshot.floorsAscended ?? "null",
            snapshot.floorsDescended ?? "null", snapshot.currentPace ?? "null",
            snapshot.currentCadence ?? "null", snapshot.averageActivePace ?? "null",
        ])
    }
}

struct MotionSweep: Sendable, Equatable {
    let daysRead: Int
    let stepsToday: Int?
}

actor MotionRecorder {
    private let store: CaptureStore
    private weak var locationRecorder: LocationRecorderCoordinator?
    private let activityManager = CMMotionActivityManager()
    private let pedometer = CMPedometer()
    private let callbackQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "org.lifestreamprotocol.phone.motion"
        queue.maxConcurrentOperationCount = 1
        return queue
    }()
    private var liveUpdatesStarted = false
    private var historySweepInProgress = false
    private var historySweepWaiters: [CheckedContinuation<Void, Never>] = []
    private(set) var lastSweep: MotionSweep?

    private let start: @Sendable () async -> Date?

    init(store: CaptureStore, locationRecorder: LocationRecorderCoordinator, start: @escaping @Sendable () async -> Date?) {
        self.store = store
        self.locationRecorder = locationRecorder
        self.start = start
    }

    func bootstrapAfterLocation() async {
        await appendAuthorizationState()
        guard CMMotionActivityManager.authorizationStatus() == .authorized else { return }
        await sweepRecentHistoryCoalesced()
        startLiveUpdates()
    }

    func requestAuthorizationAndSweep() async {
        if CMMotionActivityManager.authorizationStatus() == .notDetermined, CMMotionActivityManager.isActivityAvailable() {
            let now = AppClock.now
            _ = try? await queryActivitySnapshots(from: now.addingTimeInterval(-60), to: now)
        }
        await sweepRecentHistoryCoalesced()
        startLiveUpdates()
        await appendAuthorizationState()
    }

    private func sweepRecentHistoryCoalesced() async {
        if historySweepInProgress {
            await withCheckedContinuation { continuation in
                historySweepWaiters.append(continuation)
            }
            return
        }
        historySweepInProgress = true
        await EnergyLedger.shared.measure(.motion) { await performRecentHistorySweep() }
        historySweepInProgress = false
        let waiters = historySweepWaiters
        historySweepWaiters.removeAll(keepingCapacity: true)
        for waiter in waiters { waiter.resume() }
    }

    func stopLiveUpdates() {
        guard liveUpdatesStarted else { return }
        activityManager.stopActivityUpdates()
        liveUpdatesStarted = false
    }

    private func startLiveUpdates() {
        guard !liveUpdatesStarted, CMMotionActivityManager.isActivityAvailable() else { return }
        liveUpdatesStarted = true
        activityManager.startActivityUpdates(
            to: callbackQueue,
            withHandler: Self.liveActivityHandler(for: self)
        )
    }

    nonisolated private static func liveActivityHandler(
        for recorder: MotionRecorder
    ) -> @Sendable (CMMotionActivity?) -> Void {
        { [weak recorder] activity in
            guard let recorder, let activity else { return }
            let snapshot = activitySnapshot(activity)
            Task { await EnergyLedger.shared.measure(.motion) { await recorder.capture(snapshot, delivery: "live_update") } }
        }
    }

    private func performRecentHistorySweep() async {
        guard await store.historyReadsAdmitted else { return }
        let end = AppClock.now
        let bounds = HistoryStart.motion(
            usualStart: end.addingTimeInterval(-7 * 24 * 60 * 60), since: try? await store.since(.motion),
            start: await start(), calendar: .current)
        let windows = MotionQueryPlanning.utcDayWindows(endingAt: end).filter { $0.end > bounds.activities }
        let pedometerStart = bounds.pedometerDays
        var whole = CMMotionActivityManager.isActivityAvailable()
        if whole {
            do {
                var activities: [MotionActivitySnapshot] = []
                for window in windows {
                    activities.append(
                        contentsOf: try await queryActivitySnapshots(
                            from: max(window.start, bounds.activities),
                            to: window.end
                        ))
                }
                var occurrences: [String: Int] = [:]
                let drafts = activities.map { snapshot -> ReplayCaptureDraft in
                    let base = MotionSerialization.activityReplayBase(snapshot)
                    let occurrence = occurrences[base, default: 0]
                    occurrences[base] = occurrence + 1
                    return .init(
                        replayKey: "\(base):occurrence:\(occurrence)",
                        draft: activityDraft(snapshot, delivery: "seven_day_sweep")
                    )
                }
                let appended = try await store.appendReplayBatch(domain: .motion, drafts: drafts).count
                await appendEvent(
                    "motion_activity_sweep_completed",
                    [
                        "source_snapshots": .integer(Int64(activities.count)),
                        "new_snapshots": .integer(Int64(appended)),
                        "replayed_snapshots_suppressed": .integer(
                            Int64(activities.count - appended)),
                        "fixed_utc_query_windows": .integer(Int64(windows.count)),
                    ])
            } catch {
                whole = false
                await appendEvent(
                    "motion_activity_sweep_failed", ["error": .string(String(describing: error))])
            }
        }
        let days = await capturePedometerDays(from: pedometerStart, to: end)
        if !days.whole { whole = false }
        lastSweep = MotionSweep(daysRead: days.daysRead, stepsToday: days.stepsToday)
        if whole { try? await store.setReadPoint(.motion, .init(at: end)) }
    }

    private func queryActivitySnapshots(
        from start: Date,
        to end: Date
    ) async throws -> [MotionActivitySnapshot] {
        try await withCheckedThrowingContinuation { continuation in
            activityManager.queryActivityStarting(
                from: start,
                to: end,
                to: callbackQueue
            ) { activities, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(
                        returning: (activities ?? []).map(Self.activitySnapshot)
                    )
                }
            }
        }
    }

    private func capture(_ snapshot: MotionActivitySnapshot, delivery: String) async {
        updateLocationMode(from: snapshot)
        do {
            _ = try await store.append(
                domain: .motion, draft: activityDraft(snapshot, delivery: delivery), waiting: true)
        } catch {
            EnergyLedger.shared.count("store_dropped")
        }
    }

    nonisolated private static func activitySnapshot(
        _ activity: CMMotionActivity
    ) -> MotionActivitySnapshot {
        MotionActivitySnapshot(
            startDate: activity.startDate,
            stationary: activity.stationary,
            walking: activity.walking,
            running: activity.running,
            automotive: activity.automotive,
            cycling: activity.cycling,
            unknown: activity.unknown,
            confidence: confidenceName(activity.confidence),
            confidenceRaw: activity.confidence.rawValue
        )
    }

    private func activityDraft(_ snapshot: MotionActivitySnapshot, delivery: String) -> CaptureDraft
    {
        .init(
            kind: "activity",
            observedAt: CaptureTime.rfc3339(snapshot.startDate),
            payload: MotionSerialization.activityPayload(snapshot, delivery: delivery)
        )
    }

    private func updateLocationMode(from snapshot: MotionActivitySnapshot) {
        let mode = MotionSerialization.travelMode(
            automotive: snapshot.automotive,
            walking: snapshot.walking,
            running: snapshot.running,
            cycling: snapshot.cycling,
            stationary: snapshot.stationary
        )
        guard let mode else { return }
        Task { @MainActor [weak locationRecorder] in
            locationRecorder?.motionActivityChanged(mode)
        }
    }

    private func capturePedometerDays(from start: Date, to end: Date) async -> (whole: Bool, daysRead: Int, stepsToday: Int?) {
        guard CMPedometer.isStepCountingAvailable() else {
            await appendEvent("pedometer_unavailable", [:])
            return (false, 0, nil)
        }
        var whole = true
        var daysRead = 0
        var stepsToday: Int?
        let calendar = Calendar.current
        var dayStart = start
        while dayStart < end {
            guard let nextDay = calendar.date(byAdding: .day, value: 1, to: dayStart) else {
                await appendEvent(
                    "pedometer_query_failed",
                    [
                        "start": .string(CaptureTime.rfc3339(dayStart)),
                        "error": .string("calendar could not calculate the next local day"),
                    ])
                return (false, daysRead, stepsToday)
            }
            let dayEnd = min(nextDay, end)
            do {
                let snapshot = try await queryPedometerSnapshot(from: dayStart, to: dayEnd)
                daysRead += 1
                if dayEnd == end { stepsToday = Int(snapshot.numberOfSteps) }
                _ = try await store.appendReplayBatch(
                    domain: .motion,
                    drafts: [
                        .init(
                            replayKey: MotionSerialization.pedometerReplayKey(snapshot),
                            draft: .init(
                                kind: "pedometer_day",
                                observedAt: CaptureTime.rfc3339(dayStart),
                                payload: MotionSerialization.pedometerPayload(snapshot)
                            )
                        )
                    ]
                )
            } catch {
                whole = false
                await appendEvent(
                    "pedometer_query_failed",
                    [
                        "start": .string(CaptureTime.rfc3339(dayStart)),
                        "error": .string(String(describing: error)),
                    ])
            }
            dayStart = dayEnd
        }
        return (whole, daysRead, stepsToday)
    }

    private func queryPedometerSnapshot(
        from start: Date,
        to end: Date
    ) async throws -> PedometerSnapshot {
        try await withCheckedThrowingContinuation { continuation in
            pedometer.queryPedometerData(from: start, to: end) { data, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let data {
                    continuation.resume(returning: Self.pedometerSnapshot(data))
                } else {
                    continuation.resume(
                        throwing: CaptureError.corruptState("pedometer returned no data")
                    )
                }
            }
        }
    }

    nonisolated private static func pedometerSnapshot(
        _ data: CMPedometerData
    ) -> PedometerSnapshot {
        .init(
            startDate: data.startDate,
            endDate: data.endDate,
            numberOfSteps: data.numberOfSteps.stringValue,
            distance: data.distance?.stringValue,
            floorsAscended: data.floorsAscended?.stringValue,
            floorsDescended: data.floorsDescended?.stringValue,
            currentPace: data.currentPace?.stringValue,
            currentCadence: data.currentCadence?.stringValue,
            averageActivePace: data.averageActivePace?.stringValue
        )
    }

    private func appendAuthorizationState() async {
        await appendEvent(
            "motion_authorization",
            [
                "status": .string(
                    String(describing: CMMotionActivityManager.authorizationStatus())),
                "activity_available": .bool(CMMotionActivityManager.isActivityAvailable()),
                "step_counting_available": .bool(CMPedometer.isStepCountingAvailable()),
            ])
    }

    private func appendEvent(_ event: String, _ detail: [String: JSONValue]) async {
        _ = try? await store.append(
            domain: .motion,
            draft: .init(
                kind: "recorder_event",
                observedAt: CaptureTime.rfc3339(AppClock.now),
                payload: .object(["event": .string(event), "detail": .object(detail)])
            ),
            waiting: true
        )
    }

    nonisolated private static func confidenceName(
        _ confidence: CMMotionActivityConfidence
    ) -> String {
        switch confidence {
        case .low: "low"
        case .medium: "medium"
        case .high: "high"
        @unknown default: "unknown_\(confidence.rawValue)"
        }
    }
}
