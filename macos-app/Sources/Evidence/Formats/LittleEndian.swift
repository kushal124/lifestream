import Foundation

enum LittleEndian {
    static func appendWord(_ value: Int, to data: inout Data) {
        var word = UInt32(value).littleEndian
        withUnsafeBytes(of: &word) { data.append(contentsOf: $0) }
    }

    static func word(in data: Data, at offset: Int) -> Int {
        data.withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self))) }
    }
}
