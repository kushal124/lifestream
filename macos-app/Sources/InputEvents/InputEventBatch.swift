import Evidence
import Foundation

public enum InputEventBatch {
    public static let directoryName = "input-events"
    static let openName = "current.jsonl"
    static let chunkName = "current.chunk"
    static let rotationHour = 4

    public static func sealedBatches(in directory: URL) -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.filter { $0.hasSuffix(".jsonl") && $0 != openName }.sorted()
    }

    static func nextRotation(after date: Date, in zone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let match = DateComponents(hour: rotationHour, minute: 0, second: 0)
        return calendar.nextDate(after: date, matching: match, matchingPolicy: .nextTime)
            ?? date.addingTimeInterval(24 * 60 * 60)
    }

    static func mustRotate(firstLineAt: Date, next: Date, in zone: TimeZone) -> Bool {
        next >= nextRotation(after: firstLineAt, in: zone)
    }

    public static func minute(of date: Date) -> Date {
        Date(timeIntervalSince1970: (date.timeIntervalSince1970 / 60).rounded(.down) * 60)
    }

    static func chunkBoundary(after at: Date, in zone: TimeZone) -> Date {
        min(minute(of: at).addingTimeInterval(60), nextRotation(after: at, in: zone))
    }
}
