import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class PlaceReachTests: XCTestCase {

    func testTheLadderStepsFrom20MetresTo2Kilometres() {
        let ladder = PlaceReach.ladder
        XCTAssertEqual(ladder.first, 20)
        XCTAssertEqual(ladder.last, 2_000)
        XCTAssertEqual(ladder, ladder.sorted(), "in order, so a step is one notch")
        XCTAssertEqual(Set(ladder).count, ladder.count, "no size twice")
        for (smaller, larger) in zip(ladder, ladder.dropFirst()) {
            XCTAssertEqual(larger - smaller, smaller < 100 ? 5 : smaller < 500 ? 10 : 50, "the notch above \(smaller) m")
        }
        XCTAssertTrue([20, 95, 100, 110, 490, 500, 550, 1_950].allSatisfy(ladder.contains))
        XCTAssertEqual(ladder.count, 87)
    }

    func testTheLadderRuleIsTheWebs() {
        let table: [(reach: Double, snap: Double, up: Double, back: Double)] = [
            (20, 20, 25, 20), (83, 85, 85, 80), (100, 100, 110, 100), (105, 110, 110, 100), (500, 500, 550, 500),
            (525, 550, 550, 500), (2_000, 2_000, 2_000, 1_950), (1_999, 2_000, 2_000, 1_950),
        ]
        for row in table {
            XCTAssertEqual(PlaceReach.snap(row.reach), row.snap, "snap \(row.reach)")
            XCTAssertEqual(PlaceReach.notch(row.reach, 1), row.up, "a notch up from \(row.reach)")
            XCTAssertEqual(PlaceReach.notch(row.up, -1), row.back, "back down from \(row.up)")
        }
        XCTAssertEqual(PlaceReach.notch(83, -1), 80)
        XCTAssertEqual(PlaceReach.notch(100, -1), 95)
        XCTAssertEqual(PlaceReach.notch(500, -1), 490)
        XCTAssertEqual(PlaceReach.notch(20, -1), 20, "a limit holds")
        XCTAssertEqual(PlaceReach.notch(1_990, 1), 2_000)
        for (smaller, larger) in zip(PlaceReach.ladder, PlaceReach.ladder.dropFirst()) {
            XCTAssertEqual(PlaceReach.notch(smaller, 1), larger)
            XCTAssertEqual(PlaceReach.notch(larger, -1), smaller)
        }
    }


    func testADragSnapsToTheNearestNotchWithinTheLimits() {
        XCTAssertEqual(PlaceReach.snap(82.4), 80)
        XCTAssertEqual(PlaceReach.snap(82.5), 85, "of two equally near, the larger")
        XCTAssertEqual(PlaceReach.snap(98), 100)
        XCTAssertEqual(PlaceReach.snap(104), 100)
        XCTAssertEqual(PlaceReach.snap(97.5), 100)
        XCTAssertEqual(PlaceReach.snap(106), 110)
        XCTAssertEqual(PlaceReach.snap(497), 500)
        XCTAssertEqual(PlaceReach.snap(520), 500)
        XCTAssertEqual(PlaceReach.snap(1_240), 1_250)
        XCTAssertEqual(PlaceReach.snap(3), 20, "the smallest circle the home keeps")
        XCTAssertEqual(PlaceReach.snap(-40), 20)
        XCTAssertEqual(PlaceReach.snap(9_000), 2_000, "the largest")
        XCTAssertEqual(PlaceReach.snap(.infinity), 20)
        XCTAssertEqual(PlaceReach.snap(.nan), 20)
        XCTAssertTrue(stride(from: 0.0, through: 2_500, by: 7.3).allSatisfy { PlaceReach.ladder.contains(PlaceReach.snap($0)) })
    }


    func testTheRingTicksEvery50MetresTo500AndEvery250Above() {
        XCTAssertEqual(PlaceReach.marks, [50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 750, 1_000, 1_250, 1_500, 1_750, 2_000])
        XCTAssertTrue(PlaceReach.ticks(from: 95, to: 100), "landing on a mark")
        XCTAssertFalse(PlaceReach.ticks(from: 100, to: 95), "leaving one")
        XCTAssertFalse(PlaceReach.ticks(from: 85, to: 90))
        XCTAssertTrue(PlaceReach.ticks(from: 120, to: 95), "a fast drag passing one")
        XCTAssertTrue(PlaceReach.ticks(from: 700, to: 800))
        XCTAssertFalse(PlaceReach.ticks(from: 550, to: 600), "no mark between 500 and 750 but those")
        XCTAssertFalse(PlaceReach.ticks(from: 100, to: 100), "nothing changed")
    }


    func testASizeInWords() {
        let nb = Words.nbsp
        XCTAssertEqual(PlaceReach.words(85), "85\(nb)m")
        XCTAssertEqual(PlaceReach.words(990), "990\(nb)m")
        XCTAssertEqual(PlaceReach.words(1_000), "1\(nb)km")
        XCTAssertEqual(PlaceReach.words(1_250), "1.25\(nb)km")
        XCTAssertEqual(PlaceReach.words(1_500), "1.5\(nb)km")
        XCTAssertEqual(PlaceReach.words(2_000), "2\(nb)km")
    }


    private let centre = PlaceCoordinate(latitude: 37.3187, longitude: -122.0090)

    private func north(_ metres: Double) -> PlaceCoordinate {
        PlaceCoordinate(latitude: centre.latitude + metres / 111_195, longitude: centre.longitude)
    }

    private struct TakesIn: Decodable {
        struct Circle: Decodable {
            let slug: String
            let latitude: Double
            let longitude: Double
            let radius_m: Double

            var keyed: KeyedCircle {
                KeyedCircle(slug: slug, circle: PlaceCircle(centre: PlaceCoordinate(latitude: latitude, longitude: longitude), radiusMeters: radius_m))
            }
        }

        struct Point: Decodable {
            let latitude: Double
            let longitude: Double
            let count: Int
        }

        struct Case: Decodable {
            let about: String
            let circle: Circle
            let others: [Circle]
            let points: [Point]
            let takes_in: Int
        }

        let cases: [Case]
    }

    func testWhatACircleTakesInIsTheHomesRuleCaseByCase() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/rules/takes-in.json")
        let fixture = try JSONDecoder().decode(TakesIn.self, from: Data(contentsOf: file))
        XCTAssertFalse(fixture.cases.isEmpty)
        for each in fixture.cases {
            let points = each.points.map { StayPoint(centre: PlaceCoordinate(latitude: $0.latitude, longitude: $0.longitude), count: $0.count) }
            XCTAssertEqual(PlaceTakes.takesIn(each.circle.keyed, others: each.others.map(\.keyed), points: points), each.takes_in, each.about)
        }
    }

    private func keyed(_ slug: String, _ at: PlaceCoordinate, radius: Double) -> KeyedCircle {
        KeyedCircle(slug: slug, circle: PlaceCircle(centre: at, radiusMeters: radius))
    }

    func testTheSmallestCircleHoldingAPointWinsIt() {
        let small = keyed("cafe", north(50), radius: 60), wide = keyed("home", centre, radius: 400)
        XCTAssertEqual(PlaceTakes.winning(north(60), among: [wide, small])?.slug, "cafe")
        XCTAssertEqual(PlaceTakes.winning(north(-100), among: [wide, small])?.slug, "home")
        XCTAssertNil(PlaceTakes.winning(north(500), among: [wide, small]))
        XCTAssertEqual(PlaceTakes.takesIn(wide, others: [small], points: [StayPoint(centre: north(60), count: 4), StayPoint(centre: north(-100), count: 2)]), 2,
                       "a point the smaller circle wins is not the wider one's")
    }

    func testOverlapsAreNamedNearestFirst() {
        let names = ["bakery": "Bakery", "library": "Library", "gym": "Gym"]
        let others = [keyed("library", north(400), radius: 100), keyed("bakery", north(150), radius: 100), keyed("gym", north(-185), radius: 100)]
        let overlaps = { (radius: Double) in PlaceTake.overlapping(PlaceCircle(centre: self.centre, radiusMeters: radius), others: others).compactMap { names[$0] } }
        XCTAssertEqual(overlaps(80), ["Bakery"], "the gym's circle stands just clear of this one")
        XCTAssertEqual(PlaceTake(stays: 0, overlaps: overlaps(80)).words(unread: nil), "Takes in no stays · overlaps Bakery")
        XCTAssertEqual(overlaps(400), ["Bakery", "Gym", "Library"])
        XCTAssertEqual(PlaceTake(stays: 0, overlaps: overlaps(400)).words(unread: nil), "Takes in no stays · overlaps Bakery and 2 more")
        XCTAssertEqual(PlaceTake(stays: 0, overlaps: overlaps(120)).words(unread: nil), "Takes in no stays · overlaps Bakery and Gym")
        XCTAssertEqual(PlaceTake(stays: 3, overlaps: []).words(unread: nil), "Takes in 3\(Words.nbsp)stays")
        XCTAssertEqual(PlaceTake(stays: nil, overlaps: []).words(unread: "Stays not read yet"), "Stays not read yet", "no count made up")
    }


    private let zone = TimeZone(identifier: "UTC")!

    private func at(_ text: String) -> Date {
        let format = ISO8601DateFormatter()
        format.timeZone = zone
        return format.date(from: text)!
    }

    func testAStayIsItsDayAndLengthOverItsClockNeverAPartOfDay() {
        HomeClock.current.install(.steady("UTC"))
        let now = at("2026-10-24T18:00:00Z")
        let lunch = Words.stay(from: at("2026-10-22T12:20:00Z"), to: at("2026-10-22T13:17:00Z"), now: now)
        XCTAssertEqual(lunch.day, "Thu 22 Oct · 57m")
        XCTAssertEqual(lunch.clock, "12:20–13:17")
        let words = [lunch.day, lunch.clock].joined(separator: " ")
        for guess in ["lunch", "dinner", "breakfast", "morning", "afternoon", "evening", "night"] {
            XCTAssertFalse(words.lowercased().contains(guess), "no \(guess)")
        }
        XCTAssertEqual(Words.stay(from: at("2026-10-24T08:00:00Z"), to: at("2026-10-24T09:48:00Z"), now: now).day,
                       "Today · 1h 48m")
        XCTAssertEqual(Words.stay(from: at("2026-10-23T19:00:00Z"), to: at("2026-10-23T21:00:00Z"), now: now).day,
                       "Yesterday · 2h")
        XCTAssertEqual(Words.stay(from: at("2025-03-03T18:40:00Z"), to: at("2025-03-03T20:50:00Z"), now: now).day,
                       "Mon 3 Mar 2025 · 2h 10m")
        XCTAssertEqual(Words.stay(from: at("2026-10-22T23:00:00Z"), to: at("2026-10-23T00:00:00Z"), now: now).day,
                       "Thu 22 Oct · 1h", "ending at midnight, it ends on its own day")
    }

    func testDaysAreTheHomesCountedOnTheCalendar() throws {
        HomeClock.current.install(try .fixture("new-york-4"))
        let start = at("2026-03-08T08:30:00Z"), end = at("2026-03-08T09:30:00Z")
        XCTAssertEqual(Words.stay(from: start, to: end, now: at("2026-03-08T20:00:00Z")).day, "Today · 1h")
        XCTAssertEqual(Words.stay(from: start, to: end, now: at("2026-03-09T13:00:00Z")).day, "Yesterday · 1h")
        XCTAssertEqual(Words.stay(from: start, to: end, now: at("2026-03-08T20:00:00Z")).clock, "04:30–05:30")
        HomeClock.current.install(.steady("UTC"))
        XCTAssertEqual(Words.stay(from: at("2026-10-24T00:30:00Z"), to: at("2026-10-24T01:00:00Z"), now: at("2026-10-24T18:00:00Z")).day,
                       "Yesterday · 30m", "half past midnight is the day before's, its day counted from the day start")
    }

    func testAStayOverSeveralDaysSaysItsDates() {
        HomeClock.current.install(.steady("UTC"))
        let now = at("2026-10-24T18:00:00Z")
        let long = Words.stay(from: at("2026-10-22T12:20:00Z"), to: at("2026-10-24T09:05:00Z"), now: now)
        XCTAssertEqual(long.day, "Thu 22 – Sat 24 Oct · 45h")
        XCTAssertEqual(long.clock, "12:20 Thu – 09:05 Sat")
        let weekend = Words.stay(from: at("2026-10-17T16:00:00Z"), to: at("2026-10-19T09:05:00Z"), now: now)
        XCTAssertEqual(weekend.day, "Sat 17 – Mon 19 Oct · 41h")
        XCTAssertEqual(weekend.clock, "16:00 Sat – 09:05 Mon")
        let toMidnight = Words.stay(from: at("2026-10-22T12:20:00Z"), to: at("2026-10-24T00:00:00Z"), now: now)
        XCTAssertEqual(toMidnight.day, "Thu 22 – Fri 23 Oct · 36h", "its days end on the Friday")
        XCTAssertEqual(toMidnight.clock, "12:20 Thu – 00:00 Sat", "its clock end on its own weekday")
        XCTAssertEqual(Words.stay(from: at("2026-09-30T22:00:00Z"), to: at("2026-10-01T07:00:00Z"), now: now).day,
                       "Wed 30 Sep – Thu 1 Oct · 9h", "the month said where it changes")
        XCTAssertEqual(Words.stay(from: at("2025-12-31T20:00:00Z"), to: at("2026-01-01T10:00:00Z"), now: now).day,
                       "Wed 31 Dec – Thu 1 Jan · 14h", "ending this year, no year")
        XCTAssertEqual(Words.stay(from: at("2025-09-30T20:00:00Z"), to: at("2025-10-02T08:00:00Z"), now: now).day,
                       "Tue 30 Sep – Thu 2 Oct 2025 · 36h", "another year's, its year once, on the last day")
        XCTAssertEqual(Words.stay(from: at("2025-06-01T20:00:00Z"), to: at("2025-06-02T08:00:00Z"), now: now).day,
                       "Sun 1 – Mon 2 Jun 2025 · 12h")
    }


    private func at(north: Double, east: Double) -> PlaceCoordinate {
        PlaceCoordinate(latitude: centre.latitude + north / 111_320,
                        longitude: centre.longitude + east / (111_320 * cos(centre.latitude * .pi / 180)))
    }

    private func beside(_ circles: [PlaceCircle], anchor: Int, spots: [PlaceCoordinate] = []) -> PlaceCircle {
        PlaceTakes.beside(circles, anchor: anchor, points: spots)
    }

    func testANewCircleGoesOnTheNearestFreeSpotNearTheAnchor() {
        let first = PlaceCircle(centre: centre, radiusMeters: 300), anchor = PlaceCircle(centre: at(north: 0, east: 2_000), radiusMeters: 40)
        let held = at(north: 0, east: 2_100), near = at(north: 0, east: 2_400), farther = at(north: 300, east: 2_300)
        let circles = [first, anchor, PlaceCircle(centre: held, radiusMeters: 30)]
        let added = beside(circles, anchor: 1, spots: [at(north: 0, east: 200), farther, held, near, at(north: 0, east: 2_510)])
        XCTAssertEqual(added.centre.distance(to: near), 0, accuracy: 0.01,
                       "the nearest spot no circle holds within 500 m of the anchor, not of the first")
        XCTAssertEqual(added.radiusMeters, 40, "the anchor's reach")
        XCTAssertEqual(beside(circles, anchor: 1, spots: [at(north: 0, east: 2_510)]).centre.distance(to: anchor.centre), 80, accuracy: 0.5,
                       "a spot past 500 m is passed over: beside the anchor instead")
    }

    func testANewCircleTouchesTheAnchorAtTheFirstFreeCompassPointFromEastTurningNorth() {
        let anchor = PlaceCircle(centre: centre, radiusMeters: 60)
        let east = beside([anchor], anchor: 0)
        XCTAssertEqual(east.radiusMeters, 60)
        XCTAssertEqual(east.centre.distance(to: at(north: 0, east: 120)), 0, accuracy: 0.01, "east, touching it: the two reaches apart")

        let takenEast = PlaceCircle(centre: at(north: 0, east: 130), radiusMeters: 30)
        let side = 120 / 2.squareRoot()
        XCTAssertEqual(beside([anchor, takenEast], anchor: 0).centre.distance(to: at(north: side, east: side)), 0, accuracy: 0.01)
        let takenNorthEast = PlaceCircle(centre: at(north: 90, east: 90), radiusMeters: 30)
        XCTAssertEqual(beside([anchor, takenEast, takenNorthEast], anchor: 0).centre.distance(to: at(north: 120, east: 0)), 0, accuracy: 0.01)

        let wide = PlaceCircle(centre: centre, radiusMeters: 1_000)
        XCTAssertEqual(beside([anchor, wide], anchor: 0).centre.distance(to: at(north: 0, east: 120)), 0, accuracy: 0.01)
    }

    func testANewCircleIsAtMost200MetresAndStaysOnTheEarth() {
        let wide = beside([PlaceCircle(centre: centre, radiusMeters: 2_000)], anchor: 0)
        XCTAssertEqual(wide.radiusMeters, 200, "a corner is small")
        XCTAssertEqual(wide.centre.distance(to: at(north: 0, east: 2_200)), 0, accuracy: 0.01)

        let dateLine = PlaceCoordinate(latitude: 10, longitude: 179.9995)
        let across = beside([PlaceCircle(centre: dateLine, radiusMeters: 100)], anchor: 0).centre
        XCTAssertLessThan(across.longitude, -179.99, "across the date line, wrapped: \(across.longitude)")
        XCTAssertEqual(across.distance(to: dateLine), 200, accuracy: 0.5)

        let top = PlaceCoordinate(latitude: 84.9999, longitude: 0)
        let takenEast = PlaceCircle(centre: PlaceCoordinate(latitude: 84.9999, longitude: 200 / (111_320 * cos(84.9999 * .pi / 180))),
                                    radiusMeters: 30)
        XCTAssertEqual(beside([PlaceCircle(centre: top, radiusMeters: 100), takenEast], anchor: 0).centre.latitude, 85, "never past 85°")
    }
}

extension HomeLink.Spot {
    static func at(_ centre: PlaceCoordinate, stays: Int = 0, key: String? = nil) -> Self {
        let stated: [String: Any] = ["latitude": centre.latitude, "longitude": centre.longitude, "stays": stays, "key": key ?? NSNull()]
        return try! HomeLink.Places.spots(in: JSONSerialization.data(withJSONObject: ["spots": [stated]]))[0]
    }
}
