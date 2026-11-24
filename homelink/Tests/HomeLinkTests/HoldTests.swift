import Foundation
import XCTest
@testable import HomeLink

final class HoldTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-hold-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private let stamped = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil, stamp: 500)
    private let unstamped = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)
    private let home = "https://lifestream.example.ts.net"

    private static func answer(version: String = "4f2a9c1", generation: Int?, received: Int = 1) -> String {
        Fixture.answer(received: received, imported: 0).replacingOccurrences(
            of: #""version":"0.2.0""#, with: #""version":"\#(version)""# + (generation.map { #","generation":\#($0)"# } ?? ""))
    }

    private static var checkout: String { answer(version: "checkout", generation: nil) }

    private func paired(_ device: HomeLink.Device, _ transport: ScriptedTransport,
                        pairing: String = HoldTests.checkout) async throws -> (HomeLink, MemoryCredentials) {
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: device, credentials: credentials, folder: folder,
                               transport: ScriptedTransport([.reply(200, #"{"unit":"iphone-17-pro-0042","answer":"# + pairing + "}")]))
            .pair(code: "12345678", name: home)
        return (HomeLink(device: device, credentials: credentials, folder: folder, transport: transport), credentials)
    }

    private func bundle() throws -> URL {
        let file = folder.appendingPathComponent("b.zip")
        try Data("zip".utf8).write(to: file)
        return file
    }

    private func refused(_ what: String, _ ask: () async throws -> Void) async {
        do {
            try await ask()
            XCTFail("\(what) went to a home this device waits for")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .homeTooOld, what)
            XCTAssertEqual(failure.code, "HOME_TOO_OLD")
        } catch {
            XCTFail("\(what): \(error)")
        }
    }

    func testAStampedDeviceOnAnOlderHomeSendsAndReadsNothingKeepsAskingAndSendsOnceItUpdates() async throws {
        let bundle = try bundle()
        let transport = ScriptedTransport([
            .reply(200, Self.answer(generation: 499)), .reply(200, Self.answer(generation: 499)),
            .reply(200, Self.answer(generation: 500)), .reply(201, Self.answer(generation: 500, received: 2)),
        ])
        let (device, credentials) = try await paired(stamped, transport)

        await refused("the exchange's answer") { _ = try await device.exchange() }
        XCTAssertEqual(device.saved?.home.generation, 499, "saved for status, never handed back fresh")
        await refused("a bundle") { _ = try await device.send(bundle: bundle, id: "sha256:00aa", kind: .new) }
        await refused("an owner's edit") { _ = try await device.act(.places(request: "r-1", .remove(slug: "synthetic-gym-0a0b0c"))) }
        await refused("a day") { _ = try await device.day("2026-10-26") }
        await refused("Ask") { _ = try await device.ask("Where was I?", chat: "1792396847000-3fa9c2", level: nil, pick: nil) }
        await refused("a setting") { _ = try await device.setSetting(connector: "location", member: "precision", value: .string("precise"), was: nil) }
        XCTAssertEqual(transport.requests.count, 1, "only the exchange reached the home")

        let relaunched = HomeLink(device: stamped, credentials: credentials, folder: folder, transport: transport)
        await refused("a bundle after a relaunch, before any exchange") { _ = try await relaunched.send(bundle: bundle, id: "sha256:00aa", kind: .new) }
        XCTAssertEqual(transport.requests.count, 1)

        await refused("the exchange asked again of the same home") { _ = try await relaunched.exchange() }
        let fresh = try await relaunched.exchange()
        XCTAssertEqual(fresh.home.generation, 500, "the first answer from an updated home is fresh: a home of the stamp's own generation")
        let sent = try await relaunched.send(bundle: bundle, id: "sha256:00aa", kind: .new)
        XCTAssertEqual(sent.sources[Fixture.source]?.received, 2)
        XCTAssertEqual(transport.requests.map { "\($0.method) \($0.url.path)" },
                       ["POST /v1/exchange", "POST /v1/exchange", "POST /v1/exchange", "PUT /v1/bundles/sha256:00aa"])
        try Self.artifact("hold.json", transport.requests.map { ["method": $0.method, "url": $0.url.absoluteString,
                                                                 "device": $0.headers[HomeLink.deviceHeader] ?? ""] })
    }

    func testAHoldTheDiskCouldNotSaveHoldsAllTheSameAndARelaunchAsksTheExchangeFirst() async throws {
        let bundle = try bundle()
        let transport = ScriptedTransport([
            .reply(200, Self.answer(generation: 499)), .reply(200, Self.answer(generation: 500)),
            .reply(201, Self.answer(generation: 500, received: 2)),
        ])
        let (device, credentials) = try await paired(stamped, transport)
        let answerFile = folder.appendingPathComponent("answer.json")
        try FileManager.default.removeItem(at: answerFile)
        try FileManager.default.createDirectory(at: answerFile, withIntermediateDirectories: false)

        await refused("the exchange's answer") { _ = try await device.exchange() }
        XCTAssertNil(device.saved, "the disk took nothing")
        await refused("a bundle in the same process") { _ = try await device.send(bundle: bundle, id: "sha256:00aa", kind: .new) }
        XCTAssertEqual(transport.requests.count, 1)

        let relaunched = HomeLink(device: stamped, credentials: credentials, folder: folder, transport: transport)
        await refused("a bundle after a relaunch with no saved answer") { _ = try await relaunched.send(bundle: bundle, id: "sha256:00aa", kind: .new) }
        XCTAssertEqual(transport.requests.count, 1, "nothing asked before the exchange")
        _ = try await relaunched.exchange()
        let sent = try await relaunched.send(bundle: bundle, id: "sha256:00aa", kind: .new)
        XCTAssertEqual(sent.sources[Fixture.source]?.received, 2, "the updated home's answer frees it, saved or not")
        XCTAssertEqual(transport.requests.map { "\($0.method) \($0.url.path)" },
                       ["POST /v1/exchange", "POST /v1/exchange", "PUT /v1/bundles/sha256:00aa"])
    }

    func testAHomeThatStatesNoGenerationIsTooOld() async throws {
        let transport = ScriptedTransport([.reply(200, Self.answer(generation: nil))])
        let (device, _) = try await paired(stamped, transport)
        await refused("an answer with no generation") { _ = try await device.exchange() }
        await refused("a bundle") { _ = try await device.send(bundle: try self.bundle(), id: "sha256:00aa", kind: .new) }
        XCTAssertEqual(transport.requests.count, 1)
    }

    func testACheckoutHomeANewerHomeAndAnUnstampedDeviceAreNeverHeld() async throws {
        let bundle = try bundle()
        for (device, answer, why) in [
            (stamped, Self.checkout, "a checkout is never judged"),
            (stamped, Self.answer(generation: 1_000), "a newer home, numerically"),
            (unstamped, Self.answer(generation: nil), "no stamp, a home with no generation"),
            (unstamped, Self.answer(generation: 1), "no stamp, an old home"),
        ] {
            let transport = ScriptedTransport([.reply(200, answer), .reply(201, answer)])
            let (link, _) = try await paired(device, transport)
            _ = try await link.exchange()
            _ = try await link.send(bundle: bundle, id: "sha256:00aa", kind: .new)
            XCTAssertEqual(transport.requests.count, 2, why)
            try FileManager.default.removeItem(at: folder.appendingPathComponent("answer.json"))
        }
    }

    func testAnAnswerFromAnOlderHomeIsNeverFreshWhateverBringsIt() async throws {
        let bundle = try bundle()
        let transport = ScriptedTransport([
            .reply(200, Self.checkout), .reply(201, Self.answer(generation: 12)), .reply(200, Self.checkout),
            .reply(409, #"{"code":"STALE","message":"seal 5 is not the next","answer":"# + Self.answer(generation: 12) + "}"),
        ])
        let (device, _) = try await paired(stamped, transport)
        _ = try await device.exchange()
        await refused("a bundle's answer") { _ = try await device.send(bundle: bundle, id: "sha256:00aa", kind: .new) }
        _ = try await device.exchange()
        await refused("a stale's answer") { _ = try await device.send(bundle: bundle, id: "sha256:00ab", kind: .new) }
        XCTAssertEqual(transport.requests.count, 4)
    }

    func testPairingWithAnOlderHomePairsAndHolds() async throws {
        let credentials = MemoryCredentials()
        let link = HomeLink(device: stamped, credentials: credentials, folder: folder,
                            transport: ScriptedTransport([.reply(200, #"{"unit":"iphone-17-pro-0042","answer":"# + Self.answer(generation: 7) + "}")]))
        await refused("pairing's answer") { _ = try await link.pair(code: "12345678", name: self.home) }
        XCTAssertEqual(try link.name()?.absoluteString, home, "paired all the same")
        await refused("a bundle") { _ = try await link.send(bundle: try self.bundle(), id: "sha256:00aa", kind: .new) }
    }

    private static func artifact(_ name: String, _ object: Any) throws {
        let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".build/e2e", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appendingPathComponent(name))
    }
}
