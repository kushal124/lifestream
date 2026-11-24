import Foundation
import HomeLink

public enum Words {
    public static let nbsp = "\u{00A0}"
    public static let dot = " · "

    public static func duration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded()))
        if total < 60 { return "\(total)s" }
        let minutes = (total + 30) / 60
        let hours = minutes / 60, rest = minutes % 60
        if hours >= 100 { return count((minutes + 30) / 60) + "h" }
        if hours == 0 { return "\(rest)m" }
        if rest == 0 { return "\(hours)h" }
        return "\(hours)h \(rest)m"
    }

    public static func span(_ seconds: TimeInterval) -> String {
        let minutes = max(0, Int((seconds / 60).rounded()))
        if minutes < 60 { return "\(max(minutes, seconds > 0 ? 1 : 0))m" }
        let hours = minutes / 60
        if hours >= 10 { return count(Int((seconds / 3_600).rounded())) + "h" }
        let rest = minutes % 60
        return rest > 0 ? "\(hours)h \(rest)m" : "\(hours)h"
    }

    public static func stay(from start: Date, to end: Date, now: Date = AppClock.now) -> (day: String, clock: String) {
        let first = day(start), today = day(now)
        let last = end > start ? day(end.addingTimeInterval(-0.001)) : first
        let length = span(end.timeIntervalSince(start))
        guard first != last else {
            return ((relativeDay(first, today: today) ?? shortDay(first, today: today)) + dot + length, range(start, end))
        }
        func weekday(_ day: String) -> String { String(weekdays[Self.weekday(ofDay: day) - 1].prefix(3)) }
        func date(_ day: String) -> String { String(Int(day.suffix(2)) ?? 0) }
        let from = [weekday(first), date(first), first.prefix(7) == last.prefix(7) ? "" : shortMonth(ofDay: first)]
        let to = [weekday(last), date(last), shortMonth(ofDay: last), last.prefix(4) == today.prefix(4) ? "" : String(last.prefix(4))]
        func joined(_ parts: [String]) -> String { parts.filter { !$0.isEmpty }.joined(separator: " ") }
        func read(_ instant: Date) -> String { clock(instant) + " " + weekday(calendarDay(instant)) }
        return (joined(from) + " – " + joined(to) + dot + length, read(start) + " – " + read(end))
    }

    public static func duration(fromMs start: Int64, toMs end: Int64) -> String {
        duration(TimeInterval(end - start) / 1000)
    }

    public static func clock(_ date: Date) -> String {
        clock(date, zone: zone(date))
    }

    public static func clock(_ date: Date, zone: TimeZone) -> String {
        let parts = calendar(zone).dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    public static func range(_ start: Date, _ end: Date) -> String {
        clock(start) + "–" + clock(end)
    }

    public static func count(_ value: Int) -> String {
        let digits = String(abs(value))
        var out = ""
        for (index, character) in digits.enumerated() {
            if index > 0, (digits.count - index) % 3 == 0 { out.append(",") }
            out.append(character)
        }
        return value < 0 ? "-" + out : out
    }

    public static func count(_ value: Int, _ noun: String, plural: String? = nil) -> String {
        count(value) + nbsp + (value == 1 ? noun : plural ?? noun + "s")
    }

    public static func appName(_ app: String) -> String {
        guard app.wholeMatch(of: /[a-z][a-z0-9-]*(?:\.[A-Za-z0-9_-]+){2,}/) != nil,
              let last = app.split(separator: ".").last else { return app }
        return last.prefix(1).uppercased() + last.dropFirst()
    }

    public static func distance(meters: Double) -> String {
        if meters < 1000 { return "\(Int((meters / 10).rounded()) * 10)\(nbsp)m" }
        let km = (meters / 100).rounded() / 10
        return (km == km.rounded() ? String(Int(km)) : String(format: "%.1f", km)) + nbsp + "km"
    }

    public static func longDate(_ date: Date, now: Date = AppClock.now) -> String {
        longDay(calendarDay(date), today: day(now))
    }

    public static func shortDate(_ date: Date, now: Date = AppClock.now, weekday: Bool = true) -> String {
        shortDay(day(date), weekday: weekday, today: day(now))
    }

    public static func shortDate(_ date: Date, zone: TimeZone, now: Date = AppClock.now, weekday: Bool = true) -> String {
        shortDay(calendarDay(date, zone: zone), weekday: weekday, today: calendarDay(now, zone: zone))
    }

    public static func stamp(_ date: Date, now: Date = AppClock.now, weekday: Bool = true) -> String {
        shortDay(calendarDay(date), weekday: weekday, today: day(now)) + dot + clock(date)
    }

    public static func month(ofDay day: String, today: String) -> String {
        let month = Int(day.dropFirst(5).prefix(2)) ?? 1
        return months[min(max(month, 1), 12) - 1] + (day.prefix(4) == today.prefix(4) ? "" : " " + day.prefix(4))
    }

    public static func ago(_ date: Date, now: Date = AppClock.now) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))\(nbsp)min ago" }
        let days = daysBetween(day(date), day(now))
        if days <= 0 { return "\(Int(seconds / 3600))\(nbsp)h ago" }
        if days == 1 { return "yesterday" }
        if days < 7 { return "\(days)\(nbsp)days ago" }
        return shortDate(date, now: now)
    }

    public static func ahead(_ date: Date, now: Date = AppClock.now) -> String {
        "in " + duration(date.timeIntervalSince(now))
    }


    public static func date(ms: Int64) -> Date {
        Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    }

    public static func shiftDay(_ day: String, _ by: Int) -> String {
        guard let noon = noon(of: day) else { return day }
        return calendarDay(noon.addingTimeInterval(TimeInterval(by) * 86_400), zone: .gmt)
    }

    public static func shiftMonth(_ day: String, _ by: Int) -> String {
        guard let noon = noon(of: day), let moved = calendar(.gmt).date(byAdding: .month, value: by, to: noon) else { return day }
        return calendarDay(moved, zone: .gmt)
    }

    public static func daysBetween(_ from: String, _ to: String) -> Int {
        guard let start = noon(of: from), let end = noon(of: to) else { return 0 }
        return Int((end.timeIntervalSince(start) / 86_400).rounded())
    }

    public static func weekday(ofDay day: String) -> Int {
        calendar(.gmt).component(.weekday, from: noon(of: day) ?? .distantPast)
    }

    public static func dayTitle(_ day: String, today: String) -> String {
        let month = Int(day.dropFirst(5).prefix(2)) ?? 1
        let named = "\(Int(day.suffix(2)) ?? 0) \(months[min(max(month, 1), 12) - 1])"
        return day.prefix(4) == today.prefix(4) ? named : named + " " + day.prefix(4)
    }

    public static func weekdayName(ofDay day: String) -> String {
        weekdays[weekday(ofDay: day) - 1]
    }

    public static func shortMonth(ofDay day: String) -> String {
        let month = Int(day.dropFirst(5).prefix(2)) ?? 1
        return String(months[min(max(month, 1), 12) - 1].prefix(3))
    }

    public static func monthYear(ofDay day: String) -> String {
        shortMonth(ofDay: day) + " " + day.prefix(4)
    }

    public static func shortDay(_ day: String, weekday: Bool = true, today: String) -> String {
        let named = [weekday ? String(weekdays[Self.weekday(ofDay: day) - 1].prefix(3)) : "",
                     String(Int(day.suffix(2)) ?? 0), shortMonth(ofDay: day),
                     day.prefix(4) == today.prefix(4) ? "" : String(day.prefix(4))]
        return named.filter { !$0.isEmpty }.joined(separator: " ")
    }

    public static func longDay(_ day: String, today: String) -> String {
        let named = weekdays[weekday(ofDay: day) - 1] + " " + dayTitle(day, today: day)
        return day.prefix(4) == today.prefix(4) ? named : named + " " + day.prefix(4)
    }

    public static func fullDate(_ date: Date) -> String {
        fullDay(calendarDay(date))
    }

    public static func fullDay(_ day: String) -> String {
        "\(weekdays[Self.weekday(ofDay: day) - 1]) \(Int(day.suffix(2)) ?? 0) \(months[(Int(day.dropFirst(5).prefix(2)) ?? 1) - 1]) \(day.prefix(4))"
    }

    public static func relativeDay(_ day: String, today: String) -> String? {
        day == today ? "Today" : day == shiftDay(today, -1) ? "Yesterday" : nil
    }


    public static func rowDay(_ day: String, today: String, clock: String = "", grouped: Bool = false) -> String {
        let back = daysBetween(day, today)
        if back == 0 { return clock.isEmpty ? "Today" : clock }
        if back == 1 { return grouped && !clock.isEmpty ? clock : "Yesterday" }
        if back > 1 && back < 7 { return weekdayName(ofDay: day) }
        return shortDay(day, weekday: false, today: today)
    }

    public static func rowWhen(_ date: Date, now: Date = AppClock.now, grouped: Bool = false) -> String {
        rowDay(day(date), today: day(now), clock: clock(date), grouped: grouped)
    }

    public static func rowWhen(_ date: Date, zone: TimeZone, now: Date = AppClock.now, grouped: Bool = false) -> String {
        rowDay(calendarDay(date, zone: zone), today: calendarDay(now, zone: zone), clock: clock(date, zone: zone),
               grouped: grouped)
    }

    public static func lineDay(_ day: String, today: String, clock: String = "") -> String {
        let back = daysBetween(day, today)
        if back == 0 { return clock.isEmpty ? "today" : clock }
        if back == 1 { return clock.isEmpty ? "yesterday" : "yesterday \(clock)" }
        if back == -1 { return clock.isEmpty ? "tomorrow" : "tomorrow \(clock)" }
        if abs(back) < 7 { return weekdayName(ofDay: day) }
        return shortDay(day, weekday: false, today: today)
    }

    public static func lineMonth(_ month: String) -> String {
        monthYear(ofDay: String(month.prefix(7)) + "-01")
    }

    public static func lineClock(_ day: String, today: String, clock: String) -> String {
        day == today ? clock : shortDay(day, weekday: false, today: today) + " " + clock
    }

    public static func phrase(_ phrase: HomeLink.Phrase, clock home: HomeClock = HomeClock.current.clock, now: Date = AppClock.now) -> String {
        phrase.parts.map { part in
            switch part {
            case .words(let words): words
            case .time(let time): lineWhen(time, clock: home, now: now)
            }
        }.joined(separator: " ")
    }

    public static func phrase(_ parts: [HomeLink.Pages.PhrasePart], clock home: HomeClock = HomeClock.current.clock, now: Date = AppClock.now) -> String {
        parts.map { part in
            switch part {
            case .words(let words): words
            case .time(let time): time.phrased.map { lineWhen($0, clock: home, now: now) } ?? ""
            case .unknown: ""
            }
        }.joined()
    }

    public static func lineWhen(_ time: HomeLink.Phrase.When, clock home: HomeClock = HomeClock.current.clock, now: Date = AppClock.now) -> String {
        let today = home.dayAt(now).day
        func timed(_ ms: Int64) -> (day: String, clock: String) {
            let day = home.dayAt(ms)
            return (day.day, clock(Date(timeIntervalSince1970: TimeInterval(ms) / 1000), zone: day.zone))
        }
        switch time {
        case .day(let day): return lineDay(day, today: today)
        case .month(let month): return lineMonth(month)
        case .at(let ms):
            let at = timed(ms)
            return lineDay(at.day, today: today, clock: at.clock)
        case .clock(let ms):
            let at = timed(ms)
            return lineClock(at.day, today: today, clock: at.clock)
        }
    }

    public static func groupWhen(_ day: String, today: String) -> String {
        let back = daysBetween(day, today)
        if back < 0 { return "Coming up" }
        if back == 0 { return "Today" }
        if back == 1 { return "Yesterday" }
        if back <= 7 { return "Previous 7 days" }
        if back <= 30 { return "Previous 30 days" }
        return day.prefix(4) == today.prefix(4) ? month(ofDay: day, today: today) : String(day.prefix(4))
    }

    public static func sectionWhen(_ key: String, today: String) -> String? {
        let digits = { (text: Substring) in text.allSatisfy { $0.isASCII && $0.isNumber } }
        if key.hasPrefix("month:") {
            let month = key.dropFirst("month:".count)
            let parts = month.split(separator: "-", omittingEmptySubsequences: false)
            guard parts.count == 2, parts[0].count == 4, parts[1].count == 2, digits(parts[0]), digits(parts[1]),
                  let number = Int(parts[1]), (1...12).contains(number) else { return nil }
            if month == today.prefix(7) { return "This month" }
            return Self.month(ofDay: String(month) + "-01", today: today)
        }
        if key.hasPrefix("year:") {
            let year = key.dropFirst("year:".count)
            return year.count == 4 && digits(year) ? String(year) : nil
        }
        return nil
    }

    public static func groupWhen(_ date: Date, zone: TimeZone, now: Date = AppClock.now) -> String {
        groupWhen(calendarDay(date, zone: zone), today: calendarDay(now, zone: zone))
    }

    public static func dateTitle(_ day: String, today: String) -> String {
        relativeDay(day, today: today) ?? longDay(day, today: today)
    }

    public static func nearDay(_ day: String, today: String) -> String {
        let back = daysBetween(day, today)
        if back == 0 { return "Today" }
        if back == 1 { return "Yesterday" }
        if back > 1 && back <= 30 { return count(back, "day") + " ago" }
        if back < 0 && back >= -30 { return "in " + count(-back, "day") }
        return rowDay(day, today: today)
    }

    public static func stampWhen(_ day: String, today: String, clock: String) -> String {
        rowDay(day, today: today) + " " + clock
    }

    private static let weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    private static let months = ["January", "February", "March", "April", "May", "June", "July", "August",
                                 "September", "October", "November", "December"]

    private static func day(_ date: Date) -> String {
        HomeClock.current.dayAt(date).day
    }

    private static func zone(_ date: Date) -> TimeZone {
        HomeClock.current.dayAt(date).zone
    }

    private static func calendarDay(_ date: Date, zone: TimeZone? = nil) -> String {
        let parts = calendar(zone ?? self.zone(date)).dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    private static func noon(of day: String) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar(.gmt).date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }

    private static func calendar(_ zone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }
}
