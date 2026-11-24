import DeviceFiles
import Foundation
import HomeLink

public final class StoreConsent: @unchecked Sendable {
    public enum Answer: String, Codable, Sendable {
        case allowed, refused
    }

    private struct Kept: Codable {
        var answers: [String: Answer] = [:]
        var paths: [String: [String]] = [:]
    }

    private let file: URL
    private let files: DeviceFiles
    private let known: Set<String>
    private let lock = NSLock()
    private var kept: Kept

    public init(file: URL, known: Set<String> = Set(KnownStores.digests.values), files: DeviceFiles) {
        self.file = file
        self.files = files
        self.known = known
        kept = (try? files.read(file, maximumBytes: ShippingState.mostKept)).flatMap { try? JSONDecoder().decode(Kept.self, from: $0) } ?? Kept()
    }

    public func answer(_ digest: String) -> Answer? {
        if known.contains(digest) { return .allowed }
        return lock.withLock { kept.answers[digest] }
    }

    public func allowedPaths(_ connector: String) -> [String] {
        lock.withLock { kept.paths[connector] ?? [] }
    }

    public func keep(_ answer: Answer, for digest: String, connector: String, paths: [String]) throws {
        let data: Data = try lock.withLock {
            kept.answers[digest] = answer
            if answer == .allowed { kept.paths[connector] = paths }
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            return try encoder.encode(kept)
        }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try ShippingState.replace(file, with: data, files: files)
    }
}
