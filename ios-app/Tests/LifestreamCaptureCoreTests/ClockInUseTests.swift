import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class ClockInUseTests: XCTestCase {
    private final class Stepped: @unchecked Sendable {
        private let lock = NSLock()
        private var at: Date
        private var pending: (fires: Date, then: @Sendable () -> Void)?

        init(_ at: Date) { self.at = at }

        var now: Date { lock.withLock { at } }
        var fires: Date? { lock.withLock { pending?.fires } }

        var wait: ClockInUse.Wait {
            { [self] seconds, then in
                lock.withLock { pending = (at.addingTimeInterval(seconds), then) }
                return { [self] in lock.withLock { pending = nil } }
            }
        }

        func fire() {
            let then: (@Sendable () -> Void)? = lock.withLock {
                guard let pending else { return nil }
                at = pending.fires
                self.pending = nil
                return pending.then
            }
            then?()
        }
    }

    private final class Told: @unchecked Sendable {
        private let lock = NSLock()
        private var n = 0
        var count: Int { lock.withLock { n } }
        func tell() { lock.withLock { n += 1 } }
    }

    private func instant(_ text: String) -> Date {
        ISO8601DateFormatter().date(from: text)!
    }

    private func keeper(_ kept: HomeClock?, at start: Date, zone: String = "UTC") -> (ClockInUse, Stepped) {
        let device = Stepped(start)
        let zone = TimeZone(identifier: zone)!
        return (ClockInUse(kept: kept, now: { device.now }, zone: { zone }, wait: device.wait), device)
    }

    func testAPhoneOfflineForThreeDaysTurnsTodayAtEachDaysStartOverAClockChange() throws {
        let (clock, device) = keeper(try .fixture("london-4"), at: instant("2026-10-23T12:00:00Z"))
        let told = Told()
        clock.onChange { told.tell() }
        XCTAssertEqual(clock.today(), "2026-10-23")
        var turns: [Date] = []
        for day in ["2026-10-24", "2026-10-25", "2026-10-26"] {
            turns.append(try XCTUnwrap(device.fires))
            device.fire()
            XCTAssertEqual(clock.today(), day)
        }
        XCTAssertEqual(turns, [instant("2026-10-24T03:00:00Z"), instant("2026-10-25T04:00:00Z"), instant("2026-10-26T04:00:00Z")],
                       "each at the day's start in its own offset, the long day's 25 hours included")
        XCTAssertEqual(told.count, 3, "told once a turn")
    }

    func testThePlaceholderCountsUntilTheFirstClockAndIsNeverPutOverAKeptOne() throws {
        let london = try HomeClock.fixture("london-4")
        let (fresh, _) = keeper(nil, at: instant("2026-10-14T02:00:00Z"), zone: "Asia/Kolkata")
        XCTAssertNil(fresh.clock.id, "before the home has answered")
        XCTAssertEqual(fresh.today(), "2026-10-14", "07:30 in Kolkata, past its 04:00")
        XCTAssertEqual(fresh.dayAt(Int64(1_792_000_000_000)).zone.identifier, "Asia/Kolkata", "the device's zone")
        fresh.install(london)
        XCTAssertEqual(fresh.clock.id, london.id, "the first real clock replaces it")
        fresh.install(HomeClock.placeholder(at: Date(), zone: .gmt))
        XCTAssertEqual(fresh.clock.id, london.id, "a placeholder is never installed")

        let (relaunched, _) = keeper(london, at: instant("2026-10-14T02:00:00Z"), zone: "Asia/Kolkata")
        XCTAssertEqual(relaunched.clock, london, "a kept clock counts from launch: no placeholder is made")
        XCTAssertEqual(relaunched.today(), "2026-10-13", "03:00 in London, before its day starts")
    }

    func testANewClockWithTheSameTodayStillTellsAndMovesA0500Moment() {
        let (clock, device) = keeper(.steady("UTC", startHour: 4), at: instant("2026-10-14T12:00:00Z"))
        let told = Told()
        let stop = clock.onChange { told.tell() }
        let early = instant("2026-10-14T05:00:00Z")
        XCTAssertEqual(clock.dayAt(early).day, "2026-10-14")
        clock.install(.steady("UTC", startHour: 4))
        XCTAssertEqual(told.count, 0, "the clock in use, installed again, is no change")

        clock.install(.steady("UTC", startHour: 6))
        XCTAssertEqual(clock.today(), "2026-10-14", "today's name is the same")
        XCTAssertEqual(told.count, 1, "and still told, once")
        XCTAssertEqual(clock.dayAt(early).day, "2026-10-13", "05:00 is the day before's now")
        XCTAssertEqual(device.fires, instant("2026-10-15T06:00:00Z"), "the turn set for the new clock's day end")

        stop()
        XCTAssertNil(device.fires, "no one listens: no timer")
        clock.install(.steady("UTC", startHour: 5))
        XCTAssertEqual(told.count, 1)
        XCTAssertNil(device.fires)
    }

    func testTheDayPagesTodayAndItsReadTurnWithTheHomeClockAloneAtTheDaysEndAndAtANewDayStart() {
        let (clock, device) = keeper(.steady("UTC", startHour: 4), at: instant("2026-10-14T12:00:00Z"))
        clock.onChange {}
        let drawn = DayReading.Turned(clock)
        XCTAssertEqual(drawn.today, "2026-10-14")
        device.fire()
        let turned = DayReading.Turned(clock)
        XCTAssertEqual(turned.today, "2026-10-15", "today turns at the day's end with no list read")
        XCTAssertNotEqual(turned, drawn, "so the open day reads again")
        clock.install(.steady("UTC", startHour: 6))
        let moved = DayReading.Turned(clock)
        XCTAssertEqual(moved.today, "2026-10-14", "04:00 is the day before under a 06:00 start")
        XCTAssertNotEqual(moved, turned, "a new day start reads the open day again")
        clock.install(.steady("UTC", startHour: 6))
        XCTAssertEqual(DayReading.Turned(clock), moved, "the clock in use, installed again, reads nothing again")
    }

    func testComingBackInFrontTellsOnlyWhenTodayTurnedMeanwhile() {
        let (clock, device) = keeper(.steady("UTC"), at: instant("2026-10-14T12:00:00Z"))
        let told = Told()
        clock.onChange { told.tell() }
        clock.inFront()
        XCTAssertEqual(told.count, 0, "the same day")
        device.fire()
        XCTAssertEqual(told.count, 1)
        clock.inFront()
        XCTAssertEqual(told.count, 1)
    }


    func testAStateTakenLastNeverReplacesANewerOneAndUnpairPutsThePlaceholderBack() throws {
        let (london, newYork) = (try HomeClock.fixture("london-4"), try HomeClock.fixture("new-york-4"))
        let (clock, device) = keeper(nil, at: instant("2026-10-14T12:00:00Z"), zone: "Asia/Kolkata")
        let told = Told()
        clock.onChange { told.tell() }
        let first = clock.revision
        clock.adopt(HomeLink.KeptClock(clock: london, revision: 1))
        clock.adopt(HomeLink.KeptClock(clock: newYork, revision: 2))
        clock.adopt(HomeLink.KeptClock(clock: london, revision: 1))
        XCTAssertEqual(clock.clock, newYork, "the newer state stands")
        XCTAssertEqual(told.count, 2)
        XCTAssertEqual(clock.revision, first + 2)

        clock.adopt(HomeLink.KeptClock(clock: nil, revision: 3))
        XCTAssertNil(clock.clock.id, "Unpair: the placeholder again")
        XCTAssertEqual(clock.dayAt(instant("2026-10-14T12:00:00Z")).zone.identifier, "Asia/Kolkata", "made afresh in the device's zone")
        XCTAssertEqual(told.count, 3, "and the listeners told")
        XCTAssertEqual(device.fires, instant("2026-10-14T22:30:00Z"), "the turn set for the placeholder's day end, 04:00 in Kolkata")
        clock.adopt(HomeLink.KeptClock(clock: newYork, revision: 2))
        XCTAssertNil(clock.clock.id, "a state from before Unpair, signalled after it, is left out")
        XCTAssertEqual(told.count, 3)
    }

    func testAPhoneFollowingItsLinkLetsTheClockGoAtUnpair() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("lifestream-clock-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let kept = HomeClock.steady("UTC")
        let run = kept.runs[0]
        try JSONSerialization.data(withJSONObject: ["id": kept.id ?? "", "runs": [["day": run.day, "start_ms": run.startMs, "days": run.days, "zone": "UTC"]]])
            .write(to: folder.appendingPathComponent("clock.json"))
        let link = HomeLink(device: .init(kind: .phone, version: "0.3.0", model: "iPhone", serial4: nil), credentials: MemoryCredentials(),
                            folder: folder, transport: FakeHome(clock: { Date() }))
        let (clock, device) = keeper(nil, at: instant("2026-10-14T12:00:00Z"), zone: "Asia/Kolkata")
        let told = Told()
        clock.onChange { told.tell() }
        clock.follow(link)
        XCTAssertEqual(clock.clock, kept, "the kept clock, from launch")
        XCTAssertEqual(device.fires, instant("2026-10-15T04:00:00Z"))
        let before = link.keptClock

        try link.forget()
        XCTAssertNil(clock.clock.id, "Unpair let it go, through the link's signal")
        XCTAssertEqual(told.count, 2)
        XCTAssertEqual(device.fires, instant("2026-10-14T22:30:00Z"), "the timer follows the placeholder")
        clock.adopt(before)
        XCTAssertNil(clock.clock.id, "the state read before Unpair, taken after it, is left out")
    }

    func testWorkToldByASnapshotGoesByItsClockAloneAndKnowsAnotherCame() throws {
        HomeClock.current.install(try .fixture("london-4"))
        let snapshot = HomeClock.current.snapshot
        HomeClock.current.install(try .fixture("new-york-4"))
        let at = instant("2026-10-14T12:00:00Z")
        let told = HomeClock.current.telling(by: snapshot) { (Words.clock(at), HomeClock.current.dayAt(at).zone.identifier) }
        XCTAssertEqual(told.0, "13:00", "London's, as the work began")
        XCTAssertEqual(told.1, "Europe/London")
        XCTAssertEqual(Words.clock(at), "08:00", "outside it, the clock in use: New York's")
        XCTAssertNotEqual(snapshot.revision, HomeClock.current.revision, "the work can tell another clock came")
    }


    func testSixMonthsBackClampsAtTheShorterMonthsEndAndFindsTheLeapDay() {
        XCTAssertEqual(Words.shiftMonth("2026-08-31", -6), "2026-02-28")
        XCTAssertEqual(Words.shiftMonth("2028-08-31", -6), "2028-02-29", "a leap year")
        XCTAssertEqual(Words.shiftMonth("2026-08-29", -6), "2026-02-28", "past February's end, clamped")
        XCTAssertEqual(Words.shiftMonth("2026-03-15", -6), "2025-09-15", "across a year")
        XCTAssertEqual(Words.shiftMonth("2026-12-31", -6), "2026-06-30")
    }

    func testWordsGoByTheHomesDaysAndZoneWhateverThePhonesZone() throws {
        let own = NSTimeZone.default
        defer { NSTimeZone.default = own }
        NSTimeZone.default = try XCTUnwrap(TimeZone(identifier: "Pacific/Kiritimati"))
        HomeClock.current.install(try .fixture("london-4"))
        let late = instant("2026-10-15T01:10:00Z")
        XCTAssertEqual(Words.clock(late), "02:10", "in London's zone, not the phone's")
        XCTAssertEqual(Words.rowWhen(late, now: instant("2026-10-15T02:30:00Z")), "02:10", "03:30 in London: still the 14th")
        XCTAssertEqual(Words.rowWhen(late, now: instant("2026-10-15T03:30:00Z")), "Yesterday", "04:30: the 15th")
        XCTAssertEqual(Words.rowWhen(late, now: instant("2026-10-15T03:30:00Z"), grouped: true), "02:10", "under Yesterday, its clock")
        XCTAssertEqual(Words.ago(late, now: instant("2026-10-15T02:30:00Z")), "1\(Words.nbsp)h ago")
        XCTAssertEqual(Words.ago(late, now: instant("2026-10-15T03:30:00Z")), "yesterday")
        XCTAssertEqual(Words.shortDate(late, now: instant("2026-10-20T12:00:00Z")), "Wed 14 Oct", "a date alone is the home's day")
        XCTAssertEqual(Words.stamp(late, now: instant("2026-10-20T12:00:00Z")), "Thu 15 Oct · 02:10",
                       "a date with its clock is the calendar date the clock reads on")
        XCTAssertEqual(Words.longDate(late, now: instant("2026-10-20T12:00:00Z")), "Thursday 15 October")
        XCTAssertEqual(Words.fullDate(late), "Thursday 15 October 2026", "a photo's date over its clock in the viewer's Info")
        XCTAssertEqual(Words.longDay("2026-10-14", today: "2026-10-20"), "Wednesday 14 October")
        XCTAssertEqual(Words.longDay("2025-03-14", today: "2026-10-20"), "Friday 14 March 2025")
        XCTAssertEqual(Words.month(ofDay: "2026-10-14", today: "2026-10-20"), "October")
        XCTAssertEqual(Words.month(ofDay: "2025-10-14", today: "2026-10-20"), "October 2025")
        XCTAssertEqual(Words.clock(late, zone: try XCTUnwrap(TimeZone(identifier: "Asia/Kolkata"))), "06:40", "a page of the phone's own")
    }

    func testAMadeUpTripPrintsEachDayInItsOwnZone() throws {
        HomeClock.current.install(try .fixture("trip"))
        XCTAssertEqual(Words.clock(instant("2026-01-05T12:00:00Z")), "17:30")
        XCTAssertEqual(Words.clock(instant("2026-01-15T12:00:00Z")), "12:00")
        XCTAssertEqual(Words.range(instant("2026-01-05T12:00:00Z"), instant("2026-01-15T12:00:00Z")), "17:30–12:00")
    }
}
