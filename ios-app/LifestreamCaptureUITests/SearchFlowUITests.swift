import XCTest

@MainActor
final class SearchFlowUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testJourneyTheWordsBringTopHitsThenEachKindAndAKindShowsAll() throws {
        let app = launch()
        app.buttons["search.open"].firstMatch.tap()
        let field = app.searchTabField
        field.appears()
        app.descendants(matching: .any)["search.goto.person.person:person-a"].firstMatch.appears("the people most in touch wait before typing")
        keep("before-typing")

        app.type("synthetic", into: field)
        app.descendants(matching: .any)["search.top"].firstMatch.appears("1: top hits first")
        let first = app.descendants(matching: .any)["search.hit.0"].firstMatch
        first.appears("1: a hit in its own shape")
        let kinds = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'search.section.'"))
        until("2: then each kind with its count (\(kinds.count))") { kinds.count >= 2 }
        XCTAssertFalse(app.buttons["search.order"].exists, "3: no sort")
        XCTAssertTrue(app.buttons["search.when"].exists, "4: Any time in place of the month chart")
        keep("results")

        let mail = app.buttons.matching(NSPredicate(format: "label MATCHES %@", "Mail, (at least )?[0-9,]+")).firstMatch
        mail.appears("3: a text chip a kind, with its count")
        mail.tap()
        let all = app.descendants(matching: .any)["search.all"].firstMatch
        all.appears("2: the kind's chip shows all of it")
        until("2: every row of mail: \(first.label)") { first.label.hasPrefix("Mail, ") }
        keep("see-all")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "All, ")).firstMatch.tap()
        all.vanishes("All goes back")
        app.descendants(matching: .any)["search.top"].firstMatch.appears()
    }

    func testJourneyAMessageOpensItsChatAtTheHitBackKeepsTheResultsAndAPhotoOpensItself() throws {
        let app = launch(open: "search:booked")
        let hit = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'search.hit.' AND label CONTAINS[c] 'booked'")).firstMatch
        hit.appears("the words bring a message")
        let identifier = hit.identifier
        hit.tap()
        app.descendants(matching: .any)["inspector"].firstMatch.appears("6: the chat, opened at the hit")
        keep("message")
        app.navigationBars.buttons.firstMatch.tap()
        app.descendants(matching: .any)[identifier].firstMatch.appears("back on the results, as they were")

        app.openHit("noodles")
        app.viewer.appears("6: a photo opens in the viewer, at it")
        keep("photo")
    }

    func testJourneyATrackOpensItsPageOfPlays() throws {
        let app = launch(open: "search:Synthetic Show")
        let track = app.descendants(matching: .any)["search.track.0"].firstMatch
        track.appears("1: a play is its track, with its count")
        XCTAssertTrue(track.label.contains("play"), track.label)
        track.tap()
        app.descendants(matching: .any)["listening.track"].firstMatch.appears("6: the track's page")
        keep("track")
        app.navigationBars.buttons.firstMatch.tap()
        track.appears()
    }

    func testJourneyASittingOpensItsWindowsAndItsDay() throws {
        let app = launch(open: "search:synthetic weather")
        let sitting = app.descendants(matching: .any)["search.sitting.0"].firstMatch
        sitting.appears("1: the screen as sittings")
        sitting.tap()
        app.descendants(matching: .any)["search.sitting.window.0"].firstMatch.appears("6: its matched windows")
        keep("sitting")
        let day = app.buttons["search.sitting.day"].firstMatch
        app.bringIntoView(day)
        day.tap()
        app.descendants(matching: .any)["days.day"].firstMatch.appears("6: and its day")
    }
}
