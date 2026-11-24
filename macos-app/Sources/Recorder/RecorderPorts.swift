import Audio
import Evidence
import Foundation
import Screen
import Spool

@MainActor protocol RecorderAcquisition: AnyObject {
    var screenRecordingAllowed: Bool { get }
    func invalidate()
    func inputIdleSeconds() -> Double?
    func capture() async throws -> CaptureAttempt
    func setModes(_ modes: RecordingModes)
    func setOCR(_ mode: OCRMode)
}

extension RecorderAcquisition {
    func setOCR(_ mode: OCRMode) {}
}

protocol RecorderStorage: AnyObject, Sendable {
    func append(_ observation: CaptureObservation, image: CaptureImage?) async throws
    func append(_ observation: CaptureObservation, bundle: String) async throws
    func hasBackpressure() -> Bool
    func compact(flush: Bool) async throws -> VideoCompactionReport
    var newestObservation: NewestObservation? { get }
    var newestUnreadable: Bool { get }
}

extension RecorderStorage {
    func append(_ observation: CaptureObservation, bundle: String) async throws {
        try await append(observation, image: nil)
    }

    var newestObservation: NewestObservation? { nil }
    var newestUnreadable: Bool { false }

    func flushVideoBeforeRelease() async throws -> VideoCompactionReport {
        try await Task.detached(priority: .utility) { try await self.compact(flush: true) }.value
    }
}

struct RecorderAvailability {
    let displayAwake: Bool?
    let sessionActive: Bool?
}

public enum Producer: String, CaseIterable, Sendable {
    case screen, input, audio
}

@MainActor protocol RecorderMachine: AnyObject {
    var availability: RecorderAvailability { get }
    var availabilityChanged: ((RecorderAvailability) -> Void)? { get set }
    func start()
    func stop()
    func setModes(_ modes: RecordingModes)
}

public enum InputLogState: String, Codable, CaseIterable, Sendable {
    case recording
    case permissionRequired = "permission_required"
    case stopped
    case off
}

public struct RecorderInputStatus: Equatable, Sendable {
    public var state: InputLogState
    public var events: Int
    public var tapRestarts: Int

    public init(state: InputLogState, events: Int = 0, tapRestarts: Int = 0) {
        self.state = state
        self.events = events
        self.tapRestarts = tapRestarts
    }
}

@MainActor protocol RecorderInput: AnyObject {
    var status: RecorderInputStatus { get }
    func start()
    func stop()
    func setModes(_ modes: RecordingModes)
}

@MainActor protocol RecorderAudio: AnyObject {
    var status: AudioStatus { get }
    func start()
    func stop()
    func setModes(_ modes: RecordingModes)
}

@MainActor protocol RecorderClock {
    var uptime: Double { get }
    var date: Date { get }
    func sleep(for seconds: Double) async throws
}

@MainActor struct RecorderDependencies {
    let acquisition: any RecorderAcquisition
    let machine: any RecorderMachine
    let input: any RecorderInput
    let clock: any RecorderClock
    var audio: any RecorderAudio = NoAudio()
    let openStore: @MainActor () async throws -> any RecorderStorage
    let persistStatus: @Sendable (RuntimeStatus) throws -> Void
    var previous: RuntimeStatus?
    var modes = RecordingModes()
    var persistModes: (RecordingModes) throws -> Void = { _ in }
    var acquisitionTimeout: Double = 10
    var resources: ResourceAccount?
    var failures: FailureLines = .shared
    var holdActivity: (String) -> (() -> Void) = { _ in {} }
}
