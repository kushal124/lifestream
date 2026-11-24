import Evidence
import DeviceFiles
import Foundation
import XCTest
@testable import Shipping

final class MachineEventsDomainTests: XCTestCase {
    private var root: URL!
    private var batches: URL!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("machine-events-domain-tests")
        batches = root.appendingPathComponent("machine-events", isDirectory: true)
        try FileManager.default.createDirectory(at: batches, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var work: URL { root.appendingPathComponent("work", isDirectory: true) }
    private static let older = "20260921T223000.000Z.jsonl"
    private static let newer = "20260922T223000.000Z.jsonl"
    private static let newerLine = "{\"at\":\"2026-09-22T22:30:00.000Z\",\"event\":\"locked\",\"detail\":{}}"

    private func domain(now: String = "2026-09-23T04:30:00.000Z") throws -> MachineEventsDomain {
        let date = try DomainFixtures.instant(now)
        return MachineEventsDomain(sourceId: DomainFixtures.machineSource, batchRoot: batches, ledgers: ledgers,
                                   clock: { date })
    }

    private func spool() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: batches.path).sorted()
    }

    private var ledgers: Ledgers { Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)) }

    private func carried(_ batches: [String]) throws -> SealCustody {
        try DomainFixtures.received(SpoolEntry(items: batches), source: DomainFixtures.machineSource, ledgers: ledgers)
    }

    private func buildBatches() throws {
        try DomainFixtures.write("{\"at\":\"2026-09-21T22:30:00.000Z\",\"event\":\"wake\",\"detail\":{}}\n"
            + "{\"at\":\"2026-09-21T23:00:00.000Z\",\"event\":\"sleep\",\"detail\":{}}\n",
            to: batches.appendingPathComponent(Self.older))
        try DomainFixtures.write(Self.newerLine + "\n", to: batches.appendingPathComponent(Self.newer))
        try DomainFixtures.write("{\"at\":\"2026-09-23T04:00:00.000Z\",\"event\":\"wake\",\"detail\":{}}\n",
                                 to: batches.appendingPathComponent("current.jsonl"))
        try DomainFixtures.write("not a batch", to: batches.appendingPathComponent("notes.txt"))
    }

    func testTheManifestIsTheBytesTheHomeReads() throws {
        try buildBatches()
        let request = try DomainFixtures.request(work: work, at: "2026-09-23T04:30:00.250Z", custody: carried([Self.older]))
        let sealed = try XCTUnwrap(try domain().sealOne(request))
        let zip = try StoredZipReader(sealed.file)
        XCTAssertEqual(zip.names, [Self.newer, "manifest.json"])

        let sha = DomainFixtures.sha256(Self.newerLine + "\n")
        XCTAssertEqual(Data((Self.newerLine + "\n").utf8).count, 63)
        XCTAssertEqual(zip.text("manifest.json"),
            "{\"format\":\"org.lifestreamprotocol.acquisition/1\",\"source_id\":\"machine:local:unit-0001\","
            + "\"feeder\":\"machine-events\",\"fetched_at\":\"2026-09-23T04:30:00.250Z\",\"complete\":true,"
            + "\"files\":[{\"file\":\"\(Self.newer)\",\"sha256\":\"\(sha)\",\"bytes\":63}],"
            + "\"facts\":{\"batches\":1,\"newest_event_at\":\"2026-09-22T22:30:00.000Z\","
            + "\"snapshot_taken_at\":\"2026-09-23T04:30:00.250Z\",\"blobs_carried\":0},"
            + "\"custody\":{\"machine:local:unit-0001\":{\"seal\":2}}}\n")
    }

    func testEveryBatchTravelsWhenNothingHasShipped() throws {
        try buildBatches()
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work)))
        XCTAssertEqual(try StoredZipReader(sealed.file).names, [Self.older, Self.newer, "manifest.json"])
        XCTAssertEqual(try DomainFixtures.entry(SpoolEntry.self, of: sealed, ledgers: ledgers).items, [Self.older, Self.newer])
    }

    func testABatchNamedBehindTheNewestShippedStillShips() throws {
        try buildBatches()
        try DomainFixtures.write("{\"at\":\"2026-09-21T22:31:00.000Z\",\"event\":\"lid\",\"detail\":{}}\n",
                                 to: batches.appendingPathComponent("20260921T223000.000Z-2.jsonl"))
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, custody: carried([Self.older, Self.newer]))))
        XCTAssertEqual(try StoredZipReader(sealed.file).names, ["20260921T223000.000Z-2.jsonl", "manifest.json"])
    }

    func testNothingNoSealCarriedSealsNoBundle() throws {
        try buildBatches()
        let request = try DomainFixtures.request(work: work, custody: carried([Self.older, Self.newer]))
        XCTAssertNil(try domain().sealOne(request))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: work.path), [],
                       "nothing new writes no bundle")
    }

    func testADirectoryOfEmptyBatchesStatesNoNewestEvent() throws {
        try DomainFixtures.write("", to: batches.appendingPathComponent(Self.newer))
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work)))
        let manifest = try XCTUnwrap(try StoredZipReader(sealed.file).text("manifest.json"))
        XCTAssertTrue(manifest.contains("\"newest_event_at\":null"), manifest)
        XCTAssertTrue(manifest.contains("\"batches\":1"))
    }

    func testTheNewestEventIsTheLatestAcrossEveryBatchShipped() throws {
        try buildBatches()
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work)))
        let manifest = try XCTUnwrap(try StoredZipReader(sealed.file).text("manifest.json"))
        XCTAssertTrue(manifest.contains("\"newest_event_at\":\"2026-09-22T22:30:00.000Z\""), manifest)
        XCTAssertTrue(manifest.contains("\"batches\":2"))
    }

    func testALineThatIsNotAnEventWithAnInstantRefuses() throws {
        try DomainFixtures.write("{\"event\":\"wake\"}\n", to: batches.appendingPathComponent(Self.newer))
        XCTAssertThrowsError(try domain().sealOne(DomainFixtures.request(work: work))) { error in
            XCTAssertEqual("\(error)",
                           "the batch \(Self.newer) states a line that is not an event with an instant")
        }
    }

    func testABatchRootThatIsNotThereRefuses() throws {
        try FileManager.default.removeItem(at: batches)
        XCTAssertThrowsError(try domain().sealOne(DomainFixtures.request(work: work))) { error in
            XCTAssertEqual("\(error)", "\(batches.path) is not a directory of machine event batches")
        }
    }


    private static let monthOld = "20260922T000000.000Z.jsonl"
    private static let underAMonth = "20260924T000000.000Z.jsonl"
    private static let monthLater = "2026-10-23T00:00:00.000Z"

    private func sealTwoBatches() throws {
        try DomainFixtures.write("{\"at\":\"2026-09-22T00:00:00.000Z\",\"event\":\"wake\",\"detail\":{}}\n",
                                 to: batches.appendingPathComponent(Self.monthOld))
        try DomainFixtures.write("{\"at\":\"2026-09-24T00:00:00.000Z\",\"event\":\"wake\",\"detail\":{}}\n",
                                 to: batches.appendingPathComponent(Self.underAMonth))
        try DomainFixtures.write("{\"at\":\"2026-10-22T23:00:00.000Z\",\"event\":\"wake\",\"detail\":{}}\n",
                                 to: batches.appendingPathComponent("current.jsonl"))
        try DomainFixtures.write("not a batch", to: batches.appendingPathComponent("notes.txt"))
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work)))
        XCTAssertEqual(try DomainFixtures.entry(SpoolEntry.self, of: sealed, ledgers: ledgers).items,
                       [Self.monthOld, Self.underAMonth])
    }

    func testAnImportedBatchIsDeletedOnlyOnceItIsThirtyDaysOld() async throws {
        try sealTwoBatches()
        let uncarried = "20260901T000000.000Z.jsonl"
        try DomainFixtures.write("{\"at\":\"2026-09-01T00:00:00.000Z\",\"event\":\"wake\",\"detail\":{}}\n",
                                 to: batches.appendingPathComponent(uncarried))

        try domain(now: Self.monthLater).applied(
            try await DomainFixtures.fresh(DomainFixtures.machineSource, received: 1, imported: 1, folder: root))
        XCTAssertEqual(try spool(), [uncarried, Self.underAMonth, "current.jsonl", "notes.txt"])
        let entry = try XCTUnwrap(try ledgers.ledger(SpoolEntry.self, pass: ShippingFixture.pass,
                                                     source: DomainFixtures.machineSource).read()[1])
        XCTAssertEqual(entry.items, [Self.underAMonth], "the deleted batch leaves the seal's entry")
        XCTAssertEqual(entry.deleted, 1)

        try domain(now: "2026-10-25T00:00:00.000Z").applied(
            try await DomainFixtures.fresh(DomainFixtures.machineSource, received: 1, imported: 1, folder: root))
        XCTAssertEqual(try spool(), [uncarried, "current.jsonl", "notes.txt"])
    }

    func testABatchNoImportedSealCarriedStays() async throws {
        try sealTwoBatches()
        try domain(now: "2027-01-01T00:00:00.000Z").applied(
            try await DomainFixtures.fresh(DomainFixtures.machineSource, received: 1, imported: 0, folder: root))
        XCTAssertEqual(try spool(), [Self.monthOld, Self.underAMonth, "current.jsonl", "notes.txt"])
    }
}
