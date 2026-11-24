import Audio
import DeviceFiles
import Foundation
import Evidence
import Spool

public enum RecorderState: String, Codable, Sendable {
    case stopped, starting, recording, waiting, recovering, captured, gap
    case permissionRequired = "permission_required"
}

public struct StorageFailure: Codable, Equatable, Sendable {
    public let kind: String
    public let errno: Int32?
    public let at: Date

    public init(kind: String, errno: Int32?, at: Date) {
        self.kind = kind
        self.errno = errno
        self.at = at
    }

    init(_ error: Error, at: Date) {
        let (kind, errno) = Self.kind(of: error)
        self.init(kind: kind, errno: errno, at: at)
    }

    var diskFull: Bool { errno == ENOSPC }

    static func kind(of error: Error) -> (kind: String, errno: Int32?) {
        switch error {
        case let error as CaptureStoreError:
            switch error {
            case .writerAlreadyRunning: return ("writerAlreadyRunning", nil)
            case .readOnly: return ("readOnly", nil)
            case .archiveBacklogFull: return ("archiveBacklogFull", nil)
            case .videoEncoderUnavailable: return ("videoEncoderUnavailable", nil)
            case .invalidObservation: return ("invalidObservation", nil)
            case .corruptBundle: return ("corruptBundle", nil)
            case .bundleFailure: return ("bundleFailure", nil)
            case .io(_, let code): return ("io", code)
            case .publishedNotFlushed(_, let cause): return kind(of: cause)
            }
        case let error as DeviceFileError:
            switch error {
            case .invalidSizeOrType: return ("invalidSizeOrType", nil)
            case .truncated: return ("truncated", nil)
            case .io(_, let code): return ("io", code)
            case .notFlushed(_, let code): return ("notFlushed", code)
            case .unreadable: return ("unreadable", nil)
            case .switched: return ("switched", nil)
            case .alreadyKeyed: return ("alreadyKeyed", nil)
            }
        case let error as VideoArchiveError:
            switch error {
            case .busy: return ("busy", nil)
            case .invalidInput: return ("invalidInput", nil)
            case .invalidReference: return ("invalidReference", nil)
            case .corruptSegment: return ("corruptSegment", nil)
            case .hardwareUnavailable: return ("hardwareUnavailable", nil)
            case .codec: return ("codec", nil)
            case .timeout: return ("timeout", nil)
            case .cancelled: return ("cancelled", nil)
            case .media: return ("media", nil)
            }
        case let error as TextCompactionError:
            switch error {
            case .busy: return ("busy", nil)
            case .unverifiable: return ("unverifiable", nil)
            }
        case let error as POSIXError: return ("io", error.code.rawValue)
        default:
            let bridged = error as NSError
            if bridged.domain == NSPOSIXErrorDomain { return ("io", Int32(bridged.code)) }
            if let underlying = bridged.userInfo[NSUnderlyingErrorKey] as? NSError, underlying.domain == NSPOSIXErrorDomain {
                return ("io", Int32(underlying.code))
            }
            let mirror = Mirror(reflecting: error)
            if mirror.displayStyle == .enum, let label = mirror.children.first?.label { return (label, nil) }
            return (String(describing: type(of: error)), nil)
        }
    }
}

public enum VideoCompactionState: String, Codable, Sendable {
    case waiting, compacting, stopped
    case retryingPending = "retrying; pending images retained"
    case stoppedPending = "stopped; pending images retained"
}

public struct RuntimeStatus: Codable, Sendable {
    public var state: RecorderState
    public var updatedAt = Date()
    public var lastSaved: Date?
    public var lastCaptureDuration: Double?
    public var recorded = 0
    public var gaps = 0
    public var pendingFrames: Int?
    public var lastGapReason: String?
    public var capturingSince: Date?
    public var consecutiveTechnicalFailedAttempts: Int? = 0
    public var lastTechnicalFailureReason: String?
    public var lastTechnicalFailureAt: Date?
    public var videoCompactionStatus: VideoCompactionState?
    public var pendingVideoImages: Int?
    public var pendingVideoBytes: Int?
    public var videoCompactionFailingSince: Date?
    public var skippedVideoImages: Int?
    public var inputLog: InputLogState?
    public var inputEvents: Int?
    public var inputTapRestarts: Int?
    public var audioMic: AudioTrackState?
    public var audioSound: AudioTrackState?
    public var storageFailure: StorageFailure?
    public var owed: [OwedSpan]?
    public var message: String?
    public var pid = ProcessInfo.processInfo.processIdentifier

    public init(state: RecorderState) { self.state = state }

