import Evidence
import Foundation

enum CompactionPermit {
    private static let lock = NSLock()

    static func withPermit<T>(_ operation: () throws -> T) throws -> T {
        guard lock.try() else {
            throw VideoArchiveError.busy
        }
        defer { lock.unlock() }
        return try operation()
    }
}
