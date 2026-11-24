import Foundation

public enum HistoryStart {
    public static let lateArrivals: TimeInterval = 30 * 24 * 60 * 60

    public static func health(start: Date?, since: Date?) -> Date? {
        later(start, since.map { $0.addingTimeInterval(-lateArrivals) })
    }

    public static func motion(usualStart: Date, since: Date?, start: Date?, calendar: Calendar) -> (activities: Date, pedometerDays: Date) {
        let from = later(later(usualStart, since), start) ?? usualStart
        return (from, calendar.startOfDay(for: from))
    }

    public static func usage(start: Date?, calendar: Calendar) -> Date? {
        start.map { calendar.startOfDay(for: $0) }
    }

    public static func earlier(_ start: Date?, than kept: Date?) -> Bool {
        guard let kept else { return false }
        guard let start else { return true }
        return start < kept
    }

    public static func later(_ one: Date?, _ other: Date?) -> Date? {
        guard let one else { return other }
        guard let other else { return one }
        return max(one, other)
    }
}
