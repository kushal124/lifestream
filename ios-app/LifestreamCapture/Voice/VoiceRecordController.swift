import Combine
import OSLog
import SwiftUI
import UIKit

@MainActor
final class VoiceRecordController: ObservableObject {
    static let levelCount = 24
    static let durationLimit: TimeInterval = 30 * 60
    static let minimumDuration: TimeInterval = 0.5
    static let silence = [Float](repeating: 0, count: levelCount)

    enum Phase: Equatable {
        case idle
        case asking
        case starting
        case recording(elapsed: TimeInterval, levels: [Float])
        case saving(elapsed: TimeInterval)
        case denied
        case failed(String)

        var showsPanel: Bool {
            switch self {
            case .starting, .recording, .saving, .denied, .failed: true
            case .idle, .asking: false
            }
        }

        var isRecording: Bool {
            if case .recording = self { true } else { false }
        }

        var failure: String? {
            if case .failed(let message) = self { message } else { nil }
        }
    }

    @Published private(set) var phase: Phase = .idle

    private static let log = Logger(subsystem: "org.lifestreamprotocol.phone", category: "voice")
    private let engine: any VoiceCaptureSession
    private let permission: () -> VoiceCaptureEngine.Permission
    private let askPermission: @MainActor () async -> Bool
    private let recorder: VoiceRecorder
    private var meterTask: Task<Void, Never>?
    private var opening = false
    private var stalls = 0
    private let impact = UIImpactFeedbackGenerator(style: .medium)
    private let notice = UINotificationFeedbackGenerator()

    init(
        recorder: VoiceRecorder,
        engine: (any VoiceCaptureSession)? = nil,
        permission: @escaping () -> VoiceCaptureEngine.Permission = { AppRuntime.isUITesting ? .granted : VoiceCaptureEngine.permission },
        askPermission: @escaping @MainActor () async -> Bool = { await VoiceCaptureEngine.requestPermission() }
    ) {
        self.recorder = recorder
        self.engine = engine ?? (AppRuntime.isUITesting ? SyntheticVoiceCapture() : VoiceCaptureEngine())
        self.permission = permission
        self.askPermission = askPermission
    }

    func start() {
        guard phase == .idle, !opening else { return }
        stalls = 0
        switch permission() {
        case .granted:
            record()
        case .denied:
            enter(.denied)
        case .undetermined:
            enter(.asking)
            Task { [weak self] in
                guard let granted = await self?.askPermission() else { return }
                guard let self, self.phase == .asking else { return }
                if granted { self.record() } else { self.enter(.denied) }
            }
        }
    }

    func stop() {
        finish(reason: "tapped")
    }

    func cancel() {
        switch phase {
        case .starting:
            enter(.idle)
        case .recording:
            engine.discard()
            enter(.idle)
        case .idle, .asking, .saving, .denied, .failed:
            break
        }
    }

    func interrupted() {
        if phase == .starting { return enter(.idle) }
        finish(reason: "interrupted")
    }

    func enteredBackground() {
        switch phase {
        case .asking, .starting: enter(.idle)
        case .recording: finish(reason: "background")
        case .idle, .saving, .denied, .failed: break
        }
        engine.releaseSession()
    }

    func acknowledge() {
        switch phase {
        case .denied, .failed: enter(.idle)
        case .idle, .asking, .starting, .recording, .saving: break
        }
    }

    func again() {
        guard phase.failure != nil else { return }
        enter(.idle)
        start()
    }

    private func enter(_ next: Phase) {
        if phase.isRecording, !next.isRecording {
            meterTask?.cancel()
            meterTask = nil
        }
        phase = next
    }

    private func record() {
        NotePlayer.shared.stop()
        enter(.starting)
        opening = true
        Task { [weak self] in await self?.open() }
    }

    private func open() async {
        defer { opening = false }
        do {
            try await engine.prime()
            guard engine.isActive else { throw VoiceCaptureError.recorderRefused }
        } catch {
            engine.discard()
            if phase == .starting { enter(.failed(error.localizedDescription)) }
            return
        }
        guard phase == .starting else {
            engine.discard()
            engine.releaseSession()
            return
        }
        enter(.recording(elapsed: 0, levels: Self.silence))
        if stalls == 0 { impact.impactOccurred() }
        startMetering()
    }

    private func finish(reason: String) {
        guard case .recording(let elapsed, _) = phase else { return }
        let snapshot: VoiceNoteSnapshot
        do {
            snapshot = try engine.finish(mode: .handsFree, reason: reason)
        } catch {
            notice.notificationOccurred(.error)
            enter(.failed(error.localizedDescription))
            return
        }
        guard snapshot.durationSeconds >= Self.minimumDuration else {
            Self.log.debug("dropped a \(snapshot.durationSeconds, privacy: .public) s slip")
            enter(.idle)
            return
        }
        enter(.saving(elapsed: elapsed))
        Task { [self] in
            do {
                let saved = try await recorder.record(snapshot)
                Self.log.debug(
                    "saved voice note sequence \(saved.sequence, privacy: .public), \(snapshot.durationSeconds, privacy: .public) s"
                )
                notice.notificationOccurred(.success)
                enter(.idle)
            } catch {
                Self.log.error("voice note failed: \(error.localizedDescription, privacy: .private)")
                notice.notificationOccurred(.error)
                enter(.failed(error.localizedDescription))
            }
        }
    }

    private func startMetering() {
        meterTask?.cancel()
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, case .recording(_, let levels) = self.phase else { return }
                if self.engine.isStalled {
                    if self.stalls > 0 {
                        Self.log.error("recorder stalled twice; ending the note")
                        self.finish(reason: "stalled")
                        return
                    }
                    self.stalls += 1
                    Self.log.debug("recorder stalled while recording; restarting")
                    self.engine.discard()
                    self.record()
                    return
                }
                let elapsed = self.engine.currentTime
                self.enter(.recording(elapsed: elapsed, levels: Array(levels.dropFirst()) + [self.engine.level()]))
                if elapsed >= Self.durationLimit {
                    self.finish(reason: "limit")
                    return
                }
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
    }
}
