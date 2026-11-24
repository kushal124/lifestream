import Foundation
import XCTest
@testable import HomeLink

final class ProofTests: XCTestCase {
    static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures")
    static let stores = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("macos-app/Tests/Fixtures/stores")

    func testTheProofReportReadsWholeAndExactly() throws {
        let bytes = try Data(contentsOf: Self.fixtures.appendingPathComponent("proof-report.json"))
        let report = try JSONDecoder().decode(HomeLink.StreamsReport.self, from: bytes)
        var drift: [String] = []
        Strict.walk(report, try JSONSerialization.jsonObject(with: bytes), at: "report", drift: &drift)
        XCTAssertEqual(drift, [], "the proof report as HomeLink reads it is the report as written")

        let ids = report.connectors.map(\.id)
        for proof in ["example-bank", "example-chat", "example-log", "example-store", "example-oauth"] {
            XCTAssertTrue(ids.contains(proof), "a row of \(proof)")
        }
        let members = report.connectors.flatMap(\.members)
        XCTAssertEqual(Set(members.compactMap(\.control)), Set(HomeLink.Connector.Member.Control.allCases), "a member of every control")
        XCTAssertTrue(members.contains { $0.control == .date && $0.kind == "date" }, "the bank's date field")
        XCTAssertTrue(members.contains { $0.where != nil }, "a member only one device may set")
        let refreshes = report.connectors.map(\.refreshNow)
        XCTAssertTrue(refreshes.contains { $0 == nil }, "a stream with no Refresh now")
        XCTAssertTrue(refreshes.contains { $0 != nil && $0?.blocked == nil }, "Refresh now that may be pressed")
        XCTAssertEqual(Set(refreshes.compactMap { $0?.blocked?.reason }), Set(HomeLink.RefreshBlocked.Reason.allCases), "Refresh now in each blocked reason")
        XCTAssertTrue(refreshes.allSatisfy { $0 == nil || ($0!.act.do == .refresh && $0!.act.of != nil) }, "each act names its connector")
        XCTAssertTrue(refreshes.contains { $0?.asked.isEmpty == false }, "a Mac asked")
        XCTAssertTrue(report.connectors.flatMap(\.copies).contains { $0.store == .asked }, "a Mac copy's store state")
        let route = try XCTUnwrap(report.connectors.flatMap(\.routes).first { $0.way == "client" })
        XCTAssertEqual(route.client?.held, false, "a client route, its client not held")
        XCTAssertTrue(report.connectors.contains { ($0.origins?.count ?? 0) > 1 }, "a site's origins")
        XCTAssertTrue(report.needs.contains { $0.id.hasPrefix("folder:") && $0.connector == nil }, "a folder that failed, on Your home's row")
        XCTAssertNotNil(report.products, "the products' digest")
    }

    func testAMacsAnswerReadsItsStoresWholeAndItsRefresh() throws {
        let bytes = try Data(contentsOf: Self.fixtures.appendingPathComponent("proof-answer.json"))
        let answer = try XCTUnwrap(Answer(body: bytes))
        let written = try XCTUnwrap(try JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        let stores = try XCTUnwrap(written["stores"] as? [String: Any])
        XCTAssertEqual(answer.stores?.keys.sorted(), stores.keys.sorted(), "every store reads")
        for (id, store) in answer.stores ?? [:] { try Self.assertRoundTrip(store, stores[id]!, id) }
        XCTAssertEqual(answer.stores?["imessage"]?.app, "Messages")
        XCTAssertEqual(answer.stores?["imessage"]?.grants, [.fullDiskAccess])
        XCTAssertEqual(answer.stores?["imessage"]?.product, "imessage")
        XCTAssertEqual(answer.refresh, ["example-store:local:macbook-pro-0001": 1_794_418_123_291], "each source's stamp, the press's instant")

        var object = written
        let declared = try XCTUnwrap(stores["example-store"] as? [String: Any])
        var store = try XCTUnwrap(declared["store"] as? [String: Any])
        var engine = try XCTUnwrap(store["engine"] as? [String: Any])
        var sqlite = try XCTUnwrap((engine["stores"] as? [[String: Any]])?.first)
        var tables = try XCTUnwrap(sqlite["tables"] as? [[String: Any]])
        tables[0]["later"] = 1
        sqlite["tables"] = tables
        engine["stores"] = [sqlite]
        store["engine"] = engine
        var bent: [(String, [String: Any])] = [("a member deep in its store", declared.merging(["store": store]) { $1 })]
        bent.append(("a member of its block", declared.merging(["later": 1]) { $1 }))
        bent.append(("a grant not known", declared.merging(["grants": ["fullDiskAccess", "later"]]) { $1 }))
        bent.append(("no grants", declared.filter { $0.key != "grants" }))
        bent.append(("no product", declared.filter { $0.key != "product" }))
        for (what, block) in bent {
            object["stores"] = ["example-store": block, "imessage": stores["imessage"]!]
            let changed = try XCTUnwrap(Answer(body: try JSONSerialization.data(withJSONObject: object)))
            XCTAssertEqual(changed.stores?.keys.sorted(), ["imessage"], "the store with \(what) does not read")
        }

        object["stores"] = nil
        object["refresh"] = nil
        let plain = try XCTUnwrap(Answer(body: try JSONSerialization.data(withJSONObject: object)))
        XCTAssertNil(plain.stores)
        XCTAssertNil(plain.refresh)
    }

    func testEveryStoreTheMacDeclaresReadsAndWritesBackAsWritten() throws {
        let files = try FileManager.default.contentsOfDirectory(at: Self.stores, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
        XCTAssertFalse(files.isEmpty, "the release's store connectors")
        for file in files {
            let written = try JSONSerialization.jsonObject(with: Data(contentsOf: file))
            let declared = try JSONDecoder().decode(HomeLink.DeclaredStore.self, from: JSONSerialization.data(withJSONObject: written))
            try Self.assertRoundTrip(declared, written, file.lastPathComponent)
        }
    }

    func testRefreshNowsActReadsAndCarriesItsConnector() throws {
        let act = try JSONDecoder().decode(HomeLink.Act.self, from: Data(#"{"do":"refresh","label":"Refresh now","of":"example-chat"}"#.utf8))
        XCTAssertEqual([act.do.rawValue, act.of], ["refresh", "example-chat"])
        XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.Act.self, from: Data(#"{"do":"refresh","label":"Refresh now"}"#.utf8)), "a refresh with no connector")
    }

    func testAHandleReadsInItsNewShapeAlone() throws {
        let handle = try JSONDecoder().decode(HomeLink.Person.Handle.self, from: Data(#"{"id":"example-chat:12345","kind":"network","network":"example-chat","words":"12345","from":"Example Chat"}"#.utf8))
        XCTAssertEqual(handle, HomeLink.Person.Handle(id: "example-chat:12345", kind: "network", network: "example-chat", words: "12345", from: "Example Chat"))
        let encoded = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            HomeLink.Person.Handle(id: "phone:+15550000001", kind: "phone", network: nil, words: "+1 555 000 0001", from: nil))) as? [String: Any])
        XCTAssertEqual(encoded.keys.sorted(), ["from", "id", "kind", "network", "own", "words"], "the kept copy says whether it is the owner's")
        XCTAssertTrue(encoded["network"] is NSNull)
    }

    static func assertRoundTrip(_ store: some Encodable, _ written: Any, _ name: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let again = try JSONSerialization.jsonObject(with: JSONEncoder().encode(store))
        XCTAssertEqual(again as? NSDictionary, written as? NSDictionary, "\(name) writes back as written", file: file, line: line)
    }
}
