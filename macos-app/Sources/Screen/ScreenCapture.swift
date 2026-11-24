import AppKit
import ApplicationServices
import Evidence

public struct CapturePermissions: Codable {
    public let screenRecording: Bool
    public let accessibility: Bool
}

@MainActor
public final class ScreenCapture {
    public struct Configuration: Sendable {
        public var modes: RecordingModes
        public var ocr: OCRMode
        public var maximumHeight: Int
        public var maximumDimension: Int
        public var allDisplays: Bool

        public init(modes: RecordingModes = RecordingModes(), ocr: OCRMode = .exact, maximumHeight: Int = 0,
                    maximumDimension: Int = 0, allDisplays: Bool = false) {
            self.modes = modes
            self.ocr = ocr
            self.maximumHeight = maximumHeight
            self.maximumDimension = maximumDimension
            self.allDisplays = allDisplays
        }
    }

    private let adapter: CaptureAdapter
    private let pipeline = CapturePipeline()
    private var modes: RecordingModes
    private var isCapturing = false
    private let workspaceNotifications = NSWorkspace.shared.notificationCenter
    private var contextObservers: [NSObjectProtocol] = []

    public convenience init(configuration: Configuration = Configuration()) {
        self.init(adapter: ScreenCaptureKitAdapter(configuration: configuration, system: LiveSystemFacts(),
                                                   reader: RecognitionHelper.live),
            modes: configuration.modes, observeContext: true)
    }

    init(adapter: CaptureAdapter, modes: RecordingModes = RecordingModes(), observeContext: Bool = false) {
        self.adapter = adapter
        self.modes = modes
        guard observeContext else { return }
        let names = [NSWorkspace.didActivateApplicationNotification, NSWorkspace.didDeactivateApplicationNotification]
        for name in names {
            let observer = workspaceNotifications.addObserver(forName: name, object: nil, queue: .main) { [weak self] in
                let notification = $0
                MainActor.assumeIsolated {
                    guard let self else { return }
                    let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                    let bundleID = app?.bundleIdentifier
                    if CaptureAdmission.requiresHardInvalidation(bundleID: bundleID, hidden: self.modes.hidden) {
                        self.invalidateCaches()
                    } else {
                        self.invalidateContext()
                    }
                }
            }
            contextObservers.append(observer)
        }
    }

    deinit {
        for observer in contextObservers {
            workspaceNotifications.removeObserver(observer)
        }
    }

    public func invalidateCaches() {
        pipeline.invalidate()
    }

    public func setModes(_ modes: RecordingModes) {
        self.modes = modes
        adapter.apply(modes)
        invalidateCaches()
    }

    public func setRecognition(_ mode: OCRMode) {
        adapter.apply(ocr: mode)
    }

    func invalidateContext() {
        pipeline.contextChanged()
    }

    public func permissions() -> CapturePermissions {
        CapturePermissions(screenRecording: CGPreflightScreenCaptureAccess(), accessibility: AXIsProcessTrusted())
    }

    public func inputIdleSeconds() -> Double? {
        let value = CGEventSource.secondsSinceLastEventType(.combinedSessionState,
            eventType: CGEventType(rawValue: UInt32.max)!)
        return value.isFinite && value >= 0 ? value : nil
    }

    public func capture() async throws -> CaptureAttempt {
        guard !isCapturing else { return .done([gap(.captureAlreadyRunning)]) }
        isCapturing = true
        defer { isCapturing = false }
        ResourceMeter.shared.count(.capture, units: 1)
        let ticket = pipeline.ticket()
        let batch: CaptureBatch
        let preparing = StepTiming.now()
        do {
            try Task.checkCancellation()
            batch = try await adapter.prepare(pipeline: pipeline, ticket: ticket)
            try Task.checkCancellation()
        } catch {
            return .done([failure(error)])
        }
        let prepareMs = StepTiming.since(preparing)
        var entries: [Entry] = []
        for request in batch.requests {
            do {
                let operation = try ResourceMeter.shared.measure(.capture, units: 0) { try request.prepare() }
                var enriched = try await pipeline.run(ticket: ticket, acquire: operation.acquire,
                    validate: operation.validate, enrich: operation.enrich)
                enriched.observation.timings?.prepareMs = prepareMs
                entries.append(.recognizing(enriched))
            } catch {
                entries.append(.known(failure(error, displayID: request.displayID)))
            }
        }
        let frames = entries.compactMap(\.frame)
        guard !frames.isEmpty else {
            let results = entries.compactMap(\.result)
            if let activity = results.first(where: { $0.observation.status == ObservationStatus.activityOnly.rawValue }) {
                return .done([activity])
            }
            return .done(results)
        }
        guard !Task.isCancelled else { return .done([gap(.captureCancelled)]) }
        return .recognizing(timings: frames.lazy.compactMap(\.observation.timings).first) { [self] in
            await finish(entries, ticket: ticket, validate: batch.validate)
        }
    }

