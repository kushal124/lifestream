import Foundation

public enum PersistenceLoadState<Value: Sendable>: Sendable {
    case missing
    case loaded(Value)
    case failed(String)
}

public enum TrackingIntentSaveResult: Sendable, Equatable {
    case durable
    case visibleButDurabilityUnconfirmed(String)
}

public struct TrackingIntentStore: Sendable {
    private static let maximumFileBytes = 1 * 1_024 * 1_024
    public let url: URL

    public init(url: URL) { self.url = url }

    public func load() throws -> TrackingIntent? {
        do {
            guard
                let data = try FileDurability.readRegularFileIfPresent(
                    at: url,
                    maximumBytes: Self.maximumFileBytes
                )
            else {
                return nil
            }
            return try JSONDecoder.lifestream().decode(TrackingIntent.self, from: data)
        } catch {
            throw CaptureError.corruptState("tracking intent: \(error)")
        }
    }

    public func loadState() -> PersistenceLoadState<TrackingIntent> {
        do {
            guard let intent = try load() else { return .missing }
            return .loaded(intent)
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    @discardableResult
    public func save(_ intent: TrackingIntent) throws -> TrackingIntentSaveResult {
        let parent = url.deletingLastPathComponent()
        let data = try JSONEncoder.lifestream().encode(intent)
        guard data.count <= Self.maximumFileBytes else {
            throw CaptureError.corruptState("tracking intent exceeds its bounded file limit")
        }
        do {
            try FileDurability.createDirectoryDurably(at: parent)
            if try FileDurability.readRegularFileIfPresent(
                at: url,
                maximumBytes: Self.maximumFileBytes
            ) == data {
                try FileDurability.synchronizeFile(at: url)
                try FileDurability.synchronizeParentDirectory(of: url)
                return .durable
            }
            try data.write(
                to: url,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
            try FileDurability.synchronizeFile(at: url)
            try FileDurability.synchronizeParentDirectory(of: url)
            return .durable
        } catch {
            if let visible = try? FileDurability.readRegularFileIfPresent(
                at: url,
                maximumBytes: Self.maximumFileBytes
            ),
                visible == data
            {
                return .visibleButDurabilityUnconfirmed(error.localizedDescription)
            }
            throw error
        }
    }
}
