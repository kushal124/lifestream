import Foundation

public enum UTCInstant {
    private static let lock = NSLock()
    private static let seconds: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return formatter
    }()

    public static func millisecond(_ date: Date) -> Date {
        Date(timeIntervalSince1970: (date.timeIntervalSince1970 * 1000).rounded() / 1000)
    }

    public static func rfc3339(_ date: Date) -> String {
        let total = (date.timeIntervalSince1970 * 1000).rounded()
        let whole = (total / 1000).rounded(.down)
        let fraction = Int(total - whole * 1000)
        lock.lock()
        defer { lock.unlock() }
        let head = seconds.string(from: Date(timeIntervalSince1970: whole))
        return "\(head).\(String(format: "%03d", fraction))Z"
    }

    public static func date(rfc3339 spelling: String) -> Date? {
        guard spelling.count == 24, spelling.hasSuffix("Z") else { return nil }
        let body = String(spelling.dropLast())
        let parts = body.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, parts[1].count == 3, parts[1].allSatisfy(\.isNumber),
              let fraction = Int(parts[1]) else { return nil }
        lock.lock()
        let whole = seconds.date(from: String(parts[0]))
        lock.unlock()
        guard let whole else { return nil }
        return Date(timeIntervalSince1970: whole.timeIntervalSince1970 + Double(fraction) / 1000)
    }

    public static func basic(_ date: Date) -> String {
        rfc3339(date).replacingOccurrences(of: "-", with: "").replacingOccurrences(of: ":", with: "")
    }

    public static func date(basic spelling: String) -> Date? {
        let c = Array(spelling)
        guard c.count == 20, c[8] == "T" else { return nil }
        let extended = "\(String(c[0..<4]))-\(String(c[4..<6]))-\(String(c[6..<8]))T"
            + "\(String(c[9..<11])):\(String(c[11..<13])):\(String(c[13..<20]))"
        guard let date = date(rfc3339: extended), basic(date) == spelling else { return nil }
        return date
    }
}
