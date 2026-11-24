import XCTest

@MainActor
final class DaysListUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testJourneyDaysList() throws {
        let app = launch(open: "days")
        let title = { app.inFront("day.title") }
        app.appearsInFront("day.title", "the day's head")
        app.dayDrawn("today")

        title().tap()
        let list = app.descendants(matching: .any)["days.list"].firstMatch
        list.appears("the calendar")
        let today = app.buttons["days.day.\(CannedClock.civilDay(daysBack: 0))"]
        today.appears("today's day")
        XCTAssertTrue(today.isSelected, "the day shown is selected")
        keep("calendar")
        let off = CannedClock.civilDay(daysBack: 9)
        app.bringIntoView(app.buttons["days.day.\(off)"])
        app.buttons["days.day.\(off)"].tap()
        list.vanishes("a day of the calendar opens it")
        until("the day the phone was off: \(title().label)") { title().label.contains(CannedClock.longDate(daysBack: 9)) }
        app.dayDrawn("the day the phone was off")
        app.bringIntoView(app.inFront("day.end"))
        XCTAssertFalse(app.inFront("day.map").exists, "no map on a day with no location")

        let short = app.buttons["bar.title"].firstMatch
        short.appears("at the day's end, the bar's short date")
        short.tap()
        list.appears("the short date opens the days")
        let month = app.buttons["days.month.\(off.prefix(7))"]
        month.appears("the shown day's month")
        month.tap()
        app.monthItem(CannedClock.lastMonth).tap()
        let away = app.buttons["days.day.\(CannedClock.lastMonth)-13"]
        app.bringIntoView(away)
        keep("last-month")
        away.tap()
        list.vanishes()
        until("the trip's day: \(title().label)") { title().label.contains(CannedClock.longDate(of: "\(CannedClock.lastMonth)-13")) }
        app.dayDrawn("the trip's day")
        app.bringIntoView(app.inFront("day.map"))
        keep("trip-day")

        let banded = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'day.photos.' AND label BEGINSWITH 'Video, 0:04'")).firstMatch
        app.bringIntoView(banded)
        XCTAssertTrue(banded.exists, "the band holds the video's tile")
        XCTAssertNotNil(banded.label.range(of: #"^Video, 0:04, \d\d:\d\d, photo \d+ of \d+$"#, options: .regularExpression),
                        "a band tile reads the time it was taken: \(banded.label)")
        let live = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'day.photos.' AND label BEGINSWITH 'Live Photo, '")).firstMatch
        XCTAssertTrue(live.exists, "the band's Live Photo says so, as Photos does: its atom's live")
        keep("band-video")
        banded.tap()
        app.plays(at: "3 of 4", "the band's video")
        keep("band-video-playing")
        app.buttons["Close"].firstMatch.tap()
        app.viewer.vanishes("the viewer closes")
    }
}
