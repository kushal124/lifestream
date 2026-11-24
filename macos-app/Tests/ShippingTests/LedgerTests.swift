import XCTest
import DeviceFiles
@testable import Shipping

final class LedgerTests: XCTestCase {
    private var root: URL!
    private var ledgers: Ledgers!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("ledger-tests-\(UUID().uuidString)")
        ledgers = Ledgers(root: root, files: DeviceFiles(.plain))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var spool: SealLedger<SpoolEntry> { ledgers.ledger(pass: ShippingFixture.pass, source: ShippingFixture.inputSource) }

    func testOnlySealsUpToReceivedAreHeldAndARecordDropsEveryLaterOne() throws {
        for (seal, item) in ["a", "b", "c"].enumerated() { try spool.record(SpoolEntry(items: [item]), at: seal + 1) }
        XCTAssertEqual(try spool.held(through: 2).map(\.entry.items), [["a"], ["b"]])
        XCTAssertEqual(try spool.rolledBack(after: 1).map(\.items), [["b"], ["c"]])

        try spool.record(SpoolEntry(items: ["d"]), at: 2)
        XCTAssertEqual(try spool.read().keys.sorted(), [1, 2], "seal 3 of the rolled-back history is gone")
        XCTAssertEqual(try spool.held(through: 5).map(\.entry.items), [["a"], ["d"]])
    }

    func testPruningFoldsWhatOlderSealsCarriedIntoTheNewestImportedOne() throws {
        for (seal, item) in ["a", "b", "c", "d"].enumerated() { try spool.record(SpoolEntry(items: [item]), at: seal + 1) }
        try spool.prune(imported: 3)
        let seals = try spool.read()
        XCTAssertEqual(seals.keys.sorted(), [3, 4], "kept from imported onward")
        XCTAssertEqual(seals[3]?.items, ["a", "b", "c"], "nothing an older seal carried is forgotten")
        XCTAssertEqual(seals[4]?.items, ["d"], "a seal past imported is not folded")
        try spool.prune(imported: 0)
        XCTAssertEqual(try spool.read(), seals, "nothing at or below 0 to fold")
    }

    func testALedgerThatDoesNotReadRefusesRatherThanGuesses() throws {
        try spool.record(SpoolEntry(items: ["a"]), at: 1)
        for broken in ["{\"seals\":[]}", "not json", "{\"seals\":{\"01\":{\"items\":[],\"deleted\":0}}}",
                       "{\"seals\":{\"-1\":{\"items\":[],\"deleted\":0}}}"] {
            try Data(broken.utf8).write(to: spool.file)
            XCTAssertThrowsError(try spool.held(through: 1), broken)
        }
    }

    func testSealZeroIsTheBaseAConvertedSourceStartsFrom() throws {
        try FileManager.default.createDirectory(at: spool.file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{\"seals\":{\"0\":{\"items\":[\"a\"],\"deleted\":0}}}".utf8).write(to: spool.file)
        XCTAssertEqual(try spool.held(through: 0).map(\.seal), [0])
        try spool.record(SpoolEntry(items: ["b"]), at: 1)
        XCTAssertEqual(try spool.held(through: 1).map(\.seal), [0, 1])
        XCTAssertEqual(try spool.rolledBack(after: 0).count, 1)
    }

    func testTheFileIsSortedJSONOnePassFolderPerPass() throws {
        try spool.record(SpoolEntry(items: ["b", "a"]), at: 2)
        try spool.record(SpoolEntry(items: ["x"]), at: 10)
        XCTAssertEqual(spool.file.path, root.appendingPathComponent("p-00000001/input_local_unit-0001.json").path)
        XCTAssertEqual(try String(contentsOf: spool.file, encoding: .utf8),
                       "{\"seals\":{\"10\":{\"deleted\":0,\"items\":[\"x\"]},\"2\":{\"deleted\":0,\"items\":[\"b\",\"a\"]}}}\n")

        let other = ledgers.ledger(SpoolEntry.self, pass: "p-00000002", source: ShippingFixture.inputSource)
        XCTAssertEqual(try other.held(through: 10).count, 0, "a new pass starts a new ledger")
        ledgers.keep(only: "p-00000002")
        XCTAssertFalse(FileManager.default.fileExists(atPath: spool.file.path))
    }


    func testASpoolOwesEveryItemNoHeldSealCarriedWhateverItsName() throws {
        let custody = SpoolCustody(ledgers: ledgers, pass: ShippingFixture.pass, source: ShippingFixture.inputSource, word: "input batches")
        try custody.record(["20260923T101452.000Z.jsonl"], at: 1)
        let owed = try custody.owed(["20260923T092554.000Z.jsonl", "20260923T101452.000Z.jsonl", "20260923T110000.000Z.jsonl"],
                                    received: 1)
        XCTAssertEqual(owed.items, ["20260923T092554.000Z.jsonl", "20260923T110000.000Z.jsonl"],
                       "a batch named behind the newest one shipped still ships")
        XCTAssertEqual(owed.lost, [])
    }

    func testAnItemLeavesOnlyOnceASealUpToImportedCarriedItAndALaterRestoreSaysItIsLost() throws {
        let custody = SpoolCustody(ledgers: ledgers, pass: ShippingFixture.pass, source: ShippingFixture.inputSource, word: "input batches")
        try custody.record(["a", "b"], at: 1)
        try custody.record(["c"], at: 2)
        var offered: [String] = []
        custody.reclaim(imported: 1) { item in
            offered.append(item)
            return item != "b"
        }
        XCTAssertEqual(offered.sorted(), ["a", "b"], "c's seal is not imported: it is never offered")
        let seals = try custody.ledger.read()
        XCTAssertEqual(seals[1], SpoolEntry(items: ["b"], deleted: 1))
        XCTAssertEqual(seals[2], SpoolEntry(items: ["c"]))

        let owed = try custody.owed(["b", "c"], received: 0)
        XCTAssertEqual(owed.items, ["b", "c"])
        XCTAssertEqual(owed.lost, [Lost(items: 1, what: "input batches, up to that many: this Mac deleted them after an earlier import")])
    }

    func testALossASealStatedIsStatedAgainWhenThatSealIsSealedAgainAndNoMoreOnceReceived() throws {
        let custody = SpoolCustody(ledgers: ledgers, pass: ShippingFixture.pass, source: ShippingFixture.inputSource, word: "input batches")
        try custody.record(["a"], at: 1)
        try custody.record(["b", "c"], at: 2)
        custody.reclaim(imported: 2) { _ in true }
        let restored = try custody.owed(["d"], received: 1)
        XCTAssertEqual(restored.lost.map(\.items), [3])
        try custody.record(restored.items, at: 2, lost: restored.lost)
        let again = try custody.owed(["d"], received: 1)
        XCTAssertEqual(again.lost.map(\.items), [3], "a reseal states the loss again")
        try custody.record(again.items, at: 2, lost: again.lost)
        XCTAssertEqual(try custody.owed(["d", "e"], received: 2).lost, [])
        XCTAssertEqual(try custody.ledger.read()[2]?.deleted, 3)
    }

}
