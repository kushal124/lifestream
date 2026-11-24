import Darwin
import Evidence
import Foundation
import Recorder
import Screen
import Spool

@MainActor enum SpoolCommands {
    static func status(_ options: Options) throws -> CommandOutcome {
        let store = try opened(options)
        try writeJSONLine(store.status())
        if let state = try RuntimeStatus.read(from: options.directory, plain: MacProcess.current.plain) {
            try writeJSONLine(heartbeat(state))
        }
        return .succeeded
    }

    static func query(_ options: Options) throws -> CommandOutcome {
        let store = try opened(options)
        for observation in try store.read(limit: options.limit, since: options.since) {
            try writeJSONLine(observation)
        }
        return .succeeded
    }

    static func image(_ options: Options) async throws -> CommandOutcome {
        guard let destination = options.outputURL else {
            throw UsageError.message("Image export requires --output PATH")
        }
        let store = try opened(options)
        let observations = try store.read(limit: options.limit, since: options.since)
        guard let observation = observations.first(where: { $0.imageFile != nil }) else {
            throw UsageError.message("No captured image in the selected range")
        }
        let png = try await CaptureDiagnostics.pngForSavedImage(store.readImage(for: observation))
        try png.write(to: destination, options: .atomic)
        try writeJSONLine(["imageFile": destination.path])
        return .succeeded
    }

    static func ocr(_ options: Options) async throws -> CommandOutcome {
        guard options.limit <= 20 else { throw UsageError.message("On-demand OCR requires --limit 20 or fewer") }
        let store = try opened(options)
        for observation in try store.read(limit: options.limit, since: options.since) {
            guard let imageFile = observation.imageFile else { continue }
            let result = await CaptureDiagnostics.recognizeSavedImage(try store.readImage(for: observation))
            try writeJSONLine(OnDemandOCR(capturedAt: observation.capturedAt, imageFile: imageFile,
                                          recognizedAt: Date(), status: result.1, ocr: result.0))
        }
        return .succeeded
    }

    static func decodeMetadata(_ options: Options) throws -> CommandOutcome {
        guard let source = options.inputURL else { throw UsageError.message("Metadata decoding requires --input PATH") }
        let handle = try FileHandle(forReadingFrom: source)
        defer { try? handle.close() }
        let packet = try handle.read(upToCount: MetadataCodec.maximumPacketBytes + 1) ?? Data()
        FileHandle.standardOutput.write(try MetadataCodec.decode(packet))
        FileHandle.standardOutput.write(Data("\n".utf8))
        return .succeeded
    }

    private static func opened(_ options: Options) throws -> CaptureStore {
        return try CaptureStore(directory: options.directory, files: try MacProcess.current.writing(), scratch: MacProcess.current.scratch, readOnly: true)
    }

    private static func heartbeat(_ state: RuntimeStatus) -> [String: String] {
        [
            "state": state.state.rawValue,
            "heartbeatAgeSeconds": String(Date().timeIntervalSince(state.updatedAt)),
            "pid": String(state.pid),
            "processExists": String(kill(state.pid, 0) == 0),
            "consecutiveTechnicalFailedAttempts": String(state.consecutiveTechnicalFailedAttempts ?? 0),
            "lastTechnicalFailureReason": state.lastTechnicalFailureReason ?? "none",
            "lastTechnicalFailureEpochSeconds": state.lastTechnicalFailureAt
                .map { String($0.timeIntervalSince1970) } ?? "none",
        ]
    }
}

struct OnDemandOCR: Codable {
    let capturedAt: Date
    let imageFile: String
    let recognizedAt: Date
    let status: String
    let ocr: [TextObservation]
}