    private enum Entry {
        case known(CaptureResult)
        case recognizing(EnrichedCapture)

        var result: CaptureResult? { if case .known(let result) = self { result } else { nil } }
        var frame: EnrichedCapture? { if case .recognizing(let frame) = self { frame } else { nil } }
    }

    private func finish(_ entries: [Entry], ticket: CapturePipeline.Ticket,
                        validate: () -> CaptureGapReason?) async -> [CaptureResult] {
        let slot = entries.lazy.compactMap(\.frame?.observation.capturedAt).min() ?? Date()
        var results: [CaptureResult] = []
        for entry in entries {
            switch entry {
            case .known(let result):
                results.append(result)
            case .recognizing(let frame):
                guard let text = await pipeline.whilePublishable(ticket, frame.text) else { return [closed(at: slot)] }
                results.append(CaptureResult(observation: frame.with(text), image: frame.image))
            }
        }
        guard pipeline.canPublish(ticket) else { return [closed(at: slot)] }
        if let reason = validate() { return [gap(reason, at: slot)] }
        return results
    }

    private func closed(at slot: Date) -> CaptureResult {
        CaptureResult(observation: CaptureObservation(capturedAt: slot, displayID: 0, width: 0, height: 0,
            status: "gap", reason: CaptureGapReason.captureGenerationInvalidated.rawValue), image: nil)
    }

    private func gap(_ reason: CaptureGapReason, displayID: UInt32 = 0, at: Date = Date()) -> CaptureResult {
        if Self.closesWaitingFrames(reason) { invalidateCaches() }
        if reason == .foregroundAppActivityOnly || reason == .foregroundSiteActivityOnly {
            guard let activity = adapter.activityOnly() else { return gap(.contextChangedDuringCapture) }
            return CaptureResult(observation: activity, image: nil)
        }
        let status = reason == .foregroundAppExcluded ? "excluded" : "gap"
        let observation = CaptureObservation(capturedAt: at, displayID: displayID, width: 0, height: 0,
            status: status, reason: reason.rawValue)
        return CaptureResult(observation: observation, image: nil)
    }

    static func closesWaitingFrames(_ reason: CaptureGapReason) -> Bool {
        switch reason {
        case .displayAsleepOrSessionInactive, .sessionChangedDuringCapture, .screenRecordingPermissionDenied,
             .secureInputEnabled, .secureFieldFocused, .secureFieldInFrontWindow, .foregroundAppExcluded,
             .foregroundAppActivityOnly, .foregroundSiteRuleExcluded, .foregroundPrivateWindow,
             .foregroundPageUnreadable, .foregroundSiteActivityOnly, .siteChangedDuringCapture,
             .noFocusedApplication, .loginWindowActive, .sessionLockedOrUnavailable,
             .excludedVisibleApplicationNotCoveredBeforeCapture, .excludedVisibleApplicationNotCoveredDuringCapture:
            return true
        case .inputInactiveCapturePaused, .contextChangedBeforeCapture, .contextChangedDuringCapture,
             .captureCancelled, .captureDeadlineExceeded, .storageBackpressure, .videoEncoderUnavailable,
             .captureDeadlineMissed, .captureFailed, .screenAcquisitionFailed, .captureAlreadyRunning,
             .shareableContentUnavailable, .noDisplay, .noValidDisplay, .invalidCaptureSizeOrDisplayMode,
             .captureGenerationInvalidated, .storageFailed, .recorderNotRunning:
            return false
        }
    }

    private func failure(_ error: Error, displayID: UInt32 = 0) -> CaptureResult {
        if case CapturePipeline.Failure.excludedPage(let page) = error {
            invalidateCaches()
            return CaptureResult(observation: page.observation(at: Date(), displayID: displayID), image: nil)
        }
        let reason: CaptureGapReason
        if error is CancellationError {
            reason = .captureCancelled
        } else if case CapturePipeline.Failure.rejected(let rejection) = error {
            reason = rejection
        } else {
            reason = .screenAcquisitionFailed
        }
        return gap(reason, displayID: displayID)
    }
}
