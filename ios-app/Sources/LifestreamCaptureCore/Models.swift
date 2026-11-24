import Foundation

public enum CaptureDomain: String, CaseIterable, Codable, Sendable {
    case health
    case location
    case motion
    case camera
    case photos
    case voice
    case usage
    case contacts
    case checkin
    case notes
    case energy
    case upload
    case machine

    public var filename: String { "\(rawValue).jsonl" }
}

public enum CoverageState: String, CaseIterable, Codable, Sendable {
    case highRateExpected = "high_rate_expected"
    case stationaryAutoPaused = "stationary_auto_paused"
    case coarseFallbackOnly = "coarse_fallback_only"
    case accuracyDegraded = "accuracy_degraded"
    case authorizationBlocked = "authorization_blocked"
    case locationUnavailable = "location_unavailable"
    case processAbsence = "process_absence"
    case deviceOffOrPreunlock = "device_off_or_preunlock"
    case unknown
}

public enum ReasonEvidence: String, Codable, Sendable {
    case observed
    case inferred
}

public struct CaptureEntry: Sendable, Equatable, Codable {
    public let schemaVersion: Int
    public let domain: CaptureDomain
    public let kind: String
    public let sequence: UInt64
    public let observedAt: String
    public let captured: WallAndMonotonicTime
    public let processInstanceID: UUID
    public let captureReplayKey: String?
    public let payload: JSONValue

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case domain, kind, sequence
        case observedAt = "observed_at"
        case captured
        case processInstanceID = "process_instance_id"
        case captureReplayKey = "capture_replay_key"
        case payload
    }

    public init(
        domain: CaptureDomain,
        kind: String,
        sequence: UInt64,
        observedAt: String,
        captured: WallAndMonotonicTime,
        processInstanceID: UUID,
        captureReplayKey: String? = nil,
        payload: JSONValue
    ) throws {
        guard !kind.isEmpty else { throw CaptureError.invalidEntry("kind is empty") }
        guard sequence > 0 else { throw CaptureError.invalidEntry("sequence is zero") }
        guard CaptureTime.date(rfc3339: observedAt) != nil else {
            throw CaptureError.invalidEntry("observed_at is not valid RFC 3339")
        }
        guard captured.isValid else {
            throw CaptureError.invalidEntry("captured time is invalid or inconsistent")
        }
        guard captureReplayKey?.isEmpty != true else {
            throw CaptureError.invalidEntry("capture_replay_key is empty")
        }
        self.schemaVersion = 1
        self.domain = domain
        self.kind = kind
        self.sequence = sequence
        self.observedAt = observedAt
        self.captured = captured
        self.processInstanceID = processInstanceID
        self.captureReplayKey = captureReplayKey
        self.payload = payload
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
        let kind = try values.decode(String.self, forKey: .kind)
        let sequence = try values.decode(UInt64.self, forKey: .sequence)
        let observedAt = try values.decode(String.self, forKey: .observedAt)
        let captured = try values.decode(WallAndMonotonicTime.self, forKey: .captured)
        let captureReplayKey = try values.decodeIfPresent(
            String.self,
            forKey: .captureReplayKey
        )
        guard schemaVersion == 1 else {
            throw CaptureError.invalidEntry(
                "unsupported schema_version \(schemaVersion)"
            )
        }
        guard !kind.isEmpty else { throw CaptureError.invalidEntry("kind is empty") }
        guard sequence > 0 else { throw CaptureError.invalidEntry("sequence is zero") }
        guard CaptureTime.date(rfc3339: observedAt) != nil else {
            throw CaptureError.invalidEntry("observed_at is not valid RFC 3339")
        }
        guard captured.isValid else {
            throw CaptureError.invalidEntry("captured time is invalid or inconsistent")
        }
        guard captureReplayKey?.isEmpty != true else {
            throw CaptureError.invalidEntry("capture_replay_key is empty")
        }

        self.schemaVersion = schemaVersion
        domain = try values.decode(CaptureDomain.self, forKey: .domain)
        self.kind = kind
        self.sequence = sequence
        self.observedAt = observedAt
        self.captured = captured
        processInstanceID = try values.decode(UUID.self, forKey: .processInstanceID)
        self.captureReplayKey = captureReplayKey
        payload = try values.decode(JSONValue.self, forKey: .payload)
    }
}

public struct TrackingIntent: Sendable, Equatable, Codable {
    public let armed: Bool
    public let coverageState: CoverageState
    public let bootID: UUID?

    enum CodingKeys: String, CodingKey {
        case armed
        case coverageState = "coverage_state"
        case bootID = "boot_id"
    }

    public init(armed: Bool, coverageState: CoverageState, bootID: UUID?) {
        self.armed = armed
        self.coverageState = coverageState
        self.bootID = bootID
    }
}

public enum CaptureError: Error, LocalizedError, Equatable {
    case invalidEntry(String)
    case corruptState(String)
    case unsafeFilename(String)
    case zipTooLarge
    case restorePending(CaptureDomain)
    case stopped
    case full

    public var errorDescription: String? {
        switch self {
        case .restorePending(let domain): "\(domain.rawValue) waits for this install's restore from Lifestream"
        case .stopped: "This install was replaced and records nothing more"
        case .full: "This iPhone is full: nothing is saved until it has room"
        case .invalidEntry(let message): "Invalid capture entry: \(message)"
        case .corruptState(let message): "Corrupt capture state: \(message)"
        case .unsafeFilename(let name): "Unsafe archive filename: \(name)"
        case .zipTooLarge:
            "ZIP export exceeds supported entry, filename, manifest, or metadata limits"
        }
    }
}
