import XCTest
import DeviceFiles
@testable import Shipping

final class ShippingStateTests: XCTestCase {
    private var root: URL!
    private var state: ShippingState!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("shipping-state-tests-\(UUID().uuidString)")
        state = ShippingState(root: root, files: DeviceFiles(.plain))
        try state.prepare()
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func names(_ directory: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
    }

    @discardableResult
    private func plant(_ id: String, in directory: URL, sourceId: String = ShippingFixture.machineSource,
                       seal: Int = 1, kind: String? = nil, sidecar writeSidecar: Bool = true) throws -> SealedBundle {
        let file = directory.appendingPathComponent(
            ShippingState.fileName(forSource: sourceId) + "__" + id + ".zip")
        try Data("synthetic bundle \(id)\n".utf8).write(to: file)
        let bundle = SealedBundle(file: file, sidecar: BundleSidecar(
            id: "\(sourceId)/\(id)", sourceId: sourceId, pass: ShippingFixture.pass, seal: seal, kind: kind, write: .new))
        if writeSidecar { try state.writeSidecar(bundle) }
        return bundle
    }


    func testPrepareMakesEveryDirectoryAndIsSafeToRepeat() throws {
        try state.prepare()
        XCTAssertEqual(try names(root), ["hash-cache", "ledger", "pending", "work"])
    }


    func testTheScheduleRoundTripsWithInstantsAsRFC3339MillisecondsAndSortedKeys() throws {
        let actedAt = ShippingFixture.instant("2026-09-22T23:00:00.250Z")
        var schedule = ShippingSchedule()
        schedule.lastRunAt = actedAt
        schedule.lastOutcome = "shipped"
        schedule.domains[ShippingFixture.machineSource] = DomainSchedule(
            actedAt: actedAt, sealedAt: actedAt, historySeal: 4)
        try state.writeSchedule(schedule)

        XCTAssertEqual(state.readSchedule(), schedule)
        let text = try String(contentsOf: state.scheduleFile, encoding: .utf8)
        XCTAssertTrue(text.hasSuffix("}\n"), "one JSON object and one newline")
        XCTAssertTrue(text.contains("\"acted_at\":\"2026-09-22T23:00:00.250Z\""), text)
        XCTAssertTrue(text.contains("\"history_seal\":4"), text)
        for (earlier, later) in [("\"domains\"", "\"last_outcome\""), ("\"last_outcome\"", "\"last_run_at\""),
                                 ("\"acted_at\"", "\"history_seal\""), ("\"history_seal\"", "\"sealed_at\"")] {
            XCTAssertLessThan(text.range(of: earlier)!.lowerBound, text.range(of: later)!.lowerBound,
                              "\(earlier) sorts before \(later)")
        }
    }

    func testAScheduleAnOlderReleaseWroteStillReads() throws {
        try Data("""
            {"domains":{"machine:local:unit-0001":{"acted_at":"2026-09-22T23:00:00.250Z","bundle":"machine:local:unit-0001/20260922T230000.250Z","code":null,"outcome":"shipped","sealed_at":"2026-09-22T23:00:00.250Z"}},"last_outcome":"shipped","last_run_at":"2026-09-22T23:00:00.250Z","pass":"p-00000001"}

            """.utf8).write(to: state.scheduleFile)
        let acted = ShippingFixture.instant("2026-09-22T23:00:00.250Z")
        var expected = ShippingSchedule()
        expected.lastRunAt = acted
        expected.lastOutcome = "shipped"
        expected.domains[ShippingFixture.machineSource] = DomainSchedule(actedAt: acted, sealedAt: acted)
        expected.pass = "p-00000001"
        XCTAssertEqual(state.readSchedule(), expected, "its pass reads, with no pairing time: the next run starts one")
    }

