import CryptoKit
import Foundation

public enum SHA256Digest {
    public static func hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public static func tagged(_ data: Data) -> String { "sha256:\(hex(data))" }

    public static func isCanonicalTagged(_ value: String) -> Bool {
        guard value.hasPrefix("sha256:") else { return false }
        let hex = value.dropFirst("sha256:".count)
        return hex.utf8.count == 64
            && hex.utf8.allSatisfy {
                ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66)
            }
    }

    public static func taggedFile(at url: URL) throws -> String {
        let handle = try FileDurability.openRegularFileForReading(at: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while try withHashTemporaryObjects({
            guard let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty else { return false }
            hasher.update(data: chunk)
            return true
        }) {}
        return "sha256:" + hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func inspectFile(at url: URL, archiveChecksum: Bool = true) throws -> (hash: String, bytes: UInt64, crc32: UInt32) {
        let handle = try FileDurability.openRegularFileForReading(at: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        var crc = CRC32.Accumulator()
        var count: UInt64 = 0
        while try withHashTemporaryObjects({
            guard let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty else { return false }
            hasher.update(data: chunk)
            if archiveChecksum { crc.update(chunk) }
            count += UInt64(chunk.count)
            return true
        }) {}
        return ("sha256:" + hasher.finalize().map { String(format: "%02x", $0) }.joined(), count, crc.finalized)
    }
}

enum CRC32 {
    private static let tables: [[UInt32]] = {
        let first: [UInt32] = (0..<256).map { value in
            var crc = UInt32(value)
            for _ in 0..<8 {
                crc = (crc & 1) == 1 ? (0xEDB8_8320 ^ (crc >> 1)) : (crc >> 1)
            }
            return crc
        }
        var result = [first]
        for index in 1..<8 {
            result.append(
                result[index - 1].map { crc in
                    first[Int(crc & 0xFF)] ^ (crc >> 8)
                }
            )
        }
        return result
    }()

    private static func updateByte(_ byte: UInt8, crc: UInt32) -> UInt32 {
        tables[0][Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8)
    }

    static func checksum(_ data: Data) -> UInt32 {
        var accumulator = Accumulator()
        accumulator.update(data)
        return accumulator.finalized
    }

    struct Accumulator {
        private var value: UInt32 = 0xFFFF_FFFF

        mutating func update(_ data: Data) {
            data.withUnsafeBytes { rawBytes in
                let bytes = rawBytes.bindMemory(to: UInt8.self)
                var index = 0
                while bytes.count - index >= 8 {
                    let word =
                        UInt32(bytes[index])
                        | (UInt32(bytes[index + 1]) << 8)
                        | (UInt32(bytes[index + 2]) << 16)
                        | (UInt32(bytes[index + 3]) << 24)
                    let mixed = value ^ word
                    value =
                        CRC32.tables[7][Int(mixed & 0xFF)]
                        ^ CRC32.tables[6][Int((mixed >> 8) & 0xFF)]
                        ^ CRC32.tables[5][Int((mixed >> 16) & 0xFF)]
                        ^ CRC32.tables[4][Int((mixed >> 24) & 0xFF)]
                        ^ CRC32.tables[3][Int(bytes[index + 4])]
                        ^ CRC32.tables[2][Int(bytes[index + 5])]
                        ^ CRC32.tables[1][Int(bytes[index + 6])]
                        ^ CRC32.tables[0][Int(bytes[index + 7])]
                    index += 8
                }
                while index < bytes.count {
                    value = CRC32.updateByte(bytes[index], crc: value)
                    index += 1
                }
            }
        }

        var finalized: UInt32 { value ^ 0xFFFF_FFFF }
    }
}

private func withHashTemporaryObjects<T>(_ body: () throws -> T) rethrows -> T {
    #if canImport(ObjectiveC)
        return try autoreleasepool(invoking: body)
    #else
        return try body()
    #endif
}
