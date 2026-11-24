import Evidence
import Foundation
import Screen
import Spool

@MainActor public final class Recorder {
    static let waitingLimit = 6
    public private(set) var configuration: RecorderConfiguration
    private let dependencies: RecorderDependencies
    private var acquisition: any RecorderAcquisition { dependencies.acquisition }
    private var clock: any RecorderClock { dependencies.clock }
    private var lifecycle = RecorderLifecycle()
    private var gate: CaptureGate
    private let statusWriter: RuntimeStatusWriter
    private var written: (transition: RuntimeStatus.Transition, uptime: Double)?
    private var attempt = CaptureTimings()
    var held: Int { lifecycle.run?.publications.held ?? 0 }
    public private(set) var off: Set<Producer> = []
    private var report = RuntimeStatus(state: .stopped)
    public private(set) var modes: RecordingModes
    public var changed: (() -> Void)?
    public var modesSet: ((RecordingModes) throws -> Void)?

    static let statusHeartbeat: Double = 60
    static let activityReason = "Recording the screen on its cadence"
    private var tenureStreak = FailureLines.Streak(closing: .tenureOpened)
    private var statusStreak = FailureLines.Streak(closing: .statusWritten)
    private var compactionStreak = FailureLines.Streak(closing: .compactionRecovered)
    private var owed: [RuntimeStatus.OwedSpan] = []

    init(configuration: RecorderConfiguration, dependencies: RecorderDependencies) {
        self.configuration = configuration
        self.dependencies = dependencies
        modes = dependencies.modes
        statusWriter = RuntimeStatusWriter(write: dependencies.persistStatus)
        owed = Self.owed(after: dependencies.previous)
        let state = dependencies.machine.availability
        gate = CaptureGate(displayAwake: state.displayAwake, sessionActive: state.sessionActive)
        dependencies.machine.availabilityChanged = { [weak self] availability in
            guard let self else { return }
            updateAvailability(availability)
            if lifecycle.run == nil { gate.consume(through: gate.generation) }
            acquisition.invalidate()
        }
    }

    public var status: RuntimeStatus {
        var status = report
        status.state = lifecycle.state
        status.message = lifecycle.message
        let waiting = lifecycle.run?.publications.waiting ?? 0
        status.pendingFrames = waiting > 0 ? waiting : nil
        var spans = owed
        if let closure = lifecycle.run?.closure {
            spans.append(RuntimeStatus.OwedSpan(reason: closure.reason.rawValue, from: closure.from))
        }
        status.owed = spans.isEmpty ? nil : spans
        return status
    }

    public var running: Bool { lifecycle.running }
    public var stopping: Bool { lifecycle.stopping }

    @discardableResult
    public func setMode(_ mode: RecordingMode, for target: RecordingModeTarget) throws -> RecordingModes {
        var next = modes
        switch target {
        case .app(let bundleID): try next.set(mode, for: bundleID)
        case .site(let rule): try next.setSite(mode, for: rule)
        }
        let saved = Result { try setModes(next) }
        try modesSet?(modes)
        try saved.get()
        return next
    }

    public func setModes(_ next: RecordingModes) throws {
        guard next != modes else { return }
        modes = next
        acquisition.setModes(next)
        dependencies.input.setModes(next)
        dependencies.machine.setModes(next)
        dependencies.audio.setModes(next)
        try dependencies.persistModes(next)
    }

    public func take(interval: Double, idlePauseAfter: Double?, ocr: OCRMode) {
        let interval = min(max(interval, 1), 300)
        acquisition.setOCR(ocr)
        let next = RecorderConfiguration(interval: interval, duration: configuration.duration, idlePauseAfter: idlePauseAfter)
        guard next != configuration else { return }
        let sooner = interval != configuration.interval
        configuration = next
        if sooner { lifecycle.run?.napping?.cancel() }
    }

    public func setOff(_ next: Set<Producer>) {
        guard next != off else { return }
        if off.contains(.screen), !next.contains(.screen), let run = lifecycle.run, lifecycle.records(run) { beginCapturing() }
        off = next
        settleProducers()
        if next.contains(.screen) { acquisition.invalidate() }
        changed?()
    }

    public func waitUntilStopped() async {
        _ = try? await lifecycle.run?.task?.value
    }

    public func start(duration: Double? = nil) throws {
        let stopAt = (duration ?? configuration.duration).map { clock.uptime + $0 }
        let run = makeRun(oneShot: false, stopAt: stopAt)
        switch move(.start(run)) {
        case .refused(let refusal):
            throw refusal
        case .unchanged:
            dependencies.resources?.start()
            lifecycle.run?.stopAt = stopAt
            return
        case .moved:
            dependencies.resources?.start()
        }
        beginCapturing()
        note(.runStarted)
        run.task = Task { [self] in
            defer { released(run) }
            do {
                try await openTenure(run)
                await record(run)
            } catch {
            }
            await finish(run)
        }
        persistStatus()
    }