    func testAMissingOrMalformedScheduleReadsAsAFreshOne() throws {
        XCTAssertEqual(state.readSchedule(), ShippingSchedule())
        try Data("{\"last_run_at\":\"yesterday\"}".utf8).write(to: state.scheduleFile)
        XCTAssertEqual(state.readSchedule(), ShippingSchedule())
        try Data().write(to: state.scheduleFile)
        XCTAssertEqual(state.readSchedule(), ShippingSchedule(), "a file a power cut left empty")
    }

    func testASidecarRoundTripsItsPassSealAndKind() throws {
        let bundle = try plant("20260922T230000.000Z", in: state.pendingDirectory,
                               sourceId: ShippingFixture.messagesSource, seal: 7, kind: "delta")
        XCTAssertEqual(try state.pendingBundles(), [bundle])
        let text = try String(contentsOf: ShippingState.sidecarFile(for: bundle.file), encoding: .utf8)
        XCTAssertTrue(text.contains("\"seal\":7"), text)
        XCTAssertTrue(text.contains("\"pass\":\"p-00000001\""), text)
        XCTAssertTrue(text.contains("\"kind\":\"delta\""), text)
    }

    func testASidecarThatStatesNoSealIsSpent() throws {
        let bundle = try plant("20260922T230000.000Z", in: state.pendingDirectory, sidecar: false)
        try Data("{\"id\":\"\(ShippingFixture.machineSource)/20260922T230000.000Z\",\"pass\":\"\(ShippingFixture.pass)\",\"source_id\":\"\(ShippingFixture.machineSource)\",\"write\":\"new\"}\n".utf8)
            .write(to: ShippingState.sidecarFile(for: bundle.file))
        XCTAssertEqual(try state.pendingBundles(), [])
        XCTAssertEqual(try names(state.pendingDirectory), [], "spent, its sidecar with it")
    }


    func testASidecarSitsBesideItsBundleUnderTheSameNameWithJSONAppended() throws {
        let bundle = try plant("20260922T230000.000Z", in: state.pendingDirectory,
                               seal: 2)
        XCTAssertEqual(ShippingState.sidecarFile(for: bundle.file).lastPathComponent,
                       "machine_local_unit-0001__20260922T230000.000Z.zip.json")
        XCTAssertEqual(try state.pendingBundles(), [bundle])

        let text = try String(contentsOf: ShippingState.sidecarFile(for: bundle.file), encoding: .utf8)
        XCTAssertTrue(text.contains("\"source_id\":\"machine:local:unit-0001\""), text)
        XCTAssertTrue(text.hasSuffix("}\n"))
    }

    func testPendingBundlesLeavesAZipWithNoSidecarWhereItIs() throws {
        let kept = try plant("20260922T230000.000Z", in: state.pendingDirectory)
        try plant("20260922T240000.000Z", in: state.pendingDirectory, sidecar: false)
        XCTAssertEqual(try state.pendingBundles(), [kept])
        XCTAssertEqual(try names(state.pendingDirectory).count, 3, "the stranger is still there")
    }

    func testAZipWhoseSidecarIsNotASidecarIsSpent() throws {
        let kept = try plant("20260922T220000.000Z", in: state.pendingDirectory)
        let bundle = try plant("20260922T230000.000Z", in: state.pendingDirectory, sidecar: false)
        try Data("{\"id\":1}".utf8).write(to: ShippingState.sidecarFile(for: bundle.file))
        XCTAssertEqual(try state.pendingBundles(), [kept])
        XCTAssertEqual(try names(state.pendingDirectory), [kept.file.lastPathComponent, kept.file.lastPathComponent + ".json"],
                       "the bundle and its sidecar are gone")
    }

    func testPendingBundlesComeBackOldestNameFirst() throws {
        try plant("20260923T230000.000Z", in: state.pendingDirectory)
        try plant("20260921T230000.000Z", in: state.pendingDirectory)
        try plant("20260922T230000.000Z", in: state.pendingDirectory)
        XCTAssertEqual(try state.pendingBundles().map { $0.sidecar.id }, [
            "machine:local:unit-0001/20260921T230000.000Z",
            "machine:local:unit-0001/20260922T230000.000Z",
            "machine:local:unit-0001/20260923T230000.000Z",
        ])
    }

