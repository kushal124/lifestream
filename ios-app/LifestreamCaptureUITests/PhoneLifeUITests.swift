import XCTest

@MainActor
final class PhoneLifeUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testJourneyAFirstRunReachesDaysWithNoHomeAndNothingStarted() throws {
        let app = launch("--ui-test-unpaired", opens: .firstRun)
        XCTAssertTrue(app.descendants(matching: .any)["start.privacy"].exists)
        XCTAssertFalse(app.textFields.firstMatch.exists, "the first run asks for no serial")
        keep("first-run")
        app.passFirstRun(allowingLocation: false)
        app.buttons["streams.open"].appears("Streams ends the top bar")

        app.openMachinery("machinery.status")
        app.navigationBars["Status"].appears()
        XCTAssertTrue(app.descendants(matching: .any)["status.operational-state"].firstMatch.exists)
        app.bringIntoView(app.descendants(matching: .any)["status.health-authorization"].firstMatch)
        app.scrolledTo("status.details").tap()
        for detail in ["status.service-requested", "status.platform-evidence", "status.last-fix-age", "status.battery"] {
            app.descendants(matching: .any)[detail].firstMatch.appears("\(detail) under Details")
        }

        app.relaunch("--ui-test-unpaired", "--ui-test-export-fails")
        app.tab("Chat").appears()
        XCTAssertFalse(app.buttons["firstrun.setup"].exists)
        app.openMachinery("machinery.home")
        app.buttons["home.pair"].appears()
        app.buttons["export.build"].tap()
        let failed = app.descendants(matching: .any)["export.failed"].firstMatch
        failed.appears("the export's failure under its row")
        XCTAssertTrue(failed.isHittable, "inside Your home, not under its sheet")
        failed.buttons.firstMatch.tap()
        app.descendants(matching: .any)["export.share"].firstMatch.appears("the copy is built with no home")
        keep("home-unpaired-export")

        app.openMachinery("machinery.experiments")
        app.navigationBars["Experiments"].appears()
        app.buttons["experiments.marker.e4_movement_start"].appears()
        XCTAssertTrue(app.buttons["experiments.crash"].exists)
        app.scrolledTo("experiments.first-run").tap()
        app.buttons["firstrun.setup"].appears("the first run opens again at Welcome")
        app.buttons["firstrun.setup"].tap()
        app.buttons["pairing.later"].appears("unpaired, Pair is asked again")
    }

    func testAPhonePairedWithNoAppleIDAddsItInYourHome() throws {
        let app = launch(open: "yourhome")
        let field = app.textFields["Apple ID"]
        field.appears("no Apple ID stated: the field to add it")
        XCTAssertTrue(app.staticTexts["apple-id.waits"].exists)
        let add = app.buttons["home.account.add"]
        XCTAssertFalse(add.exists, "nothing typed, nothing to add: no Add")
        app.drag(up: true)
        app.type("person-a@example.com", into: field)
        add.appears("something typed: Add, there to press")
        add.tap()
        app.descendants(matching: .any)["home.account.message"].firstMatch.appears("the canned home takes no edit, and says so")
        XCTAssertTrue(field.exists, "not stated: the field stays")
        keep("home-add-apple-id")
    }
}
