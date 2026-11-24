import AppKit
import HomeLink
import Passwords
import Recorder
import Shipping
import SwiftUI
import XCTest
@testable import Lifestream

enum ProofReport {
    static let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/proof-report.json")
    static let release = file.deletingLastPathComponent().appendingPathComponent("report.json")

    static func object() throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
    }
}

@MainActor final class ProofReportTests: XCTestCase {
    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("proof-report-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: scratch)
    }

    private func host(_ home: ScriptedHome?, refresh: (@Sendable (String) async throws -> HomeLink.RefreshAnswer)? = nil,
                      refreshHere: (@Sendable (String) -> Void)? = nil) -> MacHost {
        let socket = home.map { HomeSocket(path: $0.path, folder: $0.folder, patience: 0.5) }
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        let host = MacHost(needs: NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper)),
                           lines: StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true)),
                           socket: { socket },
                           readGrants: { [:] }, readFolder: { nil }, unit: { "macbook-pro-0001" }, refresh: refresh,
                           refreshHere: refreshHere, ask: .untouched)
        host.browse = { _ in }
        return host
    }

    private func refusal(_ work: () async throws -> String?) async -> String? {
        do {
            _ = try await work()
            return nil
        } catch {
            return (error as? HostRefusal)?.words ?? "not words: \(error)"
        }
    }

    func testEveryMemberIsOfferedByItsControlAlone() throws {
        let report = try JSONDecoder().decode(ConnectorsReport.self, from: Data(contentsOf: ProofReport.file))
        var controls: Set<Connector.Member.Control> = []
        for connector in report.connectors {
            for member in connector.members {
                let at = "\(connector.id).\(member.key)"
                let drawn = member.panel != nil || connector.processing?.rows.contains { $0.member == member.key || $0.privacy?.member == member.key } == true
                let setting = report.offers(.setting(connector.id, member: member.key), here: "macbook-pro-0001")
                let seal = report.offers(.seal(connector.id, member: member.key))
                guard let control = member.control else {
                    XCTAssertFalse(setting || seal, "\(at): a member with no control was offered")
                    continue
                }
                controls.insert(control)
                switch control {
                case .secret:
                    XCTAssertFalse(setting, "\(at): a secret set as a setting")
                    XCTAssertEqual(seal, drawn && !connector.routes.contains { $0.sets.contains(member.key) },
                                   "\(at): a secret sealed from the form that a route sets, or not one no route sets")
                case .path:
                    XCTAssertEqual(setting, drawn, "\(at): a path on its own Mac")
                    if let only = member.where {
                        XCTAssertEqual(only.unit, "macbook-pro-0001")
                        XCTAssertFalse(report.offers(.setting(connector.id, member: member.key), here: "macbook-air-bb07"),
                                       "\(at): a path set from a Mac the report does not name")
                        XCTAssertFalse(report.offers(.setting(connector.id, member: member.key)), "\(at): a path set from no Mac")
                    }
                    XCTAssertFalse(seal)
                case .menu, .zone, .toggle, .stepper, .list, .text, .email, .date:
                    XCTAssertEqual(setting, drawn, "\(at): \(control) offered by another rule than its panel")
                    XCTAssertFalse(seal, "\(at): sealed")
                }
            }
        }
        XCTAssertEqual(controls, Set(Connector.Member.Control.allCases), "the proof report holds a member of every control")
    }

    func testEveryRouteOpensTheSheetOfItsWayAndIsDrawn() async throws {
        let host = host(nil)
        defer { host.stop() }
        var ways: Set<String> = []
        for file in [ProofReport.file, ProofReport.release] {
            let report = try JSONDecoder().decode(ConnectorsReport.self, from: Data(contentsOf: file))
            for connector in report.connectors {
                for route in connector.routes {
                    ways.insert(route.way)
                    let sheet = try XCTUnwrap(MacHost.sheet(of: connector, route.id), "\(connector.id) \(route.id): no sheet")
                    let name = "sheet-proof-\(connector.id)-\(route.id)"
                    let size = CGSize(width: 520, height: 520)
                    switch (sheet, route.way) {
                    case (.account(let drawn, let asked), "key"):
                        XCTAssertEqual([drawn.id, asked.id], [connector.id, route.id])
                        try await Shots.draw(name, size: size) { AccountSheet(host: host, connector: drawn, route: asked) }
                    case (.device(let drawn, let asked), "device"):
                        XCTAssertEqual([drawn.id, asked.id], [connector.id, route.id])
                    case (.client(let drawn, let asked, let client), "client"):
                        XCTAssertEqual([drawn.id, asked.id, client.id], [connector.id, route.id, route.client?.id])
                        try await Shots.draw(name, size: size) { ClientSheet(host: host, connector: drawn, route: asked, client: client) }
                    default:
                        XCTFail("\(connector.id) \(route.id): a \(route.way) route opened \(sheet)")
                    }
                }
            }
        }
        XCTAssertEqual(ways, Set(HostAct.SignInWay.allCases.map(\.rawValue)), "a way the host says it draws has no route in the fixtures")
        XCTAssertNil(MacHost.sheet(of: try XCTUnwrap(try JSONDecoder().decode(ConnectorsReport.self, from: Data(contentsOf: ProofReport.file))
            .connector("example-oauth")), "example-other"), "a route the report does not declare")
    }

    func testRefreshNowIsPostedWhereTheReportOffersItReadsThisMacsCopyAndABlockedOneSaysItsWords() async throws {
        let object = try ProofReport.object()
        let home = try ScriptedHome { request in
            request["verb"] as? String == "connectors" ? ["result": object] : ["error": "no verb is named \(request["verb"] ?? "")"]
        }
        defer { home.stop() }
        let posted = Collected<String>()
        let answer = Collected<HomeLink.RefreshAnswer>()
        let ran = Collected<String>()
        let host = host(home, refresh: { connector in
            posted.append(connector)
            return answer.values.last ?? .queued
        }, refreshHere: { connector in
            ran.append(posted.values.last == connector ? connector : "\(connector) before the home answered")
        })
        defer { host.stop() }
        let report = try JSONDecoder().decode(ConnectorsReport.self, from: Data(contentsOf: ProofReport.file))
        var pressed: [String] = []
        for connector in report.connectors {
            let said = await refusal { try await host.perform(.refresh(connector: connector.id)) }
            switch connector.refreshNow {
            case nil:
                XCTAssertEqual(said, "Lifestream on this Mac doesn't offer that, so nothing was done.", "\(connector.id): no Refresh now")
            case let refresh? where refresh.blocked != nil:
                XCTAssertEqual(said, refresh.blocked?.words, "\(connector.id): a blocked row's press said other than its words")
            case .some:
                XCTAssertNil(said, connector.id)
                pressed.append(connector.id)
            }
        }
        XCTAssertFalse(pressed.isEmpty, "the proof report has a Refresh now that may be pressed")
        XCTAssertEqual(posted.values, pressed, "posted where the report offers none, or not where it does")
        XCTAssertEqual(ran.values, pressed, "this Mac's own copy was not read once the home answered")
        answer.append(try JSONDecoder().decode(HomeLink.RefreshAnswer.self, from: Data(
            #"{"state":"blocked","blocked":{"reason":"held","words":"Example Log asked to wait until 14:20","until_ms":1790000000000}}"#.utf8)))
        let blocked = await refusal { try await host.perform(.refresh(connector: pressed[0])) }
        XCTAssertEqual(blocked, "Example Log asked to wait until 14:20")
        XCTAssertEqual(ran.values, pressed, "a press the home answered blocked read this Mac's copy")
        let none = await refusal { try await self.host(home).perform(.refresh(connector: pressed[0])) }
        XCTAssertEqual(none, HostRefusal.notHere.words)
    }
}
