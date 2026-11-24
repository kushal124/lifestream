import AVFoundation
import Foundation
import LifestreamCaptureCore

struct VoiceEncoderSettings: Sendable, Equatable {
    let format: String
    let container: String
    let mimeType: String
    let fileExtension: String
    let sampleRateHz: Int
    let channels: Int
    let bitRate: Int

    static let aacMono48k = VoiceEncoderSettings(
        format: "aac_lc",
        container: "m4a",
        mimeType: "audio/mp4",
        fileExtension: "m4a",
        sampleRateHz: 48_000,
        channels: 1,
        bitRate: 128_000
    )

    var avSettings: [String: Any] {
        [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: Double(sampleRateHz),
            AVNumberOfChannelsKey: channels,
            AVEncoderBitRateKey: bitRate,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
    }
}

struct VoiceInputRoute: Sendable, Equatable {
    let portType: String
    let portName: String
}

enum VoiceNoteMode: String, Equatable, Sendable {
    case hold
    case handsFree = "hands_free"
}

struct VoiceNoteSnapshot: Sendable {
    let file: OwnedMediaFile
    let encoder: VoiceEncoderSettings
    let startedAt: Date
    let endedAt: Date
    let durationSeconds: Double
    let mode: VoiceNoteMode
    let endReason: String
    let input: VoiceInputRoute?
}

enum VoicePayload {
    static let kind = "voice_note"

    static func payload(
        snapshot: VoiceNoteSnapshot,
        blobHash: String,
        blobBytes: UInt64,
        location: CameraLocationFix?
    ) -> JSONValue {
        let locationValue: JSONValue =
            location.map {
                .object([
                    "latitude": .number($0.latitude),
                    "longitude": .number($0.longitude),
                    "horizontal_accuracy": .number($0.horizontalAccuracy),
                    "timestamp": .string(CaptureTime.rfc3339($0.timestamp)),
                ])
            } ?? .null
        let inputValue: JSONValue =
            snapshot.input.map {
                .object([
                    "port_type": .string($0.portType),
                    "port_name": .string($0.portName),
                ])
            } ?? .null
        return .object([
            "blob": .object([
                "hash": .string(blobHash),
                "type": .string(snapshot.encoder.mimeType),
                "bytes": .unsigned(blobBytes),
                "role": .string("voice_note"),
            ]),
            "duration_seconds": .number(snapshot.durationSeconds),
            "started_at": .string(CaptureTime.rfc3339(snapshot.startedAt)),
            "ended_at": .string(CaptureTime.rfc3339(snapshot.endedAt)),
            "capture_mode": .string(snapshot.mode.rawValue),
            "end_reason": .string(snapshot.endReason),
            "encoder": .object([
                "format": .string(snapshot.encoder.format),
                "container": .string(snapshot.encoder.container),
                "sample_rate_hz": .integer(Int64(snapshot.encoder.sampleRateHz)),
                "channels": .integer(Int64(snapshot.encoder.channels)),
                "bit_rate": .integer(Int64(snapshot.encoder.bitRate)),
            ]),
            "input": inputValue,
            "location": locationValue,
        ])
    }

    static func draft(
        snapshot: VoiceNoteSnapshot,
        blobHash: String,
        blobBytes: UInt64,
        location: CameraLocationFix?,
        captured: WallAndMonotonicTime = .init()
    ) -> CaptureDraft {
        .init(
            kind: kind,
            observedAt: CaptureTime.rfc3339(snapshot.startedAt),
            captured: captured,
            payload: payload(snapshot: snapshot, blobHash: blobHash, blobBytes: blobBytes, location: location)
        )
    }
}

actor VoiceRecorder {
    private let store: CaptureStore
    private let locationRecorder: LocationRecorderCoordinator
    private let authorizeWrite: @Sendable () async throws -> Void

    init(
        store: CaptureStore,
        locationRecorder: LocationRecorderCoordinator,
        authorizeWrite: @escaping @Sendable () async throws -> Void
    ) {
        self.store = store
        self.locationRecorder = locationRecorder
        self.authorizeWrite = authorizeWrite
    }

    func record(_ snapshot: VoiceNoteSnapshot) async throws -> CaptureEntry {
        try await authorizeWrite()
        let recorder = locationRecorder
        let fix = await MainActor.run { recorder.lastLocation.map(CameraLocationFix.init) }
        guard try FileDurability.regularFileSize(at: snapshot.file.url) > 0 else {
            throw VoiceCaptureError.noBytes
        }
        let blob = try await store.storeBlob(file: snapshot.file)
        return try await store.append(
            domain: .voice,
            draft: VoicePayload.draft(snapshot: snapshot, blobHash: blob.hash, blobBytes: blob.bytes, location: fix)
        )
    }

}
