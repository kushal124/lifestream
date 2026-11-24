import Foundation
import XCTest

@testable import LifestreamCaptureCore

final class EnergyLedgerTests: XCTestCase {

    func testACounterDeltaIsLostOrCountedTwice() throws {
        let clock = Counters()
        let ledger = clock.ledger()
        clock.spend(cpu: 5)
        ledger.measure(.location) { clock.spend(cpu: 7) }
        ledger.measure(.health) { clock.spend(cpu: 11) }
        clock.spend(cpu: 13)
        let window = try XCTUnwrap(ledger.closeWindow())
        let accounts = try Window(window).accounts
        XCTAssertEqual(accounts[[]]?.cpu, 18)
        XCTAssertEqual(accounts[["location"]]?.cpu, 7)
        XCTAssertEqual(accounts[["health"]]?.cpu, 11)
        XCTAssertEqual(accounts.values.map(\.cpu).reduce(0, +), try Window(window).processCPU)
    }

    func testConcurrentPartsBothClaimTheWorkTheyShared() async throws {
        let clock = Counters()
        let ledger = clock.ledger()
        let locationOpen = Gate(), healthDone = Gate()
        async let location: Void = ledger.measure(.location) {
            clock.spend(cpu: 3)
            locationOpen.open()
            await healthDone.wait()
            clock.spend(cpu: 4)
        }
        await locationOpen.wait()
        await Task {
            ledger.measure(.health) { clock.spend(cpu: 10) }
        }.value
        healthDone.open()
        await location
        let accounts = try Window(XCTUnwrap(ledger.closeWindow())).accounts
        XCTAssertEqual(accounts[["location"]]?.cpu, 7)
        XCTAssertEqual(accounts[["health", "location"]]?.cpu, 10)
        XCTAssertNil(accounts[["health"]])
    }

    func testANestedPartLeavesItsParentBilledForTheChild() async throws {
        let clock = Counters()
        let ledger = clock.ledger()
        await ledger.measure(.shipping) {
            clock.spend(cpu: 2)
            await ledger.measure(.photos) {
                await Task.yield()
                clock.spend(cpu: 30)
                ledger.measure(.photos) { clock.spend(cpu: 1) }
            }
            clock.spend(cpu: 5)
        }
        let window = try Window(XCTUnwrap(ledger.closeWindow()))
        XCTAssertEqual(window.accounts[["shipping"]]?.cpu, 7)
        XCTAssertEqual(window.accounts[["photos"]]?.cpu, 31)
        XCTAssertNil(window.accounts[["photos", "shipping"]])
        XCTAssertEqual(window.intervals, ["photos": 1, "shipping": 1])
        XCTAssertEqual(window.open, [])
    }

    func testATaskSpawnedInsideAPartPausesOrRevivesThatPart() async throws {
        let clock = Counters()
        let ledger = clock.ledger()
        var spawned: Task<Void, Never>?
        let release = Gate()
        ledger.measure(.location) {
            clock.spend(cpu: 1)
            spawned = Task {
                await release.wait()
                ledger.measure(.health) { clock.spend(cpu: 20) }
            }
        }
        release.open()
        await spawned?.value
        clock.spend(cpu: 4)
        let window = try Window(XCTUnwrap(ledger.closeWindow()))
        XCTAssertEqual(window.accounts[["location"]]?.cpu, 1)
        XCTAssertEqual(window.accounts[["health"]]?.cpu, 20)
        XCTAssertEqual(window.accounts[[]]?.cpu, 4)
        XCTAssertEqual(window.open, [])
    }

    func testAPartThatThrowsStaysOpenForever() throws {
        let clock = Counters()
        let ledger = clock.ledger()
        struct Failure: Error {}
        XCTAssertThrowsError(try ledger.measure(.contacts) { clock.spend(cpu: 3); throw Failure() })
        clock.spend(cpu: 2)
        let window = try Window(XCTUnwrap(ledger.closeWindow()))
        XCTAssertEqual(window.accounts[["contacts"]]?.cpu, 3)
        XCTAssertEqual(window.accounts[[]]?.cpu, 2)
        XCTAssertEqual(window.open, [])
    }

