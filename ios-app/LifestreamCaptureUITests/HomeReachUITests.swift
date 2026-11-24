import XCTest

@MainActor
final class HomeReachUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testJourneyTheRoadGoesAndComesBackWithNoPress() throws {
        let app = launch("--ui-test-net", "tailscale-flips", open: "stream:gmail")
        app.descendants(matching: .any)["connector.detail"].firstMatch.appears("Gmail's page opens")
        XCTAssertTrue(app.scrolledTo("connector.setting.spam").exists, "its Settings on its one page")
        keep("01-connector-page")
        app.closeCaptureSheet()

        app.openTab("Timeline")
        firstStay(app, "the home's day")
        XCTAssertFalse(strip(app).exists, "no strip while the home answers")
        keep("02-road-up")

        app.trip()
        let strip = self.strip(app)
        strip.appears("the strip, with no read")
        XCTAssertTrue(app.inFront("day.stay.0").exists, "the day read stands under it")
        let knocked = app.asks("door")
        XCTAssertEqual(app.asks("status"), 0, "no ask made to learn whether the home answers")
        keep("03-road-gone")

        strip.tap()
        app.descendants(matching: .any)["home.check"].firstMatch.appears("the strip opens Your home's check")
        app.descendants(matching: .any)["home.check.tailscale"].firstMatch.appears("the check lists the path's links")
        XCTAssertTrue(app.buttons["home.check.retry"].exists, "the check's Try again")
        keep("04-road-gone-check")
        app.closeCaptureSheet()
        XCTAssertEqual(app.asks("door"), knocked, "nothing reached the home while it has no road, the check's read included")

        app.openStreams()
        let line = app.streamsLine
        stripInFront(app, "the strip at the Connectors sheet's head, over its line") { $0.maxY <= line.frame.minY + 1 }
        XCTAssertFalse(app.descendants(matching: .any)["needs.home.unreachable"].firstMatch.exists, "Connectors has no need of its own")
        keep("05-road-gone-streams")
        app.closeCaptureSheet()

        app.trip()
        strip.vanishes("the probe answered: the strip leaves")
        app.asks("status", reach: 1)
        app.openTab("Timeline")
        firstStay(app, "Days reads its day")
        keep("06-road-back-days")

        app.relaunch("--ui-test-home-held", open: "day:-1")
        app.buttons["day.back"].firstMatch.appears("the day is pushed")
        strip.appears("a held home's strip")
        app.appearsInFront("day.title", "the pushed day's head")
        let title = app.inFront("day.title")
        stripInFront(app, "a pushed page carries the strip, the foot of its bar") { $0.minY >= title.frame.maxY - 1 }
        keep("07-held-pushed-day")
        app.backFromDay()
        let again = app.buttons["home.strip.act"].firstMatch
        again.appears("the hold's Check again, on the strip")
        keep("08-held")
        again.tap()
        strip.vanishes("the canned door's probe answers: the hold ends and the strip leaves")
        firstStay(app, "Days reads its day with no other press")
        keep("09-held-ended")
    }

    private func strip(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["home.strip"].firstMatch
    }

    private func stripInFront(_ app: XCUIApplication, _ what: String, placed: @escaping (CGRect) -> Bool) {
        let strips = app.descendants(matching: .any).matching(identifier: "home.strip")
        let reached = { strips.allElementsBoundByIndex.filter(\.isHittable).map(\.frame) }
        until("\(what): \(reached())") { reached().contains(where: placed) }
    }

    private func firstStay(_ app: XCUIApplication, _ what: String) {
        until(what) {
            let day = app.inFront("days.day")
            return day.exists && day.value as? String == "shown"
        }
        app.bringIntoView(app.inFront("day.stay.0"))
    }
}
