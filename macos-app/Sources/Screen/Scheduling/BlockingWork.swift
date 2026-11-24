import Foundation

enum BlockingWork {
    static func run<Value>(_ work: @escaping () -> Value) async -> Value {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                continuation.resume(returning: autoreleasepool(invoking: work))
            }
        }
    }

    static func throwing<Value>(_ work: @escaping () throws -> Value) async throws -> Value {
        try await run { Result { try work() } }.get()
    }
}
