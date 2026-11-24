import COnnxRuntime
import CryptoKit
import Foundation

enum ModelFile: String {
    case detector = "det_10g.onnx"
    case recognizer = "w600k_r50.onnx"

    var sha256: String {
        switch self {
        case .detector: "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91"
        case .recognizer: "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43"
        }
    }

    func verified(in directory: String) throws -> String {
        let path = (directory as NSString).appendingPathComponent(rawValue)
        guard let handle = FileHandle(forReadingAtPath: path) else {
            throw EngineError.failed("model file \(path) is missing; run faces/fetch-models.sh")
        }
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 8 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard digest == sha256 else {
            throw EngineError.failed("model file \(path) has SHA-256 \(digest), not \(sha256)")
        }
        return path
    }
}

enum Runtime: String, Codable, CaseIterable {
    case gpu, cpu
}

final class Session: @unchecked Sendable {
    private let handle: OpaquePointer

    init(_ file: ModelFile, at path: String, runtime: Runtime, dimension: (name: String, value: Int)) throws {
        let open = { (model: String, cache: String?) throws -> OpaquePointer in
            var message = [CChar](repeating: 0, count: 2048)
            guard let opened = fe_session_open(model, cache, dimension.name, Int64(dimension.value),
                                               &message, message.count) else {
                throw EngineError.failed("cannot open \(path) on the \(runtime): \(Self.text(message))")
            }
            return opened
        }
        handle = runtime == .gpu ? try Compiled.open(file, at: path, dimension: dimension, with: open)
                                 : try open(path, nil)
    }

    deinit { fe_session_close(handle) }

    func run(_ input: [Float], shape: [Int], outputs counts: [Int]) throws -> [[Float]] {
        let buffers = counts.map { UnsafeMutablePointer<Float>.allocate(capacity: $0) }
        defer { buffers.forEach { $0.deallocate() } }
        var message = [CChar](repeating: 0, count: 2048)
        let pointers: [UnsafeMutablePointer<Float>?] = buffers
        guard fe_session_run(handle, input, shape.map { Int64($0) }, shape.count, pointers, counts, counts.count,
                             &message, message.count) == 0
        else { throw EngineError.failed("onnxruntime: \(Self.text(message))") }
        return zip(buffers, counts).map { Array(UnsafeBufferPointer(start: $0, count: $1)) }
    }

    private static func text(_ message: [CChar]) -> String {
        String(decoding: message.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }
}

enum Compiled {
    static let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("face-engine/compiled")

    static func open(_ file: ModelFile, at path: String, dimension: (name: String, value: Int),
                     with open: (_ model: String, _ cache: String) throws -> OpaquePointer) throws -> OpaquePointer {
        let stated = "onnxruntime \(String(cString: fe_runtime_version()))\n\(file.sha256)\n\(dimension.name)=\(dimension.value)\n"
        let key = SHA256.hash(data: Data(stated.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        let folder = root.appendingPathComponent(key)
        let ready = folder.appendingPathComponent("ready")
        let link = folder.appendingPathComponent("model.onnx")
        let files = FileManager.default
        do {
            try files.createDirectory(at: root, withIntermediateDirectories: true)
            let lock = Darwin.open(root.appendingPathComponent("\(key).lock").path, O_RDWR | O_CREAT, 0o644)
            guard lock >= 0 else { throw EngineError.failed("cannot open its lock: \(String(cString: strerror(errno)))") }
            defer { close(lock) }
            guard flock(lock, LOCK_EX) == 0 else { throw EngineError.failed("cannot lock it: \(String(cString: strerror(errno)))") }
            if !files.fileExists(atPath: ready.path), files.fileExists(atPath: folder.path) { try files.removeItem(at: folder) }
            try files.createDirectory(at: folder, withIntermediateDirectories: true)
            try? files.removeItem(at: link)
            try files.createSymbolicLink(atPath: link.path, withDestinationPath: URL(fileURLWithPath: path).standardizedFileURL.path)
            do {
                let handle = try open(link.path, folder.path)
                if !files.fileExists(atPath: ready.path) { try Data().write(to: ready) }
                return handle
            } catch {
                try? files.removeItem(at: folder)
                throw error
            }
        } catch let error as EngineError {
            throw error
        } catch {
            throw EngineError.failed("the compiled cache \(folder.path): \(error.localizedDescription)")
        }
    }
}