    func testAWindowClosedWhileAPartIsOpenLosesThePartsLaterWork() async throws {
        let clock = Counters()
        let ledger = clock.ledger()
        let inside = Gate(), closed = Gate()
        async let sweep: Void = ledger.measure(.health) {
            clock.spend(cpu: 6)
            inside.open()
            await closed.wait()
            clock.spend(cpu: 9)
        }
        await inside.wait()
        let first = try Window(XCTUnwrap(ledger.closeWindow()))
        closed.open()
        await sweep
        let second = try Window(XCTUnwrap(ledger.closeWindow()))
        XCTAssertEqual(first.accounts[["health"]]?.cpu, 6)
        XCTAssertEqual(first.open, ["health"])
        XCTAssertEqual(second.accounts[["health"]]?.cpu, 9)
        XCTAssertEqual(second.intervals, [:])
        XCTAssertEqual(second.open, [])
    }

    func testACounterThatRunsBackwardsWrapsIntoAHugeDelta() throws {
        let clock = Counters()
        let ledger = clock.ledger()
        clock.spend(cpu: 50)
        ledger.measure(.usage) { clock.reading.cpuNanoseconds -= 40 }
        let window = try Window(XCTUnwrap(ledger.closeWindow()))
        XCTAssertEqual(window.accounts[["usage"]]?.cpu, 0)
        XCTAssertEqual(window.accounts[[]]?.cpu, 50)
    }

    func testCPUEnergyTheKernelNeverStatedReadsAsZeroJoules() throws {
        let clock = Counters()
        let ledger = clock.ledger()
        ledger.measure(.location) { clock.spend(cpu: 8) }
        let silent = try Window(XCTUnwrap(ledger.closeWindow()))
        XCTAssertEqual(silent.raw["energy_stated"], .bool(false))
        XCTAssertEqual(silent.account(["location"])?["energy_nj"], .null)

        ledger.measure(.location) { clock.spend(cpu: 8, energy: 900) }
        let stated = try Window(XCTUnwrap(ledger.closeWindow()))
        XCTAssertEqual(stated.raw["energy_stated"], .bool(true))
        XCTAssertEqual(stated.account(["location"])?["energy_nj"], .unsigned(900))
    }


    func testAHoldIsLostOrCountedTwiceAcrossAWindow() throws {
        let clock = Counters()
        let ledger = clock.ledger()
        ledger.hold("location.precise", setting: "10")
        clock.elapse(seconds: 60)
        ledger.hold("location.precise", setting: "10")
        clock.elapse(seconds: 40)
        let first = try Window(XCTUnwrap(ledger.closeWindow()))
        clock.elapse(seconds: 30)
        ledger.hold("location.precise", setting: nil)
        clock.elapse(seconds: 500)
        let second = try Window(XCTUnwrap(ledger.closeWindow()))
        XCTAssertEqual(first.held["location.precise@10"], 100_000_000_000)
        XCTAssertEqual(second.held["location.precise@10"], 30_000_000_000)
    }

    func testAChangedSettingKeepsBillingTheOldOne() throws {
        let clock = Counters()
        let ledger = clock.ledger()
        ledger.hold("location.precise", setting: "10")
        clock.elapse(seconds: 5)
        ledger.hold("location.precise", setting: "3000")
        clock.elapse(seconds: 7)
        let window = try Window(XCTUnwrap(ledger.closeWindow()))
        XCTAssertEqual(window.held, ["location.precise@10": 5_000_000_000, "location.precise@3000": 7_000_000_000])
    }

    func testWakesAndTransfersLeakIntoTheNextWindow() throws {
        let clock = Counters()
        let ledger = clock.ledger()
        ledger.wake("location")
        ledger.wake("location")
        ledger.wake("background_refresh")
        ledger.transfer(.shipping, interface: "cellular", sentBytes: 1_000, receivedBytes: 20)
        ledger.transfer(.shipping, interface: "cellular", sentBytes: 500, receivedBytes: 10)
        ledger.transfer(.shipping, interface: "other", sentBytes: 7, receivedBytes: 3)
        let first = try Window(XCTUnwrap(ledger.closeWindow()))
        let second = try Window(XCTUnwrap(ledger.closeWindow()))
        XCTAssertEqual(first.raw["wakes"], .object(["location": .integer(2), "background_refresh": .integer(1)]))
        XCTAssertEqual(first.raw["transfers"], .array([
            .object(["part": .string("shipping"), "interface": .string("cellular"), "tasks": .integer(2),
                     "sent_bytes": .unsigned(1_500), "received_bytes": .unsigned(30)]),
            .object(["part": .string("shipping"), "interface": .string("other"), "tasks": .integer(1),
                     "sent_bytes": .unsigned(7), "received_bytes": .unsigned(3)]),
        ]))
        XCTAssertEqual(second.raw["wakes"], .object([:]))
        XCTAssertEqual(second.raw["transfers"], .array([]))
    }