    public func stop() async {
        guard let run = lifecycle.run else {
            move(.stop)
            persistStatus()
            try? await statusWriter.drain()
            await dependencies.resources?.cut()
            return
        }
        close(run)
        _ = try? await run.task?.value
        await dependencies.resources?.cut()
    }

    public func captureOnce() async throws {
        guard acquisition.screenRecordingAllowed else {
            if case .refused(let refusal) = move(.refusedWithoutGrant) { throw refusal }
            return
        }
        let run = makeRun(oneShot: true, stopAt: nil)
        if case .refused(let refusal) = move(.oneShot(run)) { throw refusal }
        let recordedBefore = report.recorded
        beginCapturing()
        note(.runStarted)
        let task = Task { [self] in
            defer { released(run) }
            do {
                try await openTenure(run)
                try await captureOne(run: run)
                try await run.publications.settle()
                try Task.checkCancellation()
                move(.ended(run, report.recorded > recordedBefore ? .captured : .gap))
            } catch {
                move(.ended(run, .stopped))
                await finish(run)
                throw error
            }
            await finish(run)
            try Task.checkCancellation()
        }
        run.task = task
        try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            Task { @MainActor [weak self] in self?.close(run) }
        }
    }


    @discardableResult
    private func move(_ event: RecorderLifecycle.Event) -> RecorderLifecycle.Taken {
        let before = face
        let taken = lifecycle.take(event)
        dependencies.resources?.states.set(.capturing, lifecycle.capturing)
        if face != before { changed?() }
        return taken
    }

    private struct Face: Equatable {
        let state: RecorderState
        let message: String?
        let running: Bool
        let stopping: Bool
    }

    private var face: Face {
        Face(state: lifecycle.state, message: lifecycle.message, running: lifecycle.running, stopping: lifecycle.stopping)
    }

    private func makeRun(oneShot: Bool, stopAt: Double?) -> Run {
        Run(oneShot: oneShot, stopAt: stopAt, began: clock.date) { [weak self] run, error in self?.storageLost(run, error) }
    }

    private func released(_ run: Run) {
        move(.released(run))
        note(.runEnded)
    }

    private func note(_ event: FailureLines.Event, since: Date? = nil) {
        dependencies.failures.note(event, since: since, at: clock.date)
    }

    private func close(_ run: Run) {
        guard lifecycle.run === run else { return }
        if run.stoppedAt == nil { run.stoppedAt = clock.date }
        move(.stop)
        acquisition.invalidate()
        run.task?.cancel()
    }

    private func storageLost(_ run: Run, _ error: Error) {
        guard lifecycle.run === run else { return }
        acquisition.invalidate()
        run.napping?.cancel()
        guard run.lost == nil else { return }
        let failure = StorageFailure(error, at: clock.date)
        run.lost = failure
        report.storageFailure = failure
        if !run.oneShot {
            tenureStreak.failed(.tenureLost, kind: failure.kind, errno: failure.errno, at: failure.at,
                                lines: dependencies.failures)
        }
        if !run.oneShot, lifecycle.records(run) {
            let after = run.lastAppended.map { $0.addingTimeInterval(configuration.interval) } ?? run.began
            openLostClosure(run, failure, at: after)
        }
        move(.storageLost(run))
        persistStatus()
    }

    private func settleProducers(seal: Bool = false) {
        let (stop, start) = lifecycle.settle(off: off, seal: seal)
        for part in stop {
            switch part {
            case .machine: dependencies.machine.stop()
            case .input: dependencies.input.stop()
            case .audio: dependencies.audio.stop()
            }
        }
        for part in start {
            switch part {
            case .machine: dependencies.machine.start()
            case .input: dependencies.input.start()
            case .audio: dependencies.audio.start()
            }
        }
        readInputStatus()
    }

    private func attempting(_ run: Run) -> Bool {
        lifecycle.records(run) && !Task.isCancelled
    }


    private func openTenure(_ run: Run, napFirst: Bool = false) async throws {
        var napFirst = napFirst
        while true {
            if napFirst { try await recoveryNap(run) }
            napFirst = true
            try goesOn(run)
            do {
                run.begin(try await dependencies.openStore())
                try goesOn(run)
                if !run.opened { try await stateOpening(run) }
                break
            } catch {
                if Task.isCancelled || error is CancellationError { throw CancellationError() }
                if run.oneShot { throw error }
                openingFailed(run, error)
            }
        }
        updateAvailability(dependencies.machine.availability)
        gate.consume(through: gate.generation)
        await publishOwedSpans(run)
        if !run.oneShot, run.lost == nil { startCompaction(run) }
    }

    private func stateOpening(_ run: Run) async throws {
        move(.opened(run))
        persistStatus()
        do {
            try await statusWriter.drain()
        } catch {
            statusFailed(error)
            throw error
        }
        try goesOn(run)
        move(.stated(run))
        run.opened = true
        run.activity = dependencies.holdActivity(Self.activityReason)
        settleProducers()
        changed?()
    }

    private func openingFailed(_ run: Run, _ error: Error) {
        run.drop()
        let failure = StorageFailure(error, at: clock.date)
        if run.lost == nil, report.storageFailure.map({ $0.at < run.began }) ?? true { report.storageFailure = failure }
        tenureStreak.failed(.openingFailed, kind: failure.kind, errno: failure.errno, at: failure.at,
                            lines: dependencies.failures)
        if !run.opened {
            move(.openingFailed(run))
            if run.closure == nil {
                endUncleanEnd(at: run.began)
                openLostClosure(run, failure, at: run.began)
            }
        }
        persistStatus()
    }

    private func openLostClosure(_ run: Run, _ failure: StorageFailure, at after: Date) {
        let reason: CaptureGapReason = failure.diskFull ? .storageBackpressure : .storageFailed
        let owedUntil = owed.compactMap(\.until).max() ?? run.began
        run.closure = Run.Closure(reason: reason, openedAt: max(after, run.began, owedUntil), interval: configuration.interval,
                                  lost: true)
        report.lastGapReason = reason.rawValue
    }

    private func endUncleanEnd(at date: Date) {
        for index in owed.indices where owed[index].until == nil { owed[index].until = max(date, owed[index].from) }
    }

    private func publishOwedSpans(_ run: Run) async {
        guard let store = run.store else { return }
        do {
            try await publishPastSpans(run, to: store)
            if let closure = run.closure, !(closure.reason == .storageBackpressure && store.hasBackpressure()) {
                try await endClosure(run, at: clock.date)
            }
            settleFailure(run)
        } catch {
        }
        persistStatusIfDue()
    }

    private func publishPastSpans(_ run: Run, to store: any RecorderStorage) async throws {
        place(against: store, at: clock.date)
        while let span = owed.first {
            try await publishSpan(span, run: run, to: store)
            owed.removeAll { $0 == span }
            persistStatusIfDue()
        }
    }

    private func publishEnded(_ span: RuntimeStatus.OwedSpan, run: Run, to store: any RecorderStorage) async throws {
        owed.append(span)
        try await publishSpan(span, run: run, to: store, stands: true)
        owed.removeAll { $0 == span }
    }

    private func publishSpan(_ span: RuntimeStatus.OwedSpan, run: Run, to store: any RecorderStorage,
                             stands: Bool = false) async throws {
        var gap = CaptureObservation(capturedAt: span.from, displayID: 0, width: 0, height: 0, status: "gap",
                                     reason: span.reason)
        gap.capturedUntil = span.until
        try await run.publications.ordered { [self] in
            try await append(gap, image: nil, to: store, run: run, stands: stands, bundle: span.bundle)
        }.value
    }

    private func place(against store: any RecorderStorage, at opening: Date) {
        let interval = configuration.interval
        owed = owed.compactMap { span in
            guard let lived = span.lived else { return span }
            var placed = span
            placed.lived = nil
            if let newest = store.newestObservation {
                placed.from = max(placed.from, newest.end.addingTimeInterval(interval))
            } else if store.newestUnreadable {
                placed.from = max(placed.from, lived)
            }
            let until = placed.until ?? opening
            placed.until = until
            guard until.timeIntervalSince(placed.from) > interval else { return nil }
            placed.bundle = CaptureStore.bundleName(for: placed.from)
            note(.uncleanEnd, since: placed.from)
            return placed
        }
    }

    static func owed(after previous: RuntimeStatus?) -> [RuntimeStatus.OwedSpan] {
        guard let previous else { return [] }
        let inherited = previous.owed ?? []
        var spans = inherited.filter { $0.until != nil }
        switch previous.state {
        case .stopped, .captured, .gap: return spans
        case .starting, .recording, .waiting, .recovering, .permissionRequired: break
        }
        let open = inherited.first { $0.until == nil }
        if let open, open.reason == CaptureGapReason.recorderNotRunning.rawValue {
            spans.append(open)
            return spans
        }
        var bounds = [previous.capturingSince, open?.from, spans.compactMap(\.until).max()].compactMap { $0 }
        let held = previous.storageFailure != nil || open != nil
        if !held, previous.state == .recording || previous.state == .permissionRequired { bounds.append(previous.updatedAt) }
        spans.append(RuntimeStatus.OwedSpan(reason: CaptureGapReason.recorderNotRunning.rawValue,
                                            from: bounds.max() ?? previous.updatedAt, lived: previous.updatedAt))
        return spans
    }

    private func settleFailure(_ run: Run) {
        guard run.store != nil, run.lost == nil, run.closure?.lost != true, owed.isEmpty else { return }
        report.storageFailure = nil
    }

    private func recover(_ run: Run) async throws {
        await endTenure(run)
        persistStatusIfDue()
        try await openTenure(run, napFirst: true)
    }

    private func endTenure(_ run: Run) async {
        acquisition.invalidate()
        await run.publications.drain()
        await stopCompaction(run, flush: false)
        run.drop()
    }

    private func recoveryNap(_ run: Run) async throws {
        var left = run.wait
        run.wait = min(Run.longestWait, run.wait * 2)
        if let stopAt = run.stopAt { left = min(left, stopAt - clock.uptime) }
        while left > 0 {
            try goesOn(run)
            let began = clock.uptime
            try await nap(min(left, Self.statusHeartbeat), run: run)
            left -= max(0, clock.uptime - began)
            persistStatusIfDue()
        }
        try goesOn(run)
    }

    private func goesOn(_ run: Run) throws {
        guard attempting(run) else { throw CancellationError() }
        if let stopAt = run.stopAt, clock.uptime >= stopAt { throw CancellationError() }
    }

    private func record(_ run: Run) async {
        var cadence = CaptureCadence(interval: configuration.interval, start: clock.uptime)
        var scheduled = clock.uptime
        while attempting(run) {
            if let deadline = run.stopAt, clock.uptime >= deadline { break }
            if run.lost != nil {
                do {
                    try await recover(run)
                } catch {
                    break
                }
                cadence = CaptureCadence(interval: configuration.interval, start: clock.uptime)
                scheduled = clock.uptime
                continue
            }
            let began = clock.uptime
            attempt = CaptureTimings(wakeLateMs: CaptureTimings.milliseconds(began - scheduled))
            do {
                try await captureOne(run: run)
                guard attempting(run) else { break }
                guard run.lost == nil else { continue }
                report.lastCaptureDuration = clock.uptime - began
                let statusBegan = clock.uptime
                persistStatusIfDue()
                attempt.statusMs = CaptureTimings.milliseconds(clock.uptime - statusBegan)
                attempt.attemptMs = CaptureTimings.milliseconds(clock.uptime - began)
                changed?()
                let now = clock.uptime
                if configuration.interval != cadence.interval { cadence = CaptureCadence(interval: configuration.interval, start: now) }
                let advanced = cadence.advance(after: now, maximumLateness: 0.05)
                if run.closure == nil { publishMissedDeadlines(advanced, now: now, interval: cadence.interval, run: run) }
                scheduled = advanced.nextDeadline
                try await nap(max(0, advanced.nextDeadline - clock.uptime), run: run)
                if configuration.interval != cadence.interval {
                    cadence = CaptureCadence(interval: configuration.interval, start: clock.uptime)
                    scheduled = clock.uptime
                }
            } catch {
                if Task.isCancelled || error is CancellationError { break }
                storageLost(run, error)
            }
        }
    }

    private func nap(_ seconds: Double, run: Run) async throws {
        let clock = clock
        let nap = Task { @MainActor in try await clock.sleep(for: seconds) }
        run.napping = nap
        defer { run.napping = nil }
        await withTaskCancellationHandler {
            _ = try? await nap.value
        } onCancel: {
            nap.cancel()
        }
        try Task.checkCancellation()
    }

    private func publishMissedDeadlines(_ advanced: CaptureCadence.Advance, now: Double, interval: Double, run: Run) {
        guard let first = advanced.firstMissedDeadline, let last = advanced.lastMissedDeadline,
              first < (run.stopAt ?? .infinity), let store = run.store, run.lost == nil else { return }
        let end = min(last, (run.stopAt ?? .infinity).nextDown)
        let count = min(advanced.missedCount, Int(floor((end - first) / interval)) + 1)
        let wallNow = clock.date
        let reason = "\(CaptureGapReason.captureDeadlineMissed.rawValue); count=\(count)"
        var gap = CaptureObservation(capturedAt: wallNow.addingTimeInterval(first - now), displayID: 0,
                                     width: 0, height: 0, status: "gap", reason: reason)
        gap.capturedUntil = wallNow.addingTimeInterval(first + Double(count - 1) * interval - now)
        gap.timings = attempt
        run.publications.ordered { [self] in try await append(gap, image: nil, to: store, run: run, stands: false) }
    }

    private func end(of run: Run) -> Date {
        let pastTimer = max(0, clock.uptime - (run.stopAt ?? .infinity))
        let timerEnd = clock.date.addingTimeInterval(-pastTimer)
        return min(run.stoppedAt ?? timerEnd, timerEnd)
    }

    private func oweClosuresAtEnd(_ run: Run, until end: Date) {
        updateAvailability(dependencies.machine.availability)
        var spans: [RuntimeStatus.OwedSpan] = []
        var statedAfter: UInt64? = run.opened ? 0 : nil
        if let closure = run.closure {
            run.closure = nil
            var until = end
            if run.opened { statedAfter = nil }
            if closure.reason == .displayAsleepOrSessionInactive {
                if let generation = closure.generation, let own = gate.interval(of: generation) {
                    until = min(own.openedAt ?? end, end)
                    statedAfter = generation
                } else if gate.isOpen, let opened = gate.lastOpenedAt {
                    until = min(opened, end)
                }
            }
            if until.timeIntervalSince(closure.openedAt) > closure.interval {
                spans.append(.ended(reason: closure.reason.rawValue, from: closure.from, until: until))
            }
        }
        if let statedAfter {
            for interval in gate.intervals where interval.generation > statedAfter && !interval.consumed {
                let until = min(interval.openedAt ?? end, end)
                guard until.timeIntervalSince(interval.closedAt) > configuration.interval else { continue }
                spans.append(.ended(reason: CaptureGapReason.displayAsleepOrSessionInactive.rawValue,
                                    from: interval.closedAt, until: until))
            }
        }
        gate.consume(through: gate.generation)
        owed.append(contentsOf: spans)
    }

    private func publishIntervals(_ run: Run) async throws {
        var completed = gate.completed
        var through = completed.last?.generation ?? 0
        var ownEdge: Date?
        if let closure = run.closure, closure.reason == .displayAsleepOrSessionInactive, let generation = closure.generation,
           let opened = gate.interval(of: generation)?.openedAt {
            ownEdge = opened
            through = max(through, generation)
            completed.removeAll { $0.generation <= generation }
        }
        guard through > 0 else { return }
        guard let store = run.store else { return }
        gate.consume(through: through)
        var spans: [RuntimeStatus.OwedSpan] = []
        var settles = false
        if let ownEdge, let closure = run.closure {
            run.closure = nil
            settles = closure.lost
            if ownEdge.timeIntervalSince(closure.openedAt) > closure.interval {
                spans.append(.ended(reason: closure.reason.rawValue, from: closure.from, until: ownEdge))
            }
        }
        if run.closure == nil {
            for interval in completed {
                guard let openedAt = interval.openedAt, openedAt.timeIntervalSince(interval.closedAt) > configuration.interval else { continue }
                spans.append(.ended(reason: CaptureGapReason.displayAsleepOrSessionInactive.rawValue,
                                    from: interval.closedAt, until: openedAt))
            }
        }
        owed.append(contentsOf: spans)
        for span in spans {
            try await publishSpan(span, run: run, to: store, stands: true)
            owed.removeAll { $0 == span }
        }
        if settles { settleFailure(run) }
    }

    private func endClosure(_ run: Run, at end: Date) async throws {
        guard let closure = run.closure, let store = run.store else { return }
        run.closure = nil
        guard end.timeIntervalSince(closure.openedAt) > closure.interval else { return }
        try await publishEnded(.ended(reason: closure.reason.rawValue, from: closure.from, until: end), run: run, to: store)
        if closure.lost { settleFailure(run) }
    }

    private func closeGate(_ reason: CaptureGapReason, at openedAt: Date, run: Run, store: any RecorderStorage,
                           idleSeconds: Double? = nil, generation: UInt64? = nil) async throws {
        acquisition.invalidate()
        guard attempting(run) else { return }
        if let closure = run.closure, closure.reason != reason {
            try await endClosure(run, at: openedAt)
        }
        if run.closure == nil {
            run.closure = Run.Closure(reason: reason, openedAt: openedAt, interval: configuration.interval, generation: generation)
            try await publishGap(reason, run: run, to: store, at: openedAt, idleSeconds: idleSeconds, classify: false)
            run.closure?.stated = true
        }
        move(.attempt(report.recordAttempt(imageCount: 0, gapReasons: [reason.rawValue], at: clock.date)))
        report.lastGapReason = reason.rawValue
    }

    private func openGate(_ reason: CaptureGapReason, at end: Date, run: Run) async throws {
        guard run.closure?.reason == reason else { return }
        try await endClosure(run, at: end)
    }

    private func finish(_ run: Run) async {
        let end = end(of: run)
        move(.ended(run, .stopped))
        if !run.opened { endUncleanEnd(at: end) }
        if !run.oneShot { oweClosuresAtEnd(run, until: end) }
        await run.publications.drain()
        acquisition.invalidate()
        if run.lost != nil { await endTenure(run) }
        if run.opened, !run.oneShot {
            if run.store == nil, !owed.isEmpty, let store = try? await dependencies.openStore() { run.begin(store) }
            if let store = run.store, run.lost == nil { try? await publishPastSpans(run, to: store) }
            settleFailure(run)
        }
        for span in owed { note(.spanHeld, since: span.from) }
        await stopCompaction(run, flush: run.lost == nil)
        settleProducers(seal: true)
        run.activity?()
        run.activity = nil
        persistStatus()
        try? await statusWriter.drain()
        run.drop()
    }

    private func updateAvailability(_ state: RecorderAvailability) {
        gate.set(displayAwake: state.displayAwake, sessionActive: state.sessionActive, at: clock.date)
    }


    private func captureOne(run: Run) async throws {
        guard let store = run.store, run.lost == nil, attempting(run) else { return }
        await run.publications.room(below: Self.waitingLimit) { attempting(run) }
        guard attempting(run), run.lost == nil else { return }
        guard !off.contains(.screen) else {
            gate.consume(through: gate.generation)
            return
        }
        guard acquisition.screenRecordingAllowed else {
            gate.consume(through: gate.generation)
            report.lastGapReason = CaptureGapReason.screenRecordingPermissionDenied.rawValue
            move(.attempt(.permissionRequired))
            return
        }
        move(.screenAllowed)
        guard let ticket = try await passAvailabilityGate(run: run, store: store) else { return }
        let idleSeconds = acquisition.inputIdleSeconds()
        guard try await passIdleGate(idleSeconds, run: run, store: store) else { return }
        guard try await passBackpressureGate(run: run, store: store) else { return }
        let acquiring = clock.date
        guard let captured = try await acquireWithinDeadline(run: run, store: store) else { return }
        guard attempting(run) else { return }
        var slot = acquiring
        if case .done(let frames) = captured, let first = frames.lazy.map(\.observation.capturedAt).min() { slot = first }
        guard try await passCommitCheck(ticket, at: slot, run: run, store: store) else { return }
        switch captured {
        case .done(let frames):
            try await publishFrames(frames, idleSeconds: idleSeconds, ticket: ticket, run: run, store: store)
        case .recognizing(let timings, let finish):
            if let timings { attempt.merge(screen: timings) }
            publishWhenRecognized(finish, idleSeconds: idleSeconds, ticket: ticket, run: run, store: store)
        }
    }

    private func publishWhenRecognized(_ finish: @escaping @MainActor () async -> [CaptureResult],
                                       idleSeconds: Double?, ticket: CaptureGate.Ticket, run: Run,
                                       store: any RecorderStorage) {
        run.publications.whenRecognized(finish) { [self] frames in
            guard lifecycle.admits(run) else { return }
            updateAvailability(dependencies.machine.availability)
            guard gate.canCommit(ticket) else {
                acquisition.invalidate()
                try await appendGap(.sessionChangedDuringCapture, run: run, to: store,
                                    at: frames.lazy.map(\.observation.capturedAt).min())
                return
            }
            try await appendFrames(frames, idleSeconds: idleSeconds, ticket: ticket, run: run, store: store)
            changed?()
        }
    }

    static let screenRecordingMessage = "Allow Screen Recording for Lifestream: recording starts as soon as it is allowed."

    private func passAvailabilityGate(run: Run, store: any RecorderStorage) async throws -> CaptureGate.Ticket? {
        updateAvailability(dependencies.machine.availability)
        try await publishIntervals(run)
        let reason = CaptureGapReason.displayAsleepOrSessionInactive
        if let ticket = gate.ticket() {
            try await openGate(reason, at: gate.lastOpenedAt ?? clock.date, run: run)
            return ticket
        }
        let lasting = gate.lasting
        try await closeGate(reason, at: lasting?.closedAt ?? clock.date, run: run, store: store,
                            generation: lasting?.generation ?? gate.generation)
        return nil
    }

    private func passIdleGate(_ idleSeconds: Double?, run: Run, store: any RecorderStorage) async throws -> Bool {
        guard configuration.shouldPauseForIdle(idleSeconds) else {
            try await openGate(.inputInactiveCapturePaused, at: clock.date, run: run)
            return true
        }
        try await closeGate(.inputInactiveCapturePaused, at: clock.date, run: run, store: store, idleSeconds: idleSeconds)
        return false
    }

    private func passBackpressureGate(run: Run, store: any RecorderStorage) async throws -> Bool {
        guard store.hasBackpressure() else {
            try await openGate(.storageBackpressure, at: clock.date, run: run)
            return true
        }
        try await closeGate(.storageBackpressure, at: clock.date, run: run, store: store)
        return false
    }

    private func acquireWithinDeadline(run: Run, store: any RecorderStorage) async throws -> CaptureAttempt? {
        let began = clock.uptime
        defer { attempt.captureMs = CaptureTimings.milliseconds(clock.uptime - began) }
        do {
            return try await CaptureDeadline<CaptureAttempt>().run(
                seconds: dependencies.acquisitionTimeout,
                sleep: { [clock] seconds in try await clock.sleep(for: seconds) },
                operation: { [acquisition] in try await acquisition.capture() })
        } catch {
            acquisition.invalidate()
            guard attempting(run) else { return nil }
            try await publishGap(error is CaptureDeadlineError ? .captureDeadlineExceeded : .captureFailed, run: run, to: store)
            return nil
        }
    }

    private func passCommitCheck(_ ticket: CaptureGate.Ticket, at slot: Date, run: Run, store: any RecorderStorage) async throws -> Bool {
        updateAvailability(dependencies.machine.availability)
        guard gate.canCommit(ticket) else {
            acquisition.invalidate()
            try await publishGap(.sessionChangedDuringCapture, run: run, to: store, at: slot)
            return false
        }
        return true
    }

    private func publishFrames(_ frames: [CaptureResult], idleSeconds: Double?, ticket: CaptureGate.Ticket,
                               run: Run, store: any RecorderStorage) async throws {
        let began = clock.uptime
        defer { attempt.publishMs = CaptureTimings.milliseconds(clock.uptime - began) }
        if let screen = frames.lazy.compactMap(\.observation.timings).first { attempt.merge(screen: screen) }
        try await run.publications.ordered { [self] in
            try await appendFrames(frames, idleSeconds: idleSeconds, ticket: ticket, run: run, store: store)
        }.value
    }

    private func appendFrames(_ frames: [CaptureResult], idleSeconds: Double?, ticket: CaptureGate.Ticket,
                              run: Run, store: any RecorderStorage) async throws {
        var images = 0
        var saved = false
        var activity: String?
        var gaps: [String?] = []
        for frame in frames {
            guard lifecycle.admits(run), gate.canCommit(ticket) else {
                acquisition.invalidate()
                return
            }
            let image = frame.image
            var observation = frame.observation
            observation.inputIdleSeconds = idleSeconds
            do {
                try await append(observation, image: image, to: store, run: run)
            } catch let refusal as CaptureStoreError {
                let reason: CaptureGapReason
                switch refusal {
                case .archiveBacklogFull:
                    reason = .storageBackpressure
                case .videoEncoderUnavailable:
                    reason = .videoEncoderUnavailable
                case .invalidObservation:
                    reason = .captureFailed
                default:
                    throw refusal
                }
                acquisition.invalidate()
                guard lifecycle.admits(run) else { return }
                gaps.append(reason.rawValue)
                try await appendGap(reason, run: run, to: store, at: observation.capturedAt,
                                    displayID: observation.displayID, classify: false)
                continue
            }
            if image != nil {
                images += 1
                saved = true
            } else if observation.status == ObservationStatus.activityOnly.rawValue {
                images += 1
                activity = observation.reason
            } else {
                gaps.append(observation.reason)
            }
        }
        if gaps.isEmpty { report.lastGapReason = saved ? nil : activity }
        move(.attempt(report.recordAttempt(imageCount: images, gapReasons: gaps, at: clock.date)))
    }


    private func publishGap(_ reason: CaptureGapReason, run: Run, to store: any RecorderStorage, at: Date? = nil,
                            displayID: UInt32 = 0, idleSeconds: Double? = nil, classify: Bool = true) async throws {
        try await run.publications.ordered { [self] in
            try await appendGap(reason, run: run, to: store, at: at, displayID: displayID, idleSeconds: idleSeconds,
                                classify: classify)
        }.value
    }

    private func appendGap(_ reason: CaptureGapReason, run: Run, to store: any RecorderStorage, at: Date? = nil,
                           displayID: UInt32 = 0, idleSeconds: Double? = nil, classify: Bool = true) async throws {
        var gap = CaptureObservation(capturedAt: at ?? clock.date, displayID: displayID,
                                     width: 0, height: 0, status: "gap", reason: reason.rawValue)
        gap.inputIdleSeconds = idleSeconds
        try await append(gap, image: nil, to: store, run: run)
        if classify {
            move(.attempt(report.recordAttempt(imageCount: 0, gapReasons: [reason.rawValue], at: clock.date)))
        }
    }

    private func append(_ observation: CaptureObservation, image: CaptureImage?,
                        to store: any RecorderStorage, run: Run, stands: Bool = true, bundle: String? = nil) async throws {
        do {
            if let bundle {
                try await store.append(observation, bundle: bundle)
            } else {
                try await store.append(observation, image: image)
            }
        } catch {
            if case .publishedNotFlushed(let end, _) = error as? CaptureStoreError { run.reached(end) }
            throw error
        }
        run.appended(observation)
        if image != nil {
            ResourceMeter.shared.count(.frames)
            report.recorded += 1
            report.lastSaved = clock.date
            run.wait = Run.shortestWait
            tenureStreak.ended(at: clock.date, lines: dependencies.failures)
        } else if observation.status == ObservationStatus.activityOnly.rawValue {
        } else {
            ResourceMeter.shared.count(.gaps)
            report.gaps += 1
            if stands { report.lastGapReason = observation.reason }
        }
    }

    private func beginCapturing() {
        report.capturingSince = clock.date
        report.lastGapReason = nil
    }

    private func persistStatus() {
        report.updatedAt = clock.date
        readInputStatus()
        let status = status
        do {
            try statusWriter.submit(status)
            statusStreak.ended(at: clock.date, lines: dependencies.failures)
        } catch {
            statusFailed(error)
            try? statusWriter.submit(status)
        }
        written = (status.transition, clock.uptime)
    }

    private func statusFailed(_ error: Error) {
        let (kind, errno) = StorageFailure.kind(of: error)
        statusStreak.failed(.statusUnwritten, kind: kind, errno: errno, at: clock.date, lines: dependencies.failures)
    }

    private func persistStatusIfDue() {
        readInputStatus()
        if let written, written.transition == status.transition,
           clock.uptime - written.uptime < Self.statusHeartbeat { return }
        persistStatus()
    }

    private func readInputStatus() {
        let input = dependencies.input.status
        report.inputLog = input.state
        report.inputEvents = input.events
        report.inputTapRestarts = input.tapRestarts
        let audio = dependencies.audio.status
        report.audioMic = audio.mic
        report.audioSound = audio.sound
    }


    private func startCompaction(_ run: Run) {
        guard run.compaction == nil, let store = run.store else { return }
        report.videoCompactionStatus = .waiting
        report.videoCompactionFailingSince = nil
        run.compaction = Task(priority: .utility) { [self] in
            var delay = Run.shortestWait
            while !Task.isCancelled {
                do {
                    try await clock.sleep(for: delay)
                } catch {
                    break
                }
                guard !Task.isCancelled else { break }
                report.videoCompactionStatus = .compacting
                do {
                    updateCompaction(try await store.compact(flush: false), state: .waiting)
                    report.videoCompactionFailingSince = nil
                    compactionStreak.ended(at: clock.date, lines: dependencies.failures)
                    delay = Run.shortestWait
                } catch {
                    if Task.isCancelled || error is CancellationError || error as? VideoArchiveError == .cancelled { break }
                    report.videoCompactionStatus = .retryingPending
                    report.videoCompactionFailingSince = report.videoCompactionFailingSince ?? clock.date
                    compactionStreak.failed(.compactionFailing, kind: StorageFailure.kind(of: error).kind, at: clock.date,
                                            lines: dependencies.failures)
                    delay = min(Run.longestWait, delay * 2)
                }
                persistStatusIfDue()
                changed?()
            }
        }
    }

    private func stopCompaction(_ run: Run, flush: Bool) async {
        let running = run.compaction != nil
        run.compaction?.cancel()
        await run.compaction?.value
        run.compaction = nil
        guard flush else {
            if running { report.videoCompactionStatus = .stoppedPending }
            return
        }
        guard let store = run.store else { return }
        do {
            updateCompaction(try await store.flushVideoBeforeRelease(), state: .stopped)
        } catch {
            report.videoCompactionStatus = .stoppedPending
        }
    }

    private func updateCompaction(_ compacted: VideoCompactionReport, state: VideoCompactionState) {
        report.pendingVideoImages = compacted.pendingImageCount
        report.pendingVideoBytes = compacted.pendingBytes
        report.skippedVideoImages = compacted.skippedImageCount
        report.videoCompactionStatus = state
    }
}
