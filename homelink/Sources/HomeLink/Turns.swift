import Foundation

final class Turns: @unchecked Sendable {
    private let lock = NSLock()
    private var busy = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func run<T>(_ body: () async throws -> T) async rethrows -> T {
        await withCheckedContinuation { (next: CheckedContinuation<Void, Never>) in
            lock.withLock {
                if busy {
                    waiting.append(next)
                } else {
                    busy = true
                    next.resume()
                }
            }
        }
        defer {
            lock.withLock {
                if waiting.isEmpty { busy = false } else { waiting.removeFirst().resume() }
            }
        }
        return try await body()
    }
}