    func testAWindowIsWrittenBeforeTheStoreIsAttachedOrOutOfOrder() async throws {
        let clock = Counters()
        let ledger = clock.ledger(windowSeconds: 900)
        let store = try CaptureStore(root: try temporaryDirectory())
        ledger.measure(.location) { clock.spend(cpu: 1) }
        clock.elapse(seconds: 1_000)
        ledger.measure(.location) { clock.spend(cpu: 1) }
        ledger.record(kind: "power_state", payload: .object(["battery_level": .number(0.5)]), at: clock.wall)
        let none = try await store.entries(domain: .energy)
        XCTAssertEqual(none.count, 0)

        ledger.attach(store)
        await ledger.written()
        clock.elapse(seconds: 10)
        ledger.measure(.motion) { clock.spend(cpu: 2) }
        clock.elapse(seconds: 100)
        ledger.measure(.motion) { clock.spend(cpu: 2) }
        await ledger.flush()
        let entries = try await store.entries(domain: .energy)
        XCTAssertEqual(entries.map(\.kind), ["power_state", "parts", "parts"])
        let first = try Window(entries[1].payload), second = try Window(entries[2].payload)
        XCTAssertEqual(first.accounts[["location"]]?.cpu, 2)
        XCTAssertNil(first.accounts[["motion"]])
        XCTAssertEqual(first.elapsed, 1_000_000_000_000)
        XCTAssertEqual(second.accounts[["motion"]]?.cpu, 4)
        XCTAssertEqual(second.elapsed, 110_000_000_000)
        XCTAssertEqual(second.window["start"], first.window["end"])
        XCTAssertEqual(first.intervals["energy"], 1)
        XCTAssertEqual(second.intervals["energy"], 1)
    }

    func testTheStoresLevelsAreMissingFromTheFirstWindowOrRepeatedInTheSecond() async throws {
        let clock = Counters()
        let ledger = clock.ledger()
        let store = try CaptureStore(root: try temporaryDirectory())
        for _ in 0..<3 {
            _ = try await store.append(domain: .location, draft: CaptureDraft(
                kind: "lifecycle", observedAt: CaptureTime.rfc3339(clock.wall), payload: .object([:])))
        }
        _ = try await store.append(domain: .health, draft: CaptureDraft(
            kind: "recorder_event", observedAt: CaptureTime.rfc3339(clock.wall), payload: .object([:])))
        let levels = try await store.levels()

        ledger.attach(store, levels: levels)
        await ledger.flush()
        ledger.measure(.motion) { clock.spend(cpu: 1) }
        await ledger.flush()
        let windows = try await store.entries(domain: .energy).filter { $0.kind == "parts" }
        XCTAssertEqual(windows.count, 2)
        let first = try Window(windows[0].payload).counts, second = try Window(windows[1].payload).counts
        XCTAssertEqual(first["store_level_rows_location"], 3)
        XCTAssertEqual(first["store_level_rows_health"], 1)
        XCTAssertNil(first["store_level_rows_motion"])
        let bytes = try XCTUnwrap(first["store_level_bytes"])
        XCTAssertGreaterThan(bytes, 0)
        XCTAssertNil(second["store_level_bytes"])
        XCTAssertNil(second["store_level_rows_location"])
    }

