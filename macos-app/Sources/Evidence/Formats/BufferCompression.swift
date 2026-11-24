import Foundation
import Compression

enum BufferCompression {
    static func compress(_ source: Data, algorithm: compression_algorithm, capacity: Int) -> Data? {
        guard !source.isEmpty, capacity > 0 else {
            return nil
        }
        var output = Data(count: capacity)
        let count = output.withUnsafeMutableBytes { destination in
            source.withUnsafeBytes { input in
                compression_encode_buffer(
                    destination.bindMemory(to: UInt8.self).baseAddress!,
                    destination.count,
                    input.bindMemory(to: UInt8.self).baseAddress!,
                    input.count,
                    nil,
                    algorithm
                )
            }
        }
        guard count > 0 else {
            return nil
        }
        output.count = count
        return output
    }

    static func expand(_ source: Data, count: Int, algorithm: compression_algorithm) -> Data? {
        guard !source.isEmpty, count > 0 else {
            return nil
        }
        var output = Data(count: count + 1)
        let actual = output.withUnsafeMutableBytes { destination in
            source.withUnsafeBytes { input in
                compression_decode_buffer(
                    destination.bindMemory(to: UInt8.self).baseAddress!,
                    destination.count,
                    input.bindMemory(to: UInt8.self).baseAddress!,
                    input.count,
                    nil,
                    algorithm
                )
            }
        }
        guard actual == count else {
            return nil
        }
        output.count = count
        return output
    }
}
