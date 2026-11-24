import DeviceFiles
import Foundation

public struct BatchFiles {
    public static let maximumBytes = 1 << 28

    public let files: DeviceFiles

    public init(_ files: DeviceFiles) {
        self.files = files
    }

    public func repair(_ open: URL, firstLineAt: (String) -> Date?) throws -> Date? {
        guard FileManager.default.fileExists(atPath: open.path) else { return nil }
        let log = try files.log(open)
        defer { log.close() }
        try log.repair()
        guard try files.size(of: open) > 0, let bytes = try files.read(open, maximumBytes: Self.maximumBytes) else {
            log.close()
            try? FileManager.default.removeItem(at: open)
            return nil
        }
        guard let first = Self.firstLine(bytes).flatMap(firstLineAt) else {
            log.close()
            try DeviceFiles.moveFresh(open, into: open.deletingLastPathComponent(),
                                      stem: "\(open.lastPathComponent).torn-\(UTCInstant.basic(Date()))", suffix: "")
            return nil
        }
        if let end = bytes.lastIndex(of: 0x0A).map({ $0 + 1 }), end < bytes.count {
            try log.cut(keepingPlainBytes: end)
        }
        return first
    }

    public func seal(_ open: URL, firstLineAt: Date) throws {
        guard FileManager.default.fileExists(atPath: open.path) else { return }
        try DeviceFiles.moveFresh(open, into: open.deletingLastPathComponent(),
                                  stem: UTCInstant.basic(firstLineAt), suffix: ".jsonl")
    }

    public func lastLine(_ batch: URL) -> Data? {
        guard let bytes = try? files.read(batch, maximumBytes: Self.maximumBytes),
              let end = bytes.lastIndex(of: 0x0A) else { return nil }
        let start = bytes[..<end].lastIndex(of: 0x0A).map { $0 + 1 } ?? bytes.startIndex
        return Data(bytes[start..<end])
    }

    static func firstLine(_ bytes: Data) -> String? {
        guard let newline = bytes.firstIndex(of: 0x0A) else { return nil }
        return String(data: bytes[..<newline], encoding: .utf8)
    }
}
