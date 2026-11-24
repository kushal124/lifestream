import Foundation
import Compression

enum StreamCompression {
    private static let chunk = 1 << 20

    static func encode(_ parts: [Data], algorithm: compression_algorithm) -> Data? {
        var output = Data()
        let ok = run(.encode, algorithm: algorithm, parts: parts) { produced in
            output.append(produced)
            return true
        }
        return ok ? output : nil
    }

    static func decode(_ data: Data, algorithm: compression_algorithm, maximumBytes: Int) -> Data? {
        var output = Data()
        let ok = run(.decode, algorithm: algorithm, parts: [data]) { produced in
            guard output.count + produced.count <= maximumBytes else {
                return false
            }
            output.append(produced)
            return true
        }
        return ok ? output : nil
    }

    private enum Operation {
        case encode, decode
    }

    private static func run(
        _ operation: Operation,
        algorithm: compression_algorithm,
        parts: [Data],
        sink: (Data) -> Bool
    ) -> Bool {
        let pointer = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { pointer.deallocate() }
        let kind = operation == .encode ? COMPRESSION_STREAM_ENCODE : COMPRESSION_STREAM_DECODE
        guard compression_stream_init(pointer, kind, algorithm) == COMPRESSION_STATUS_OK else {
            return false
        }
        defer { compression_stream_destroy(pointer) }
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
        defer { buffer.deallocate() }
        let nonEmpty = parts.filter { !$0.isEmpty }
        if nonEmpty.isEmpty {
            return operation == .encode ? drain(pointer, buffer: buffer, input: nil, last: true, sink: sink) == .end : false
        }
        for (index, part) in nonEmpty.enumerated() {
            let last = index == nonEmpty.count - 1
            let result = part.withUnsafeBytes { raw in
                drain(pointer, buffer: buffer, input: raw.bindMemory(to: UInt8.self), last: last, sink: sink)
            }
            switch result {
            case .end:
                return last
            case .failed:
                return false
            case .consumed:
                continue
            }
        }
        return false
    }

    private enum Drained {
        case consumed, end, failed
    }

    private static func drain(
        _ stream: UnsafeMutablePointer<compression_stream>,
        buffer: UnsafeMutablePointer<UInt8>,
        input: UnsafeBufferPointer<UInt8>?,
        last: Bool,
        sink: (Data) -> Bool
    ) -> Drained {
        stream.pointee.src_ptr = input?.baseAddress ?? UnsafePointer(buffer)
        stream.pointee.src_size = input?.count ?? 0
        let flags = last ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0
        while true {
            stream.pointee.dst_ptr = buffer
            stream.pointee.dst_size = chunk
            let status = compression_stream_process(stream, flags)
            let produced = chunk - stream.pointee.dst_size
            if produced > 0, !sink(Data(bytes: buffer, count: produced)) {
                return .failed
            }
            switch status {
            case COMPRESSION_STATUS_END:
                return stream.pointee.src_size == 0 ? .end : .failed
            case COMPRESSION_STATUS_OK:
                if stream.pointee.src_size == 0 && produced < chunk && !last {
                    return .consumed
                }
                if stream.pointee.src_size == 0 && produced == 0 {
                    return last ? .failed : .consumed
                }
            default:
                return .failed
            }
        }
    }
}
