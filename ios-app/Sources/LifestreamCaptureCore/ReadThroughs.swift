import Foundation
import HomeLink

@MainActor
public final class ReadThroughs {
    public private(set) var held: [String: Int64]?
    private var out = false

    public init() {}

    public func read(_ sources: () async throws -> [HomeLink.SourceRead]) async -> Bool {
        guard !out else { return false }
        out = true
        defer { out = false }
        guard let answer = try? await sources() else { return false }
        let read = Dictionary(answer.compactMap { row in row.readThroughMs.map { (row.id, $0) } }, uniquingKeysWith: { first, _ in first })
        guard read != held else { return false }
        held = read
        return true
    }
}
