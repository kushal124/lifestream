import Foundation

public struct HomeClock: Sendable, Equatable {
    public struct Run: Sendable, Equatable {
        public let day: String
        public let startMs: Int64
        public let days: Int64
        public let zone: TimeZone
        let ordinal: Int64

        public init?(day: String, startMs: Int64, days: Int64, zone: String) {
            guard days >= 1, let ordinal = Self.ordinal(of: day), let zone = TimeZone(identifier: zone) else { return nil }
            self.day = day
            self.startMs = startMs
            self.days = days
            self.zone = zone
            self.ordinal = ordinal
        }

        static func ordinal(of day: String) -> Int64? {
            let bytes = Array(day.utf8)
            guard bytes.count == 10, bytes[4] == UInt8(ascii: "-"), bytes[7] == UInt8(ascii: "-"),
                  bytes.enumerated().allSatisfy({ $0.offset == 4 || $0.offset == 7 || (48...57).contains($0.element) }),
                  let year = Int64(day.prefix(4)), let month = Int64(day.dropFirst(5).prefix(2)),
                  let date = Int64(day.suffix(2)), (1...12).contains(month), date >= 1 else { return nil }
            let ordinal = HomeClock.ordinal(year: year, month: month, day: date)
            return HomeClock.day(ordinal) == day ? ordinal : nil
        }
    }

    public struct Day: Sendable, Equatable {
        public let day: String
        public let zone: TimeZone
        public let startMs: Int64
        public let endMs: Int64
    }

    public let id: String?
    public let runs: [Run]

    static let dayMs: Int64 = 86_400_000
    static let placeholderHour = 4

    public init?(id: String, runs: [Run]) {
        guard !runs.isEmpty else { return nil }
        self.id = id
        self.runs = runs
    }

    private init(placeholder run: Run) {
        id = nil
        runs = [run]
    }

    public init?(body: Data) {
        guard let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let id = object["id"] as? String, !id.isEmpty, let listed = object["runs"] as? [Any] else { return nil }
        var runs: [Run] = []
        for item in listed {
            guard let run = item as? [String: Any], let day = run["day"] as? String, let zone = run["zone"] as? String,
                  let start = Self.whole(run["start_ms"]), let days = Self.whole(run["days"]),
                  let read = Run(day: day, startMs: start, days: days, zone: zone) else { return nil }
            runs.append(read)
        }
        self.init(id: id, runs: runs)
    }

    public static func placeholder(at now: Date, zone: TimeZone) -> HomeClock {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        var parts = calendar.dateComponents([.year, .month, .day], from: now)
        parts.hour = placeholderHour
        var start = calendar.date(from: parts) ?? now
        if start > now { start = calendar.date(byAdding: .day, value: -1, to: start) ?? start }
        let date = calendar.dateComponents([.year, .month, .day], from: start)
        let ordinal = Self.ordinal(year: Int64(date.year ?? 1970), month: Int64(date.month ?? 1), day: Int64(date.day ?? 1))
        let run = Run(day: Self.day(ordinal), startMs: Self.ms(start), days: 1, zone: zone.identifier)!
        return HomeClock(placeholder: run)
    }

    public func dayAt(_ ms: Int64) -> Day {
        var at = 0
        var low = 1, high = runs.count - 1
        while low <= high {
            let middle = (low + high) / 2
            if runs[middle].startMs <= ms { at = middle; low = middle + 1 } else { high = middle - 1 }
        }
        let run = runs[at]
        let last = at == runs.count - 1
        let counted = Self.floorDivide(ms - run.startMs, Self.dayMs)
        let k = last ? counted : min(counted, run.days - 1)
        let start = run.startMs + k * Self.dayMs
        let end = !last && k == run.days - 1 ? runs[at + 1].startMs : start + Self.dayMs
        return Day(day: Self.day(run.ordinal + k), zone: run.zone, startMs: start, endMs: end)
    }

    public func dayAt(_ date: Date) -> Day {
        dayAt(Self.ms(date))
    }


    static func ms(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded(.down))
    }

    private static func floorDivide(_ value: Int64, _ by: Int64) -> Int64 {
        let quotient = value / by
        return value % by < 0 ? quotient - 1 : quotient
    }

    static func ordinal(year: Int64, month: Int64, day: Int64) -> Int64 {
        let y = month <= 2 ? year - 1 : year
        let era = floorDivide(y, 400)
        let yearOfEra = y - era * 400
        let dayOfYear = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }

    static func day(_ ordinal: Int64) -> String {
        let z = ordinal + 719_468
        let era = floorDivide(z, 146_097)
        let dayOfEra = z - era * 146_097
        let yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let shifted = (5 * dayOfYear + 2) / 153
        let date = dayOfYear - (153 * shifted + 2) / 5 + 1
        let month = shifted < 10 ? shifted + 3 : shifted - 9
        let year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
        return String(format: "%04lld-%02lld-%02lld", year, month, date)
    }

    private static func whole(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return Int64(exactly: number.doubleValue)
    }
}
