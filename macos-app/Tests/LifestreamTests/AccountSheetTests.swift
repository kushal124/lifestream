import AppKit
import HomeLink
import Passwords
import Recorder
import Shipping
import SwiftUI
import XCTest
@testable import Lifestream

@MainActor final class AccountSheetTests: XCTestCase {
    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("account-sheet-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: scratch)
    }

    private func host(_ socket: HomeSocket? = nil) -> MacHost {
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        let host = MacHost(needs: NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper)),
                           lines: StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true)),
                           socket: { socket },
                           readGrants: { [:] }, readFolder: { nil }, ask: .untouched)
        host.browse = { _ in }
        return host
    }

    private func connector(_ row: [String: Any]) throws -> Connector {
        try JSONDecoder().decode(Connector.self, from: JSONSerialization.data(withJSONObject: row))
    }

    private static let gmailHelp = ["An app password, not your Google password.", "Make one at myaccount.google.com/apppasswords."]

    func testARowsFieldIsItsMembersControlAndTheHelpLinksItsAddress() throws {
        let gmail = try connector(HomeReport.connector("gmail", "Gmail", members: [
            HomeReport.member("account", "email", panel: "account", label: "Gmail address", ["placeholder": "Your Gmail address"]),
            HomeReport.member("password", "secret", panel: "account", label: "App password")]))
        XCTAssertEqual(AccountSheet.rows(gmail, gmail.routes[0]), [
            AccountSheet.Row(field: "account", label: "Gmail address", secure: false, spaces: false, placeholder: "Your Gmail address"),
            AccountSheet.Row(field: "password", label: "App password", secure: true, spaces: true, placeholder: "Required")])
        let head = RouteWords.head(gmail, gmail.routes[0])
        XCTAssertEqual([head.title, head.line, RouteWords.send(gmail)],
                       ["Connect Gmail", gmail.gives, "Connect Gmail"])

        let linked = Steps.linked(Self.gmailHelp.joined(separator: " "))
        let links = linked.runs.compactMap { run in run.link.map { ($0, String(linked[run.range].characters)) } }
        XCTAssertEqual(links.map(\.0), [URL(string: "https://myaccount.google.com/apppasswords")!])
        XCTAssertEqual(links.map(\.1), ["myaccount.google.com/apppasswords"])
        XCTAssertTrue(Steps.linked("Type the code Granola shows you.").runs.allSatisfy { $0.link == nil }, "a word became a link")
        XCTAssertEqual(String(GoTo.words(URL(string: "https://auth.example/device?code=WDJB-MJHT")!).characters), "Or go to auth.example/device",
                       "the page's link words carry its code")
    }

    func testTheRouteSheetsAreDrawn() async throws {
        let home = try ScriptedHome { request in
            switch request["verb"] as? String {
            case "account-connect": return ["result": ["refused": "Granola did not take that API key.", "field": "key"]]
            case "device-start":
                return ["result": ["code": "WDJB-MJHT", "open": "https://auth.example/device", "interval_ms": 5000,
                                   "expires_ms": 1_800_000_000_000, "attempt": ["client_id": "client-0001", "device_code": "device-code-0001"]]]
            default: return ["error": "no verb is named \(request["verb"] ?? "")"]
            }
        }
        defer { home.stop() }
        let host = host(HomeSocket(path: home.path, folder: home.folder, patience: 0.5))
        defer { host.stop() }
        let granola = try JSONDecoder().decode(Connector.self, from: JSONSerialization.data(withJSONObject: HomeReport.granola))
        let routes = granola.routes
        let device = try XCTUnwrap(routes.first { $0.way == "device" }), key = try XCTUnwrap(routes.first { $0.way == "key" })
        let size = CGSize(width: 520, height: 400)
        try await Shots.draw("sheet-route-key", size: size) { AccountSheet(host: host, connector: granola, route: key) }
        _ = await host.connectAccount("granola", route: "granola-api", values: ["account": "person-a@example.com", "key": "grn_fake0000"])?.value
        XCTAssertEqual(host.refusedField, "key")
        try await Shots.draw("sheet-route-key-refused", size: size) { AccountSheet(host: host, connector: granola, route: key) }
        _ = await host.startDevice("granola", route: "granola-mcp")?.value
        XCTAssertNotNil(host.device)
        try await Shots.draw("sheet-route-device", size: size) { DeviceSheet(host: host, connector: granola, route: device) }
    }

    func testTheClientSheetIsDrawnInEachState() async throws {
        let home = try ScriptedHome { request in
            switch request["verb"] as? String {
            case "client-start" where request["client"] == nil:
                return ["result": ["refused": "Make your Example client, then type its client ID and secret.", "field": "client_id"]]
            case "client-start":
                return ["result": ["open": "https://auth.example/authorize?state=fake-state-0001", "attempt": ["state": "fake-state-0001"],
                                   "expires_ms": 1_800_000_000_000, "listening": true]]
            case "client-finish": return ["result": ["state": "pending"]]
            default: return ["error": "no verb is named \(request["verb"] ?? "")"]
            }
        }
        defer { home.stop() }
        let host = host(HomeSocket(path: home.path, folder: home.folder, patience: 0.5))
        defer { host.stop() }
        let report = try JSONDecoder().decode(ConnectorsReport.self, from: Data(contentsOf: ProofReport.file))
        let oauth = try XCTUnwrap(report.connector("example-oauth"))
        let route = try XCTUnwrap(oauth.routes.first { $0.way == "client" })
        let client = try XCTUnwrap(route.client)
        XCTAssertFalse(client.held)
        let size = CGSize(width: 520, height: 520)
        try await Shots.draw("sheet-route-client", size: size) { ClientSheet(host: host, connector: oauth, route: route, client: client) }
        let held = try JSONDecoder().decode(Connector.Route.Client.self, from: JSONSerialization.data(withJSONObject: [
            "id": client.id, "name": client.name, "held": true, "before": client.before]))
        try await Shots.draw("sheet-route-client-held", size: size) { ClientSheet(host: host, connector: oauth, route: route, client: held) }
        _ = await host.startClient(oauth.id, route: route.id, client: nil)?.value
        XCTAssertEqual(host.refusedField, "client_id")
        try await Shots.draw("sheet-route-client-refused", size: size) { ClientSheet(host: host, connector: oauth, route: route, client: client) }
        _ = await host.startClient(oauth.id, route: route.id, client: HomeLink.ClientTyped(clientId: "client-0001", clientSecret: "fake-secret"))?.value
        XCTAssertEqual(host.client, .started(open: URL(string: "https://auth.example/authorize?state=fake-state-0001")!, listening: true))
        try await Shots.draw("sheet-route-client-started", size: size) { ClientSheet(host: host, connector: oauth, route: route, client: client) }
    }
}
