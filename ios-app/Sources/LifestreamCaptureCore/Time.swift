import Foundation

public enum CaptureTime {
    private static let formatters = CaptureTimeFormatters()

    public static func rfc3339(_ date: Date) -> String {
        let epoch = date.timeIntervalSince1970
        var wholeSeconds = floor(epoch)
        var nanoseconds = Int64(((epoch - wholeSeconds) * 1_000_000_000).rounded(.toNearestOrEven))
        if nanoseconds == 1_000_000_000 {
            wholeSeconds += 1
            nanoseconds = 0
        }
        let seconds = formatters.secondsString(from: Date(timeIntervalSince1970: wholeSeconds))
        return seconds + String(format: ".%09lldZ", nanoseconds)
    }

    public static func date(rfc3339 value: String) -> Date? {
        formatters.date(from: value)
    }

    static func isCanonicalRFC3339(_ value: String) -> Bool {
        let canonicalPattern = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$"#
        guard value.range(of: canonicalPattern, options: .regularExpression) != nil,
            let date = date(rfc3339: value),
            date.timeIntervalSince1970.isFinite
        else {
            return false
        }
        let fractionStart = value.index(value.startIndex, offsetBy: 20)
        let fractionEnd = value.index(before: value.endIndex)
        let fraction = value[fractionStart..<fractionEnd]
        let canonicalSeconds = formatters.secondsString(from: date)
        return canonicalSeconds + "." + fraction + "Z" == value
    }

    static func isCanonicalLocalDay(_ value: String) -> Bool {
        formatters.isCanonicalLocalDay(value)
    }
}

private final class CaptureTimeFormatters: @unchecked Sendable {
    private let lock = NSLock()
    private let seconds = CaptureTimeFormatters.utcGregorian("yyyy-MM-dd'T'HH:mm:ss")
    private let day = CaptureTimeFormatters.utcGregorian("yyyy-MM-dd")
    private let fractional = CaptureTimeFormatters.iso8601(fractional: true)
    private let whole = CaptureTimeFormatters.iso8601(fractional: false)

    func secondsString(from date: Date) -> String {
        lock.lock()
        defer { lock.unlock() }
        return seconds.string(from: date)
    }

    func date(from value: String) -> Date? {
        lock.lock()
        defer { lock.unlock() }
        return fractional.date(from: value) ?? whole.date(from: value)
    }

    func isCanonicalLocalDay(_ value: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let date = day.date(from: value) else { return false }
        return day.string(from: date) == value
    }

    private static func utcGregorian(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone.gmt
        formatter.dateFormat = format
        formatter.isLenient = false
        return formatter
    }

    private static func iso8601(fractional: Bool) -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = fractional
            ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        formatter.timeZone = TimeZone.gmt
        return formatter
    }
}

struct ObservedTimeRange {
    private var earliestDate: Date?
    private var latestDate: Date?
    private(set) var start: String?
    private(set) var end: String?

    mutating func include(_ value: String) throws {
        guard let date = CaptureTime.date(rfc3339: value),
            date.timeIntervalSince1970.isFinite
        else {
            throw CaptureError.corruptState(
                "export time range contains invalid observed_at"
            )
        }
        if earliestDate.map({ date < $0 }) ?? true {
            earliestDate = date
            start = value
        }
        if latestDate.map({ date > $0 }) ?? true {
            latestDate = date
            end = value
        }
    }
}

public struct ProcessClock: Sendable {
    public static let shared = ProcessClock()
    private let uptime: @Sendable () -> TimeInterval
    private let anchor: TimeInterval

    public init(uptime: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.uptime = uptime
        anchor = uptime()
    }

    public var elapsedSeconds: TimeInterval { uptime() - anchor }
}

public struct WallAndMonotonicTime: Sendable, Equatable, Codable {
    public enum Clock: Sendable, Equatable {
        case process
        case boot
    }

    public let wallRFC3339: String
    public let wallUnixSeconds: Double
    public let elapsedSeconds: Double
    public let clock: Clock

    enum CodingKeys: String, CodingKey {
        case wallRFC3339 = "wall_rfc3339"
        case wallUnixSeconds = "wall_unix_seconds"
        case elapsedSeconds = "elapsed_seconds"
        case bootUptime = "monotonic_seconds"
    }

    public init(wall: Date = AppClock.now, elapsedSeconds: Double = ProcessClock.shared.elapsedSeconds) {
        self.wallRFC3339 = CaptureTime.rfc3339(wall)
        self.wallUnixSeconds = wall.timeIntervalSince1970
        self.elapsedSeconds = elapsedSeconds
        clock = .process
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let wallRFC3339 = try values.decode(String.self, forKey: .wallRFC3339)
        let wallUnixSeconds = try values.decode(Double.self, forKey: .wallUnixSeconds)
        let clock: Clock = values.contains(.bootUptime) && !values.contains(.elapsedSeconds) ? .boot : .process
        if clock == .process, values.contains(.bootUptime) {
            throw CaptureError.invalidEntry("captured states both the process clock and the boot clock")
        }
        let elapsedSeconds = try values.decode(Double.self, forKey: clock == .boot ? .bootUptime : .elapsedSeconds)
        guard
            Self.isValid(
                wallRFC3339: wallRFC3339,
                wallUnixSeconds: wallUnixSeconds,
                elapsedSeconds: elapsedSeconds
            )
        else {
            throw CaptureError.invalidEntry("captured time is invalid or inconsistent")
        }
        self.wallRFC3339 = wallRFC3339
        self.wallUnixSeconds = wallUnixSeconds
        self.elapsedSeconds = elapsedSeconds
        self.clock = clock
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(wallRFC3339, forKey: .wallRFC3339)
        try values.encode(wallUnixSeconds, forKey: .wallUnixSeconds)
        try values.encode(elapsedSeconds, forKey: clock == .boot ? .bootUptime : .elapsedSeconds)
    }

    var isValid: Bool {
        Self.isValid(
            wallRFC3339: wallRFC3339,
            wallUnixSeconds: wallUnixSeconds,
            elapsedSeconds: elapsedSeconds
        )
    }

    private static func isValid(
        wallRFC3339: String,
        wallUnixSeconds: Double,
        elapsedSeconds: Double
    ) -> Bool {
        guard wallUnixSeconds.isFinite,
            elapsedSeconds.isFinite,
            elapsedSeconds >= 0,
            let wall = CaptureTime.date(rfc3339: wallRFC3339)
        else { return false }
        return abs(wall.timeIntervalSince1970 - wallUnixSeconds) <= 0.001
    }
}

public enum AppClock {
    static let pin = DateComponents(year: 2026, month: 11, day: 7, hour: 22, minute: 30)

    private static let offset: TimeInterval = {
        guard ProcessInfo.processInfo.arguments.contains("--ui-testing"),
              let start = Calendar(identifier: .gregorian).date(from: pin) else { return 0 }
        return start.timeIntervalSinceNow
    }()

    public static var now: Date { Date(timeIntervalSinceNow: offset) }
}
