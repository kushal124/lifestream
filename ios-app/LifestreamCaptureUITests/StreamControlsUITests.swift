import XCTest

@MainActor
final class StreamControlsUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testRefreshNowIsSentAndTheHomeSaysWhatItDid() throws {
        let app = launch("--ui-test-proof", open: "stream:example-log")
        let row = app.descendants(matching: .any)["connector.detail.refresh"].firstMatch
        row.appears("Check now, under Settings on its one page")
        app.bringIntoView(row)
        row.tap()
        until("the home says the fetch is queued: \(row.label)") { row.label.contains("Refreshing") }
        keep("refreshing")
    }

    func testEachWayOfSigningInRunsFromItsSheet() throws {
        let proof = try ProofReport()
        let report = try HomeReport()
        let app = launch("--ui-test-proof", open: "stream:example-oauth")
        let oauth = try proof.connector("example-oauth")
        let connect = app.descendants(matching: .any)["connector.detail.connect"].firstMatch
        connect.appears("To connect")
        app.expandSheet()
        XCTAssertFalse(connect.label.contains("on your Mac"), "a sign-in is the phone's own: \(connect.label)")
        app.buttons["connector.detail.act.signin"].firstMatch.tap()
        let client = try XCTUnwrap((oauth["routes"] as? [[String: Any]])?.first?["client"] as? [String: Any])
        app.staticTexts[HomeReport.said(client, "name")].firstMatch.appears("the client's steps under its name")
        app.type("example-client", into: field(app, "signin.client.id", "Client ID"))
        app.type("example-secret", into: field(app, "signin.client.secret", "Client secret"))
        keep("client")
        let start = app.buttons["signin.start"].firstMatch
        start.tap()
        start.vanishes("the listener caught the redirect, the home signed in, the page went back")
        app.closeConnectorDetail()

        app.openMachinery("home-connector.granola", notConnected: true)
        app.expandSheet()
        app.buttons["connector.detail.act.signin"].firstMatch.tap()
        let code = app.descendants(matching: .any)["signin.code"].firstMatch
        code.appears("the code")
        keep("device")
        code.vanishes("asked after, signed in, the page went back")
        app.closeCaptureSheet()

        app.openMachinery("home-connector.gmail")
        app.expandSheet()
        let change = app.buttons["connector.detail.account.change"].firstMatch
        app.bringIntoView(change)
        change.tap()
        let gmail = try report.connector("gmail")
        app.type("person-a@example.com", into: field(app, "signin.field.account", HomeReport.said(try HomeReport.member(gmail, "account"), "label")))
        app.type("abcd efgh ijkl mnop", into: field(app, "signin.field.password", HomeReport.said(try HomeReport.member(gmail, "password"), "label")))
        keep("key")
        let send = app.buttons["signin.send"].firstMatch
        send.tap()
        send.vanishes("signed in, the page went back")
        app.closeConnectorDetail()

        app.openMachinery("home-connector.whoop")
        app.expandSheet()
        let set = app.buttons["connector.detail.state.act"].firstMatch
        app.bringIntoView(set)
        set.tap()
        let whoop = try report.connector("whoop")
        let password = field(app, "connector.setting.password", HomeReport.said(try HomeReport.member(whoop, "password"), "label"))
        app.type("example-password", into: password)
        app.buttons["connector.setting.password.save"].firstMatch.tap()
        until("sealed, the field empties") { (password.value as? String ?? "").isEmpty || password.value as? String == password.placeholderValue }
        keep("sealed")
    }

    private func field(_ app: XCUIApplication, _ identifier: String, _ label: String) -> XCUIElement {
        let types = [XCUIElement.ElementType.textField.rawValue, XCUIElement.ElementType.secureTextField.rawValue]
        return app.descendants(matching: .any).matching(NSPredicate(format: "elementType IN %@ AND (identifier == %@ OR label == %@)",
                                                                    types, identifier, label)).firstMatch
    }
}

struct ProofReport {
    let object: [String: Any]

    init() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("homelink/Tests/Fixtures/proof-report.json"))
        object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], "proof-report.json is an object")
    }

    var connectors: [[String: Any]] { object["connectors"] as? [[String: Any]] ?? [] }

    func connector(_ id: String) throws -> [String: Any] {
        try XCTUnwrap(connectors.first { $0["id"] as? String == id }, "proof-report.json has no connector \(id)")
    }
}
