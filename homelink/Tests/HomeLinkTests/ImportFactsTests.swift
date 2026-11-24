import Foundation
import XCTest
@testable import HomeLink

final class ImportFactsTests: XCTestCase {
    func testAChangeIsOneExchangeInTheShapeTheDoorReads() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("imports-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let mac = HomeLink.Device(kind: .mac, version: "1.4.0", model: "MacBook Pro", serial4: "0001")
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: mac, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: "http://127.0.0.1:4680")
        let transport = ScriptedTransport([.reply(200, Fixture.answer(received: 0, imported: 0))])
        let link = HomeLink(device: mac, credentials: credentials, folder: folder, transport: transport)
        _ = try await link.exchange()
        XCTAssertNil(try Fixture.object(transport.requests[0])["imports"], "none before any is told")

        let digest = String(repeating: "a", count: 64)
        let facts = [MacImport(kind: "spotify", files: [
            MacImport.File(id: "file-a", name: "my_spotify_data.zip", bytes: 41_000_000, state: .checking),
            MacImport.File(id: "file-b", name: "older.zip", bytes: 12, state: .sending, sha256: digest, seal: 7, pass: "pass-a",
                           sentBytes: 6),
            MacImport.File(id: "file-c", name: "photos.zip", bytes: 3, state: .refused, why: .notThisKind),
        ])]
        link.tell(imports: facts)
        await fulfillment(of: [transport.reached(2)], timeout: 30)
        let stated = try XCTUnwrap(try Fixture.object(transport.requests[1])["imports"] as? [[String: Any]], "a change is one exchange of its own")
        XCTAssertEqual(stated.count, 1)
        XCTAssertEqual(stated[0]["kind"] as? String, "spotify")
        let files = try XCTUnwrap(stated[0]["files"] as? [[String: Any]])
        XCTAssertEqual(files.map { Set($0.keys) }, [["id", "name", "bytes", "state", "why"],
                                                    ["id", "name", "bytes", "state", "why", "sha256", "seal", "pass", "sent_bytes"],
                                                    ["id", "name", "bytes", "state", "why"]],
                       "why always, null for none; the digest, the seal and its pass, and the bytes sent only once known")
        XCTAssertTrue(files[0]["why"] is NSNull)
        XCTAssertEqual(files[1]["state"] as? String, "sending")
        XCTAssertEqual(files[1]["sha256"] as? String, digest)
        XCTAssertEqual(files[1]["seal"] as? Int, 7)
        XCTAssertEqual(files[1]["pass"] as? String, "pass-a")
        XCTAssertEqual(files[1]["sent_bytes"] as? Int, 6)
        XCTAssertEqual(files[2]["why"] as? String, "not-this-kind")

        link.tell(imports: facts)
        _ = try await link.exchange()
        XCTAssertEqual(transport.requests.count, 3, "a repeat makes none")
        XCTAssertNotNil(try Fixture.object(transport.requests[2])["imports"], "an exchange made for another reason carries them")
    }
}
