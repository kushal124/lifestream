import Foundation
import os

public enum StorageProbe {
    public enum Launch: Equatable, Sendable {
        case goOn
        case locked
    }

    public struct Marker: Codable, Equatable, Sendable {
        public var count: Int
        public var at: [String]

        public init(count: Int, at: [String]) {
            self.count = count
            self.at = at
        }
    }

    public static let markerName = "pre-unlock-launches"
    static let kept = 32
    static let markerWriting: Data.WritingOptions = [.atomic, .noFileProtection]

    public static func launch(root: URL, now: Date = Date(), open: (String) -> Int32 = StorageProbe.openReadOnly) -> Launch {
        let code = open(root.appendingPathComponent("capture/capture.sqlite").path)
        guard code == EPERM || code == EACCES else { return .goOn }
        let url = root.appendingPathComponent(markerName)
        var marker = (try? read(url)) ?? Marker(count: 0, at: [])
        marker.count += 1
        marker.at = Array((marker.at + [CaptureTime.rfc3339(now)]).suffix(kept))
        if let data = try? JSONEncoder().encode(marker) {
            try? data.write(to: url, options: markerWriting)
        }
        return .locked
    }

    public static func marker(root: URL) throws -> Marker? {
        try read(root.appendingPathComponent(markerName))
    }

    public static func stateLockedLaunches(root: URL, into store: CaptureStore, now: Date) async throws {
        let url = root.appendingPathComponent(markerName)
        let marker: Marker
        do {
            guard let read = try read(url) else { return }
            marker = read
        } catch {
            Logger(subsystem: "org.lifestreamprotocol.phone", category: "storage-probe")
                .error("The launches before the first unlock were lost, their marker unreadable: \(String(describing: error), privacy: .public)")
            return try FileDurability.removeRegularFileIfPresent(at: url)
        }
        try await store.append(domain: .location, draft: CaptureDraft(
            kind: "lifecycle",
            observedAt: CaptureTime.rfc3339(now),
            payload: .object([
                "event": .string("launched_before_first_unlock"),
                "detail": .object([
                    "count": .integer(Int64(marker.count)),
                    "at": .array(marker.at.map(JSONValue.string)),
                ]),
            ])))
        try FileDurability.removeRegularFileIfPresent(at: url)
    }

    public static func openReadOnly(_ path: String) -> Int32 {
        let descriptor = Darwin.open(path, O_RDONLY)
        guard descriptor >= 0 else { return errno }
        close(descriptor)
        return 0
    }

    private static func read(_ url: URL) throws -> Marker? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(Marker.self, from: Data(contentsOf: url))
    }
}