    func testTheKernelReadingIsNotTheProcesssOwn() {
        let before = EnergyReading.kernel()
        var spin = 0.0
        for index in 0..<3_000_000 { spin += sqrt(Double(index)) }
        XCTAssertGreaterThan(spin, 0)
        let after = EnergyReading.kernel()
        XCTAssertGreaterThan(after.cpuNanoseconds, before.cpuNanoseconds)
        XCTAssertGreaterThan(after.monotonicNanoseconds, before.monotonicNanoseconds)
        XCTAssertGreaterThanOrEqual(after.interruptWakeups, before.interruptWakeups)
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("energy-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
}

private final class Counters: @unchecked Sendable {
    private let lock = NSLock()
    private var current = EnergyReading(
        monotonicNanoseconds: 1_000_000_000, cpuNanoseconds: 0, performanceCPUNanoseconds: 0,
        energyNanojoules: 0, interruptWakeups: 0, idleWakeups: 0)
    private var start = Date(timeIntervalSince1970: 1_791_000_000)

    var reading: EnergyReading {
        get { lock.withLock { current } }
        set { lock.withLock { current = newValue } }
    }
    var wall: Date { lock.withLock { start.addingTimeInterval(Double(current.monotonicNanoseconds - 1_000_000_000) / 1e9) } }

    func spend(cpu: UInt64, energy: UInt64 = 0) {
        lock.withLock {
            current.cpuNanoseconds += cpu
            current.performanceCPUNanoseconds += cpu / 2
            current.energyNanojoules += energy
            current.interruptWakeups += 1
        }
    }

    func elapse(seconds: UInt64) {
        lock.withLock { current.monotonicNanoseconds += seconds * 1_000_000_000 }
    }

    func ledger(windowSeconds: Double = 900) -> EnergyLedger {
        EnergyLedger(windowSeconds: windowSeconds, read: { [self] in reading }, now: { [self] in wall })
    }
}

private final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        let resumed: [CheckedContinuation<Void, Never>] = lock.withLock {
            opened = true
            defer { waiters = [] }
            return waiters
        }
        resumed.forEach { $0.resume() }
    }

    func wait() async {
        await withCheckedContinuation { continuation in
            let now: Bool = lock.withLock {
                if opened { return true }
                waiters.append(continuation)
                return false
            }
            if now { continuation.resume() }
        }
    }
}

private struct Window {
    struct Totals { let cpu: UInt64 }

    static func count(_ value: JSONValue?) -> UInt64? {
        switch value {
        case .unsigned(let n)?: return n
        case .integer(let n)? where n >= 0: return UInt64(n)
        default: return nil
        }
    }
    let raw: [String: JSONValue]

    init(_ payload: JSONValue) throws {
        guard case .object(let object) = payload else { throw CaptureError.invalidEntry("a window is an object") }
        raw = object
    }

    var window: [String: JSONValue] { if case .object(let o)? = raw["window"] { return o }; return [:] }
    var elapsed: UInt64? { Self.count(window["elapsed_ns"]) }

    var accounts: [[String]: Totals] {
        guard case .array(let list)? = raw["accounts"] else { return [:] }
        var out: [[String]: Totals] = [:]
        for case .object(let account) in list {
            guard case .array(let parts)? = account["parts"], let cpu = Self.count(account["cpu_ns"]) else { continue }
            out[parts.compactMap { if case .string(let s) = $0 { return s }; return nil }] = Totals(cpu: cpu)
        }
        return out
    }

    func account(_ parts: [String]) -> [String: JSONValue]? {
        guard case .array(let list)? = raw["accounts"] else { return nil }
        for case .object(let account) in list where account["parts"] == .array(parts.map(JSONValue.string)) { return account }
        return nil
    }

    var processCPU: UInt64 {
        guard case .object(let process)? = raw["process"], case .object(let start)? = process["start"],
              case .object(let end)? = process["end"], let a = Self.count(start["cpu_ns"]),
              let b = Self.count(end["cpu_ns"]) else { return 0 }
        return b - a
    }

    var counts: [String: Int] {
        guard case .object(let o)? = raw["counts"] else { return [:] }
        return o.compactMapValues { if case .integer(let n) = $0 { return Int(n) }; return nil }
    }

    var intervals: [String: Int] {
        guard case .object(let o)? = raw["intervals"] else { return [:] }
        return o.compactMapValues { if case .integer(let n) = $0 { return Int(n) }; return nil }
    }

    var open: [String] {
        guard case .array(let list)? = raw["open"] else { return [] }
        return list.compactMap { if case .string(let s) = $0 { return s }; return nil }
    }

    var held: [String: UInt64] {
        guard case .array(let list)? = raw["holds"] else { return [:] }
        var out: [String: UInt64] = [:]
        for case .object(let hold) in list {
            if case .string(let resource)? = hold["resource"], case .string(let setting)? = hold["setting"],
               let ns = Self.count(hold["held_ns"]) { out["\(resource)@\(setting)"] = ns }
        }
        return out
    }
}
