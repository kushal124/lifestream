import Audio
import DeviceFiles
import Evidence
import Foundation
import HomeLink
import XCTest
@testable import Shipping

final class AudioDomainTests: XCTestCase {
    private var root: URL!
    private var folder: URL!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("audio-domain-tests")
        folder = root.appendingPathComponent(AudioSpool.directoryName, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private static let source = "audio:local:unit-0001"
    private static let older = "20260913T100000.000Z.mic"
    private static let newer = "20260922T100000.000Z.sound"
    private var work: URL { root.appendingPathComponent("work", isDirectory: true) }
    private var ledgers: Ledgers { Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)) }

    private func domain(now: String = "2026-09-23T04:30:00.000Z") throws -> AudioDomain {
        let date = try DomainFixtures.instant(now)
        return AudioDomain(sourceId: Self.source, root: folder, ledgers: ledgers, clock: { date })
    }

    private func carried(_ sealed: SealedBundle) throws -> [String] {
        try DomainFixtures.entry(SpoolEntry.self, of: sealed, ledgers: ledgers).items
    }

    private func following(_ seal: Int) -> SealCustody {
        SealCustody(pass: ShippingFixture.pass, received: seal, imported: 0)
    }

    private func record(_ stem: String, seconds: Int = 60) throws {
        let audio = "synthetic audio \(stem)"
        try DomainFixtures.write(audio, to: folder.appendingPathComponent("\(stem).m4a"))
        let at = UTCInstant.rfc3339(AudioSpool.instant(ofStem: stem)!)
        let until = UTCInstant.rfc3339(AudioSpool.instant(ofStem: stem)!.addingTimeInterval(Double(seconds)))
        let sidecar = "{\"at\":\"\(at)\",\"audio\":{\"bit_rate\":32000,\"bytes\":\(Data(audio.utf8).count),"
            + "\"channels\":1,\"codec\":\"aac\",\"duration_ms\":\(seconds * 1000),\"file\":\"\(stem).m4a\","
            + "\"media_type\":\"audio/mp4\",\"sample_rate\":16000,\"sha256\":\"\(DomainFixtures.sha256(audio))\"},"
            + "\"camera\":[],\"detected_at\":\"\(at)\",\"ended_by\":\"holders_gone\",\"latency_ms\":0,\"part\":1,"
            + "\"room\":[{\"at\":\"\(at)\",\"holders\":[\"us.zoom.xos\"],\"players\":[\"us.zoom.xos\"]}],"
            + "\"track\":\"\(stem.hasSuffix(".mic") ? "mic" : "sound")\",\"until\":\"\(until)\"}\n"
        try DomainFixtures.write(sidecar, to: folder.appendingPathComponent("\(stem).json"))
    }

    private func spool() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: folder.path).sorted()
    }

    func testTheManifestIsTheBytesTheHomeReads() throws {
        try record(Self.newer, seconds: 90)
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T04:30:00.250Z")))
        let zip = try StoredZipReader(sealed.file)
        XCTAssertEqual(zip.names, ["\(Self.newer).json", "\(Self.newer).m4a", "manifest.json"])
        let json = try XCTUnwrap(zip.text("\(Self.newer).json"))
        let audio = "synthetic audio \(Self.newer)"
        XCTAssertEqual(zip.text("manifest.json"),
            "{\"format\":\"org.lifestreamprotocol.acquisition/1\",\"source_id\":\"audio:local:unit-0001\","
            + "\"feeder\":\"audio-recording\",\"fetched_at\":\"2026-09-23T04:30:00.250Z\",\"complete\":true,"
            + "\"files\":[{\"file\":\"\(Self.newer).json\",\"sha256\":\"\(DomainFixtures.sha256(json))\",\"bytes\":\(Data(json.utf8).count)},"
            + "{\"file\":\"\(Self.newer).m4a\",\"sha256\":\"\(DomainFixtures.sha256(audio))\",\"bytes\":\(Data(audio.utf8).count)}],"
            + "\"facts\":{\"recordings\":1,\"audio_ms\":90000,\"newest_recording_at\":\"2026-09-22T10:00:00.000Z\","
            + "\"snapshot_taken_at\":\"2026-09-23T04:30:00.250Z\",\"blobs_carried\":0},"
            + "\"custody\":{\"audio:local:unit-0001\":{\"seal\":1}}}\n")
    }

    func testAReadThroughIsThroughTheOldestOpenRecording() throws {
        try record(Self.older)
        _ = try domain().sealOne(DomainFixtures.request(work: work))
        let fetch = try DomainFixtures.instant("2026-09-23T04:30:00.000Z")
        XCTAssertEqual(try DomainFixtures.stated(domain(), DomainFixtures.request(
            work: work, at: "2026-09-23T04:30:00.000Z", custody: following(1), owesThrough: true)),
                       Through(readThrough: fetch, statedAt: fetch), "nothing open: read through the fetch")

        try DomainFixtures.write("{}", to: folder.appendingPathComponent("20260923T042500.000Z.mic.open.json"))
        XCTAssertEqual(try DomainFixtures.stated(domain(), DomainFixtures.request(
            work: work, at: "2026-09-23T04:31:00.000Z", custody: following(1), owesThrough: true)),
                       Through(readThrough: try DomainFixtures.instant("2026-09-23T04:25:00.000Z"),
                               statedAt: try DomainFixtures.instant("2026-09-23T04:31:00.000Z")),
                       "an open recording holds it at its start")
        XCTAssertNil(try DomainFixtures.stated(domain(), DomainFixtures.request(work: work, at: "2026-09-23T04:32:00.000Z", custody: following(1))),
                     "none owed: nothing stated")
    }

    func testEveryRecordingNoHeldSealCarriedTravels() throws {
        try record(Self.newer)
        let first = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work)))
        XCTAssertEqual(try carried(first), [Self.newer])
        XCTAssertNil(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:00:00.000Z", custody: following(1))),
                     "nothing new ships nothing")
        try record(Self.older)
        let late = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:05:00.000Z", custody: following(1))))
        XCTAssertEqual(try StoredZipReader(late.file).names, ["\(Self.older).json", "\(Self.older).m4a", "manifest.json"])
        XCTAssertEqual(late.sidecar.seal, 2)
        let again = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:10:00.000Z")))
        XCTAssertEqual(try carried(again), [Self.older, Self.newer])
        XCTAssertNil(try DomainFixtures.custody(of: again)["lost"])
    }

    func testOnlyWholeSealedPairsTravel() throws {
        try record(Self.older)
        try DomainFixtures.write("half written", to: folder.appendingPathComponent("20260923T040000.000Z.mic.m4a"))
        try DomainFixtures.write("{}", to: folder.appendingPathComponent("20260923T040000.000Z.mic.open.json"))
        try DomainFixtures.write("parked", to: folder.appendingPathComponent("20260923T030000.000Z.mic.m4a.torn"))
        try DomainFixtures.write("{}", to: folder.appendingPathComponent("20260923T020000.000Z.mic.json"))
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work)))
        XCTAssertEqual(try StoredZipReader(sealed.file).names, ["\(Self.older).json", "\(Self.older).m4a", "manifest.json"])
    }

    func testAStoreWithNoRecordingYetShipsNothing() throws {
        try FileManager.default.removeItem(at: folder)
        XCTAssertNil(try domain().sealOne(DomainFixtures.request(work: work)))
    }

    func testAnImportedRecordingIsDeletedOnlyOnceItIsSevenDaysOld() async throws {
        try record(Self.older)
        try record(Self.newer)
        _ = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work)))
        try domain(now: "2027-01-01T00:00:00.000Z").applied(
            try await DomainFixtures.fresh(Self.source, received: 1, imported: 0, folder: root))
        XCTAssertEqual(try spool().count, 4, "a seal the home has not imported deletes nothing")

        try domain().applied(try await DomainFixtures.fresh(Self.source, received: 1, imported: 1, folder: root))
        XCTAssertEqual(try spool(), ["\(Self.newer).json", "\(Self.newer).m4a"], "the ten-day-old one leaves")

        try domain(now: "2026-10-01T00:00:00.000Z").applied(try await DomainFixtures.fresh(Self.source, received: 1, imported: 1, folder: root))
        XCTAssertEqual(try spool(), [])

        try record("20260930T100000.000Z.mic")
        let restored = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-10-01T00:00:00.000Z")))
        let lost = try XCTUnwrap(try DomainFixtures.custody(of: restored)["lost"] as? [[String: Any]])
        XCTAssertEqual(lost.first?["items"] as? Int, 2)
        XCTAssertEqual(lost.first?["what"] as? String, "recordings, up to that many: this Mac deleted them after an earlier import")
    }

    func testTheDomainIsBuiltForAnAudioSource() throws {
        let paths = ShippingDomains.Paths(home: root, machineEventsRoot: root, inputEventsRoot: root, audioRoot: folder,
                                          hashCacheDirectory: root, ledgers: ledgers, sessionDirectory: root, importRoom: .roomy(root))
        let built = ShippingDomains.build([Self.source], paths: paths, stores: try StoreFixtures.none(root.appendingPathComponent("stores")))
        let domain = try XCTUnwrap(built.first as? AudioDomain)
        XCTAssertEqual(domain.root, folder)
        XCTAssertEqual(domain.ledgers.root, ledgers.root)
        XCTAssertEqual(domain.name, "audio")
        XCTAssertEqual(ShippingDomains.conventional(home: root, spool: root, fullDiskAccessWitness: root.appendingPathComponent("TCC.db"),
                                                    photosAllowed: { false }, importRoom: .roomy(root), files: DeviceFiles(.plain)).audioRoot, folder)
    }

    func testNothingNewerThanAnOpenRecordingShips() throws {
        try record(Self.older)
        try DomainFixtures.write("{}", to: folder.appendingPathComponent("20260915T100000.000Z.sound.open.json"))
        try DomainFixtures.write("growing", to: folder.appendingPathComponent("20260915T100000.000Z.sound.m4a"))
        try record("20260915T100030.000Z.mic")
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work)))
        XCTAssertEqual(try StoredZipReader(sealed.file).names, ["\(Self.older).json", "\(Self.older).m4a", "manifest.json"])
        try FileManager.default.removeItem(at: folder.appendingPathComponent("20260915T100000.000Z.sound.open.json"))
        try FileManager.default.removeItem(at: folder.appendingPathComponent("20260915T100000.000Z.sound.m4a"))
        try record("20260915T100000.000Z.sound")
        let next = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:00:00.000Z", custody: following(1))))
        XCTAssertEqual(try carried(next), ["20260915T100000.000Z.sound", "20260915T100030.000Z.mic"])
    }
}
