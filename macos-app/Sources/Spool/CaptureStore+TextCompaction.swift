import Evidence
import Foundation

extension CaptureStore {
    public func compactText(now: Date = Date()) async throws -> TextCompactionReport {
        let task = Task.detached(priority: .utility) {
            try TextCompactionPermit.withPermit {
                try ResourceMeter.shared.measure(.textCompaction) { try TextCompaction.compact(store: self, now: now) }
            }
        }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    var textNeedsRecovery: Bool {
        get {
            mutex.lock()
            defer { mutex.unlock() }
            return textRecoveryRequired
        }
        set {
            mutex.lock()
            defer { mutex.unlock() }
            textRecoveryRequired = newValue
        }
    }

    var textCursor: Int? {
        get {
            mutex.lock()
            defer { mutex.unlock() }
            return textWindowCursor
        }
        set {
            mutex.lock()
            defer { mutex.unlock() }
            textWindowCursor = newValue
        }
    }
}

enum TextCompactionPermit {
    private static let lock = NSLock()

    static func withPermit<T>(_ operation: () throws -> T) throws -> T {
        guard lock.try() else {
            throw TextCompactionError.busy
        }
        defer { lock.unlock() }
        return try operation()
    }
}
