import XCTest

enum CannedClock {
    static func civilDay(daysBack: Int) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: day(daysBack))
    }

    static func longDate(daysBack: Int) -> String {
        longDate(of: civilDay(daysBack: daysBack))
    }

    static func longDate(of civil: String) -> String {
        let parse = DateFormatter()
        parse.locale = Locale(identifier: "en_US_POSIX")
        parse.dateFormat = "yyyy-MM-dd"
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEEE d MMMM"
        return parse.date(from: civil).map(formatter.string) ?? civil
    }

    static var lastMonth: String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM"
        return formatter.string(from: Calendar(identifier: .gregorian).date(byAdding: .month, value: -1, to: TestClock.now) ?? TestClock.now)
    }

    static var elsewhere: TimeZone {
        let honolulu = TimeZone(identifier: "Pacific/Honolulu")!
        return TimeZone.current.secondsFromGMT() == honolulu.secondsFromGMT() ? TimeZone(identifier: "Asia/Tokyo")! : honolulu
    }

    static func dayStart(daysBack: Int, in zone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        var parts = calendar.dateComponents([.year, .month, .day], from: day(daysBack))
        parts.hour = 4
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "HH:mm"
        return calendar.date(from: parts).map(formatter.string) ?? ""
    }

    static func day(_ back: Int) -> Date {
        let shifted = TestClock.now.addingTimeInterval(-4 * 3600)
        return Calendar(identifier: .gregorian).date(byAdding: .day, value: -back, to: shifted) ?? shifted
    }
}

extension XCUIApplication {
    func yesterdayBeside() {
        let day = CannedClock.civilDay(daysBack: 1)
        let laid = descendants(matching: .any)["ui-test.loop.\(day)"].firstMatch
        laid.appears("yesterday laid beside today")
        until("yesterday's page read beside today: \(laid.label)") {
            let read = self.descendants(matching: .any)["ui-test.loop.\(day)#\(laid.label)"].firstMatch
            return read.exists && read.label == "ended"
        }
    }

    func dayDrawn(_ what: String) {
        until("\(what) drawn") {
            let day = inFront("days.day")
            return day.exists && day.value as? String == "shown"
        }
    }
}