    public struct OwedSpan: Codable, Equatable, Sendable {
        public let reason: String
        public var from: Date
        public var until: Date?
        public var lived: Date?
        public var bundle: String?

        public init(reason: String, from: Date, until: Date? = nil, lived: Date? = nil, bundle: String? = nil) {
            self.reason = reason
            self.from = from
            self.until = until
            self.lived = lived
            self.bundle = bundle
        }

        static func ended(reason: String, from: Date, until: Date) -> OwedSpan {
            OwedSpan(reason: reason, from: from, until: until, bundle: CaptureStore.bundleName(for: from))
        }
    }

    static let fileName = "runtime.json"

    static let maximumBytes = 1 << 24

    func persist(in directory: URL, plain: DeviceFiles) throws {
        try plain.replace(directory.appendingPathComponent(Self.fileName), with: WireJSON.encode(self), commit: .atomic)
    }

    public static func read(from directory: URL, plain: DeviceFiles) throws -> RuntimeStatus? {
        guard let data = try? plain.read(directory.appendingPathComponent(fileName), maximumBytes: maximumBytes) else {
            return nil
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            guard let date = WireJSON.date(value) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid timestamp")
            }
            return date
        }
        return try decoder.decode(RuntimeStatus.self, from: data)
    }

    struct Transition: Equatable {
        let state: RecorderState
        let message: String?
        let lastGapReason: String?
        let capturingSince: Date?
        let lastTechnicalFailureReason: String?
        let videoCompactionStatus: VideoCompactionState?
        let videoCompactionFailingSince: Date?
        let inputLog: InputLogState?
        let audioMic: AudioTrackState?
        let audioSound: AudioTrackState?
        let storageFailure: StorageFailure?
        let owed: [OwedSpan]?
    }

    var transition: Transition {
        Transition(state: state, message: message, lastGapReason: lastGapReason, capturingSince: capturingSince,
                   lastTechnicalFailureReason: lastTechnicalFailureReason,
                   videoCompactionStatus: videoCompactionStatus,
                   videoCompactionFailingSince: videoCompactionFailingSince,
                   inputLog: inputLog, audioMic: audioMic, audioSound: audioSound,
                   storageFailure: storageFailure, owed: owed)
    }

    mutating func recordAttempt(imageCount: Int, gapReasons: [String?], at: Date = Date()) -> RecorderLifecycle.Attempt {
        let outcome = CaptureAttemptOutcome.classify(imageCount: imageCount, gapReasons: gapReasons)
        if let reason = outcome.technicalReason {
            consecutiveTechnicalFailedAttempts = min(consecutiveTechnicalFailedAttempts ?? 0, Int.max - 1) + 1
            lastTechnicalFailureReason = reason.rawValue
            lastTechnicalFailureAt = at
        } else if imageCount > 0 {
            consecutiveTechnicalFailedAttempts = 0
        }
        return outcome.attempt
    }
}

final class RuntimeStatusWriter: @unchecked Sendable {
    private let write: @Sendable (RuntimeStatus) throws -> Void
    private let queue = DispatchQueue(label: "org.lifestreamprotocol.screen-capture.runtime-status", qos: .utility)
    private let lock = NSLock()
    private var failure: (any Error)?

    init(write: @escaping @Sendable (RuntimeStatus) throws -> Void) {
        self.write = write
    }

    func submit(_ status: RuntimeStatus) throws {
        try takeFailure()
        queue.async { [self] in
            do {
                try ResourceMeter.shared.measure(.runtimeStatus) { try write(status) }
            } catch {
                lock.withLock { failure = error }
            }
        }
    }

    func drain() async throws {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queue.async { done.resume() }
        }
        try takeFailure()
    }

    private func takeFailure() throws {
        let failed = lock.withLock { () -> (any Error)? in
            defer { failure = nil }
            return failure
        }
        if let failed { throw failed }
    }
}

struct CaptureAttemptOutcome: Equatable {
    let attempt: RecorderLifecycle.Attempt
    let technicalReason: CaptureGapReason?

    static func classify(imageCount: Int, gapReasons: [String?]) -> Self {
        for supplied in gapReasons {
            let reason = supplied.flatMap(CaptureGapReason.init(rawValue:)) ?? .captureFailed
            if reason.isExpectedWait { continue }
            return Self(attempt: .recovering, technicalReason: reason)
        }
        if imageCount > 0 { return Self(attempt: .recording, technicalReason: nil) }
        if !gapReasons.isEmpty { return Self(attempt: .waiting, technicalReason: nil) }
        return Self(attempt: .recovering, technicalReason: .captureFailed)
    }
}
