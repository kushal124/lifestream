import Foundation
import HomeLink
import LifestreamCaptureCore

enum PlacesWords {
    private static let nb = Words.nbsp


    static func distance(_ metres: Double) -> String {
        if metres < 1_000 { return "\(Int(metres.rounded()))\(nb)m" }
        let km = metres / 1_000
        return (km < 100 ? String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), km) : Words.count(Int(km.rounded()))) + nb + "km"
    }


    static func line(_ row: HomeLink.Pages.PlaceRow, now: Date = AppClock.now) -> String {
        let today = HomeClock.current.dayAt(now).day
        if let spent = row.spent, spent.day == today, spent.hours > 0 { return Words.span(spent.hours * 3_600) + " today" }
        return row.when.map { when($0, now: now) } ?? row.line ?? ""
    }

    static func when(_ when: HomeLink.Pages.When, now: Date = AppClock.now) -> String {
        switch when {
        case .at(let ms), .clock(let ms): Words.rowWhen(Words.date(ms: Int64(ms)), now: now)
        case .day(let day): Words.rowDay(day, today: HomeClock.current.dayAt(now).day)
        case .month(let month): Words.monthYear(ofDay: month + "-01")
        case .unknown: ""
        }
    }

    static func date(_ when: HomeLink.Pages.When?) -> Date? {
        switch when {
        case .at(let ms)?, .clock(let ms)?: Words.date(ms: Int64(ms))
        case .day?, .month?, .unknown?, nil: nil
        }
    }

    static func year(of when: HomeLink.Pages.When) -> String? {
        switch when {
        case .at(let ms), .clock(let ms): String(HomeClock.current.dayAt(Int64(ms)).day.prefix(4))
        case .day(let day): String(day.prefix(4))
        case .month(let month): String(month.prefix(4))
        case .unknown: nil
        }
    }

    static func count(_ city: HomeLink.Pages.Places.City) -> Int {
        city.places.count + city.once.count
    }

    static func line(_ city: HomeLink.Pages.Places.City, now: Date = AppClock.now) -> String {
        Words.count(count(city), "place") + (city.when.map { Words.dot + when($0, now: now) } ?? "")
    }

    static func head(_ city: HomeLink.Pages.Places.City) -> String {
        Words.count(count(city), "place") + (city.since.flatMap(year(of:)).map { Words.dot + "since " + $0 } ?? "")
    }

    static func ask(_ ask: HomeLink.Pages.HomeAsk, now: Date = AppClock.now) -> String {
        ask.line + ", since " + when(ask.since, now: now) + "."
    }

    static func source(_ suggestion: HomeLink.Suggestion, stay: Date, now: Date = AppClock.now) -> String {
        let far = suggestion.distanceM.map(distance)
        let google = isGoogle(suggestion) ? "Google" : nil
        if suggestion.slug != nil { return "Your place" + (far.map { Words.dot + $0 } ?? "") }
        if let why = suggestion.why {
            let at = Words.date(ms: why.atMs)
            let same = HomeClock.current.dayAt(at).day == HomeClock.current.dayAt(stay).day
            return [why.product, same ? Words.clock(at) : Words.stamp(at, now: now), google].compactMap { $0 }.joined(separator: Words.dot)
        }
        return [far.map { $0 + " away" }, google].compactMap { $0 }.joined(separator: Words.dot)
    }

    static func isGoogle(_ suggestion: HomeLink.Suggestion) -> Bool {
        suggestion.slug == nil && suggestion.id?.hasPrefix("google:") == true
    }


    static func finish(took seconds: TimeInterval, cities: [String]) -> String {
        var named: [String] = []
        for city in cities where !named.contains(city) { named.append(city) }
        if named.count > 3 { named = Array(named.prefix(2)) + [Words.count(named.count - 2) + " more"] }
        let place = named.count < 2 ? named.joined() : named.dropLast().joined(separator: ", ") + " and " + named[named.count - 1]
        let time = seconds < 60 ? "In under a minute" : "In " + Words.count(Int((seconds / 60).rounded()), "minute")
        return [time, place].filter { !$0.isEmpty }.joined(separator: Words.dot)
    }

    static func line(_ page: HomeLink.Pages.Place, now: Date = AppClock.now) -> [String] {
        let city = [page.head.line].compactMap { $0 }
        if case .day(let day)? = page.head.since { return city + [Words.shortDay(day, today: HomeClock.current.dayAt(now).day)] }
        return city + (page.here ? [here] : []) + (page.partOf.map { ["Part of " + $0.name] } ?? [])
    }

    static let here = "You’re here"
    static let changed = "Not saved: this place changed elsewhere. Here it is as it stands."

    static func title(_ visit: HomeLink.Pages.PlaceVisit, now: Date = AppClock.now) -> String {
        Words.rowDay(visit.day, today: HomeClock.current.dayAt(now).day)
    }

    static func span(_ visit: HomeLink.Pages.PlaceVisit, open: Bool) -> String {
        let start = Words.date(ms: Int64(visit.startMs))
        return open ? "since " + Words.clock(start) : Words.range(start, Words.date(ms: Int64(visit.endMs)))
    }

    static func length(_ visit: HomeLink.Pages.PlaceVisit, open: Bool, now: Date = AppClock.now) -> String {
        let start = Words.date(ms: Int64(visit.startMs))
        return Words.span((open ? now : Words.date(ms: Int64(visit.endMs))).timeIntervalSince(start))
    }

    static func photo(_ photo: HomeLink.PlacePhoto, now: Date = AppClock.now) -> String {
        "Photo, " + Words.stamp(Words.date(ms: photo.atMs), now: now)
    }

    static func failure(_ failure: LifeReader.Failure, missing: String = "Lifestream holds nothing here yet.") -> String? {
        switch failure {
        case .unpaired, .reach: nil
        case .busy(let words, _, _, _): words
        case .missing: missing
        case .refused(let words), .failed(let words), .unknown(let words): "Lifestream could not answer: \(words)"
        }
    }


    static func thisYear(_ now: Date = AppClock.now) -> Int {
        Int(HomeClock.current.dayAt(now).day.prefix(4)) ?? 0
    }

    static func range(_ range: HomeLink.Pages.Year.Trip.Range) -> String {
        func dayMonth(_ day: String) -> String { "\(Int(day.suffix(2)) ?? 0) \(Words.shortMonth(ofDay: day))" }
        if range.first == range.last { return dayMonth(range.first) }
        if range.first.prefix(7) == range.last.prefix(7) { return "\(Int(range.first.suffix(2)) ?? 0)–\(dayMonth(range.last))" }
        return "\(dayMonth(range.first)) – \(dayMonth(range.last))"
    }
}

extension HomeLink.Pages.PlaceRow {
    var centre: PlaceCoordinate { PlaceCoordinate(latitude: latitude, longitude: longitude) }
    var circles: [PlaceCircle] { [PlaceCircle(centre: centre, radiusMeters: radiusM)] + also.map(\.circle) }

    func distance(to point: PlaceCoordinate) -> Double {
        circles.map { $0.centre.distance(to: point) }.min() ?? .infinity
    }
}

extension HomeLink.Pages.Circle {
    var circle: PlaceCircle { PlaceCircle(centre: PlaceCoordinate(latitude: latitude, longitude: longitude), radiusMeters: radiusM) }
}

extension HomeLink.Pages.SpotRow {
    var centre: PlaceCoordinate { PlaceCoordinate(latitude: latitude, longitude: longitude) }
    var id: String { "\(latitude),\(longitude)" }
}

extension HomeLink.Pages.HiddenRow {
    var centre: PlaceCoordinate { PlaceCoordinate(latitude: latitude, longitude: longitude) }
}

extension HomeLink.Pages.Places.City {
    var centre: PlaceCoordinate { PlaceCoordinate(latitude: point.latitude, longitude: point.longitude) }
}