    func testParkMovesABundleAndItsSidecarOutOfWorkAndIsIdempotent() throws {
        let sealed = try plant("20260922T230000.000Z", in: state.workDirectory,
                               seal: 2)
        let parked = try state.park(sealed)

        XCTAssertEqual(parked.file.deletingLastPathComponent().lastPathComponent, "pending")
        XCTAssertEqual(parked.sidecar, sealed.sidecar)
        XCTAssertEqual(try names(state.workDirectory), [])
        XCTAssertEqual(try state.pendingBundles(), [parked])
        XCTAssertEqual(try state.park(parked), parked, "parking what is already parked changes nothing")
        XCTAssertEqual(try state.pendingBundles(), [parked])
    }

    func testRecoverWorkParksWhatACrashLeftBehind() throws {
        let sealed = try plant("20260922T230000.000Z", in: state.workDirectory)
        try Data("half a bundle\n".utf8).write(to: state.workDirectory.appendingPathComponent("orphan.zip"))
        try state.recoverWork()

        XCTAssertEqual(try state.pendingBundles().map { $0.sidecar.id }, [sealed.sidecar.id])
        XCTAssertEqual(try names(state.workDirectory), ["orphan.zip"], "a zip with no sidecar is left alone")
    }

    func testARefusedBundleIsParkedWithTheDoorsCodeAndWhenAndReadsBack() throws {
        let sealed = try plant("20260922T230000.000Z", in: state.workDirectory, seal: 3)
        let at = ShippingFixture.instant("2026-09-22T23:00:00.500Z")
        let refused = try state.refuse(sealed, code: "ACQUISITION_MANIFEST", at: at)

        XCTAssertEqual(try names(state.workDirectory), [])
        XCTAssertEqual(refused.sidecar.refused, BundleSidecar.Refusal(code: "ACQUISITION_MANIFEST", at: at))
        XCTAssertEqual(refused.sidecar.seal, 3)
        XCTAssertEqual(try state.pendingBundles(), [refused])
        let text = try String(contentsOf: ShippingState.sidecarFile(for: refused.file), encoding: .utf8)
        XCTAssertTrue(text.contains("\"refused\":{\"at\":\"2026-09-22T23:00:00.500Z\",\"code\":\"ACQUISITION_MANIFEST\"}"), text)
    }

    func testABundleNeverRefusedStatesNoRefusal() throws {
        let bundle = try plant("20260922T230000.000Z", in: state.pendingDirectory)
        XCTAssertNil(try state.pendingBundles().first?.sidecar.refused)
        let text = try String(contentsOf: ShippingState.sidecarFile(for: bundle.file), encoding: .utf8)
        XCTAssertFalse(text.contains("refused"), text)
    }

    func testSpendDeletesTheBundleAndItsSidecarTogether() throws {
        let bundle = try plant("20260922T230000.000Z", in: state.pendingDirectory)
        state.spend(bundle)
        XCTAssertEqual(try names(state.pendingDirectory), [])
        state.spend(bundle)
        XCTAssertEqual(try names(state.pendingDirectory), [], "spending a spent bundle is not an error")
    }


    func testReplaceLeavesTheNewFileAndNoTemporaryBeside() throws {
        let file = root.appendingPathComponent("replaced.json")
        try ShippingState.replace(file, with: Data("{\"first\":true}\n".utf8), files: DeviceFiles(.plain))
        try ShippingState.replace(file, with: Data("{\"second\":true}\n".utf8), files: DeviceFiles(.plain))
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "{\"second\":true}\n")
        XCTAssertEqual(try names(root), ["hash-cache", "ledger", "pending", "replaced.json", "work"])
    }

    func testReplaceMakesTheDirectoryItWritesInto() throws {
        let file = root.appendingPathComponent("deeper/still/file.json")
        try ShippingState.replace(file, with: Data("{}\n".utf8), files: DeviceFiles(.plain))
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "{}\n")
    }
}
