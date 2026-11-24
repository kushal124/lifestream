import XCTest

@MainActor
final class UsageFlowUITests: XCTestCase {
    func testJourneyUsageSetupExplainsUnavailableExportWithoutRequestingPermission() throws {
        continueAfterFailure = false
        let app = launch(open: "streams", text: .extraLarge)
        app.rootHead("Connectors").appears()
        let row = app.scrolledTo("machinery.usage")
        XCTAssertTrue(row.exists)
        keep("connectors-usage-large-type")
        app.openMachinery("machinery.usage")
        app.descendants(matching: .any)["connector.detail"].firstMatch.appears()
        XCTAssertTrue(app.scrolledTo("usage.authorization").exists)
        XCTAssertFalse(app.buttons["usage.refresh"].exists)
        XCTAssertEqual(app.alerts.count, 0)
        XCTAssertEqual(springboard.alerts.count, 0)
        keep("usage-setup-dark-large-type")
    }
}
