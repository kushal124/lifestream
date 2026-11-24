import Darwin
import Foundation
import Synchronization
import os

public enum EnergyPart: String, CaseIterable, Sendable {
    case location, motion, health, photos, contacts, usage, shipping, checkin, places, energy
}

public struct EnergyReading: Sendable, Equatable {
    public var monotonicNanoseconds: UInt64
    public var cpuNanoseconds: UInt64
    public var performanceCPUNanoseconds: UInt64
    public var energyNanojoules: UInt64
    public var interruptWakeups: UInt64
    public var idleWakeups: UInt64

    public init(
        monotonicNanoseconds: UInt64, cpuNanoseconds: UInt64, performanceCPUNanoseconds: UInt64,
        energyNanojoules: UInt64, interruptWakeups: UInt64, idleWakeups: UInt64
    ) {
        self.monotonicNanoseconds = monotonicNanoseconds
        self.cpuNanoseconds = cpuNanoseconds
        self.performanceCPUNanoseconds = performanceCPUNanoseconds
        self.energyNanojoules = energyNanojoules
        self.interruptWakeups = interruptWakeups
        self.idleWakeups = idleWakeups
    }

    public static func kernel() -> EnergyReading {
        var info = task_power_info_v2()
        var count = mach_msg_type_number_t(MemoryLayout<task_power_info_v2>.size / MemoryLayout<natural_t>.size)
        let status = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_POWER_INFO_V2), $0, &count)
            }
        }
        let monotonic = clock_gettime_nsec_np(CLOCK_MONOTONIC)
        guard status == KERN_SUCCESS else {
            return EnergyReading(monotonicNanoseconds: monotonic, cpuNanoseconds: 0, performanceCPUNanoseconds: 0,
                energyNanojoules: 0, interruptWakeups: 0, idleWakeups: 0)
        }
        #if arch(arm64)
        let energy = info.task_energy
        #else
        let energy: UInt64 = 0
        #endif
        return EnergyReading(
            monotonicNanoseconds: monotonic,
            cpuNanoseconds: nanoseconds(info.cpu_energy.total_user &+ info.cpu_energy.total_system),
            performanceCPUNanoseconds: nanoseconds(info.task_ptime),
            energyNanojoules: energy,
            interruptWakeups: info.cpu_energy.task_interrupt_wakeups,
            idleWakeups: info.cpu_energy.task_platform_idle_wakeups)
    }

    private static let timebase: (numer: UInt64, denom: UInt64) = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return (UInt64(info.numer), UInt64(max(info.denom, 1)))
    }()

    private static func nanoseconds(_ ticks: UInt64) -> UInt64 {
        (ticks / timebase.denom) &* timebase.numer &+ (ticks % timebase.denom) &* timebase.numer / timebase.denom
    }

    func delta(to later: EnergyReading) -> EnergyTotals {
        func since(_ path: KeyPath<EnergyReading, UInt64>) -> UInt64 {
            later[keyPath: path] >= self[keyPath: path] ? later[keyPath: path] - self[keyPath: path] : 0
        }
        return EnergyTotals(
            elapsed: since(\.monotonicNanoseconds), cpu: since(\.cpuNanoseconds),
            performanceCPU: since(\.performanceCPUNanoseconds), energy: since(\.energyNanojoules),
            interruptWakeups: since(\.interruptWakeups), idleWakeups: since(\.idleWakeups))
    }

    func json(energyStated: Bool) -> JSONValue {
        .object([
            "cpu_ns": .unsigned(cpuNanoseconds), "cpu_p_ns": .unsigned(performanceCPUNanoseconds),
            "energy_nj": energyStated ? .unsigned(energyNanojoules) : .null,
            "interrupt_wakeups": .unsigned(interruptWakeups), "idle_wakeups": .unsigned(idleWakeups),
        ])
    }
}

struct EnergyTotals: Sendable, Equatable {
    var elapsed: UInt64 = 0, cpu: UInt64 = 0, performanceCPU: UInt64 = 0, energy: UInt64 = 0
    var interruptWakeups: UInt64 = 0, idleWakeups: UInt64 = 0

    static func += (left: inout EnergyTotals, right: EnergyTotals) {
        left.elapsed &+= right.elapsed; left.cpu &+= right.cpu; left.performanceCPU &+= right.performanceCPU
        left.energy &+= right.energy; left.interruptWakeups &+= right.interruptWakeups; left.idleWakeups &+= right.idleWakeups
    }
}

struct EnergyAccounts: Sendable {
    private struct Transfer: Hashable, Sendable { let part: String; let interface: String }
    private struct Hold: Hashable, Sendable { let resource: String; let setting: String }

    private(set) var start: EnergyReading
    private(set) var startWall: Date
    private var last: EnergyReading
    private var open: [EnergyPart: Int] = [:]
    private var accounts: [[String]: EnergyTotals] = [:]
    private var intervals: [EnergyPart: Int] = [:]
    private var holding: [String: (setting: String, since: UInt64)] = [:]
    private var held: [Hold: UInt64] = [:]
    private var wakes: [String: Int] = [:]
    private var transfers: [Transfer: (tasks: Int, sent: UInt64, received: UInt64)] = [:]
    private var counts: [String: Int] = [:]

    init(at reading: EnergyReading, wall: Date) {
        start = reading
        startWall = wall
        last = reading
    }

    var elapsed: UInt64 { last.monotonicNanoseconds &- start.monotonicNanoseconds }
    var windowCPU: UInt64 { last.cpuNanoseconds &- start.cpuNanoseconds }

    private mutating func advance(to reading: EnergyReading) {
        let key = open.filter { $0.value > 0 }.keys.map(\.rawValue).sorted()
        accounts[key, default: EnergyTotals()] += last.delta(to: reading)
        last = reading
    }

    mutating func begin(_ part: EnergyPart, pausing: EnergyPart?, at reading: EnergyReading) -> Bool {
        advance(to: reading)
        var paused = false
        if let pausing, let count = open[pausing], count > 0 {
            open[pausing] = count - 1
            paused = true
        }
        open[part, default: 0] += 1
        intervals[part, default: 0] += 1
        return paused
    }

    mutating func end(_ part: EnergyPart, resuming: EnergyPart?, at reading: EnergyReading) {
        advance(to: reading)
        if let count = open[part], count > 0 { open[part] = count - 1 }
        if let resuming { open[resuming, default: 0] += 1 }
    }

    mutating func hold(_ resource: String, setting: String?, at reading: EnergyReading) {
        advance(to: reading)
        if let current = holding[resource] {
            if current.setting == setting { return }
            held[Hold(resource: resource, setting: current.setting), default: 0] &+= reading.monotonicNanoseconds &- current.since
            holding[resource] = nil
        }
        if let setting { holding[resource] = (setting, reading.monotonicNanoseconds) }
    }

    mutating func wake(_ trigger: String) {
        wakes[trigger, default: 0] += 1
    }

    mutating func count(_ name: String, _ amount: Int) {
        counts[name, default: 0] += amount
    }

    mutating func transfer(_ part: EnergyPart, interface: String, sent: UInt64, received: UInt64) {
        let key = Transfer(part: part.rawValue, interface: interface)
        let prior = transfers[key] ?? (0, 0, 0)
        transfers[key] = (prior.tasks + 1, prior.sent &+ sent, prior.received &+ received)
    }

    mutating func close(
        at reading: EnergyReading, wall: Date, build: String = "unknown", threads: [EnergyThread] = []
    ) -> JSONValue {
        advance(to: reading)
        for (resource, current) in holding {
            held[Hold(resource: resource, setting: current.setting), default: 0] &+= reading.monotonicNanoseconds &- current.since
            holding[resource] = (current.setting, reading.monotonicNanoseconds)
        }
        let stated = reading.energyNanojoules > 0
        var payload: [String: JSONValue] = [
            "build": .string(build),
            "window": .object([
                "start": .string(CaptureTime.rfc3339(startWall)), "end": .string(CaptureTime.rfc3339(wall)),
                "elapsed_ns": .unsigned(reading.monotonicNanoseconds &- start.monotonicNanoseconds),
            ]),
            "process": .object(["start": start.json(energyStated: stated), "end": reading.json(energyStated: stated)]),
            "energy_stated": .bool(stated),
            "accounts": .array(accounts.sorted { $0.key.lexicographicallyPrecedes($1.key) }.map { parts, totals in
                .object([
                    "parts": .array(parts.map(JSONValue.string)), "elapsed_ns": .unsigned(totals.elapsed),
                    "cpu_ns": .unsigned(totals.cpu), "cpu_p_ns": .unsigned(totals.performanceCPU),
                    "energy_nj": stated ? .unsigned(totals.energy) : .null,
                    "interrupt_wakeups": .unsigned(totals.interruptWakeups), "idle_wakeups": .unsigned(totals.idleWakeups),
                ])
            }),
            "intervals": .object(Dictionary(uniqueKeysWithValues: intervals.map { ($0.key.rawValue, .integer(Int64($0.value))) })),
            "open": .array(open.filter { $0.value > 0 }.keys.map(\.rawValue).sorted().map(JSONValue.string)),
            "holds": .array(held.sorted { ($0.key.resource, $0.key.setting) < ($1.key.resource, $1.key.setting) }.map { hold, nanoseconds in
                .object(["resource": .string(hold.resource), "setting": .string(hold.setting), "held_ns": .unsigned(nanoseconds)])
            }),
            "wakes": .object(wakes.mapValues { .integer(Int64($0)) }),
            "transfers": .array(transfers.sorted { ($0.key.part, $0.key.interface) < ($1.key.part, $1.key.interface) }.map { key, value in
                .object([
                    "part": .string(key.part), "interface": .string(key.interface), "tasks": .integer(Int64(value.tasks)),
                    "sent_bytes": .unsigned(value.sent), "received_bytes": .unsigned(value.received),
                ])
            }),
        ]
        let counted = counts.filter { $0.value != 0 }
        if !counted.isEmpty { payload["counts"] = .object(counted.mapValues { .integer(Int64($0)) }) }
        if !threads.isEmpty {
            payload["threads"] = .array(threads.map { .object(["thread": .string($0.name), "cpu_ns": .unsigned($0.cpuNanoseconds)]) })
        }
        start = reading
        startWall = wall
        accounts = [:]
        intervals = [:]
        held = [:]
        wakes = [:]
        transfers = [:]
        counts = [:]
        return .object(payload)
    }
}

public protocol EnergySignposts: Sendable {
    func begin(_ part: EnergyPart) -> OSSignpostID
    func end(_ part: EnergyPart, _ id: OSSignpostID)
}

public final class EnergyLedger: Sendable {
    public static let shared = EnergyLedger()

    private final class Frame: Sendable {
        let part: EnergyPart
        let task: Int?
        init(_ part: EnergyPart, _ task: Int?) { self.part = part; self.task = task }
    }
    @TaskLocal private static var frame: Frame?

    private struct Entry {
        let part: EnergyPart
        let paused: EnergyPart?
        let frame: Frame
        let signpost: (any EnergySignposts, OSSignpostID)?
    }

    private struct State {
        var accounts: EnergyAccounts
        var store: CaptureStore?
        var signposts: (any EnergySignposts)?
        var waiting: [CaptureDraft] = []
        var tail: Task<Void, Never>?
        var build = "unknown"
        var threadsAtStart: [UInt64: (name: String, cpu: UInt64)] = [:]
        var mainThreadID: UInt64 = 0
    }

    private static let waitingLimit = 64
    private let window: UInt64
    private let read: @Sendable () -> EnergyReading
    private let now: @Sendable () -> Date
    private let state: Mutex<State>

    public init(
        windowSeconds: Double = 15 * 60,
        read: @escaping @Sendable () -> EnergyReading = EnergyReading.kernel,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        window = UInt64(windowSeconds * 1e9)
        self.read = read
        self.now = now
        state = Mutex(State(accounts: EnergyAccounts(at: read(), wall: now())))
    }

    public func configure(signposts: (any EnergySignposts)?, build: String = "unknown") {
        state.withLock {
            $0.signposts = signposts
            $0.build = build
            var id: UInt64 = 0
            pthread_threadid_np(nil, &id)
            $0.mainThreadID = id
            $0.threadsAtStart = EnergyThread.snapshot(mainThreadID: id)
        }
    }

    public func attach(_ store: CaptureStore, levels: [String: Int] = [:]) {
        state.withLock { state in
            for (name, level) in levels { state.accounts.count(name, level) }
            state.store = store
            let waiting = state.waiting
            state.waiting = []
            for draft in waiting { enqueue(draft, in: &state) }
        }
    }

    nonisolated(nonsending) public func measure<T>(
        _ part: EnergyPart, _ body: nonisolated(nonsending) () async throws -> T
    ) async rethrows -> T {
        guard let entry = enter(part) else { return try await body() }
        defer { leave(entry) }
        return try await Self.$frame.withValue(entry.frame, operation: body)
    }

    public func measure<T>(_ part: EnergyPart, _ body: () throws -> T) rethrows -> T {
        guard let entry = enter(part) else { return try body() }
        defer { leave(entry) }
        return try Self.$frame.withValue(entry.frame, operation: body)
    }

    public func hold(_ resource: String, setting: String?) {
        state.withLock { $0.accounts.hold(resource, setting: setting, at: read()) }
    }

    public func wake(_ trigger: String) {
        state.withLock { $0.accounts.wake(trigger) }
    }

    public func count(_ name: String, _ amount: Int = 1) {
        state.withLock { $0.accounts.count(name, amount) }
    }

    public func transfer(_ part: EnergyPart, interface: String, sentBytes: UInt64, receivedBytes: UInt64) {
        state.withLock { $0.accounts.transfer(part, interface: interface, sent: sentBytes, received: receivedBytes) }
    }

    public func record(kind: String, payload: JSONValue, at date: Date) {
        let draft = CaptureDraft(kind: kind, observedAt: CaptureTime.rfc3339(date), payload: payload)
        state.withLock { enqueue(draft, in: &$0) }
    }

    public func flush() async {
        await written()
        let tail: Task<Void, Never>? = state.withLock { state in
            guard state.store != nil else { return nil }
            enqueue(window(&state), in: &state)
            return state.tail
        }
        await tail?.value
    }

    func written() async {
        var seen: Task<Void, Never>?
        while let tail = state.withLock({ $0.tail }), tail != seen {
            await tail.value
            seen = tail
        }
    }

    func closeWindow() -> JSONValue? {
        state.withLock { state in
            let wall = now()
            return state.accounts.close(at: read(), wall: wall, build: state.build, threads: threadsSince(&state))
        }
    }

    private func enter(_ part: EnergyPart) -> Entry? {
        let task = withUnsafeCurrentTask { $0?.hashValue }
        let parent = Self.frame
        let waiting = task != nil && parent?.task == task ? parent?.part : nil
        if waiting == part { return nil }
        let (paused, signposts) = state.withLock { state in
            (state.accounts.begin(part, pausing: waiting, at: read()) ? waiting : nil, state.signposts)
        }
        return Entry(part: part, paused: paused, frame: Frame(part, task),
                     signpost: signposts.map { ($0, $0.begin(part)) })
    }

    private func leave(_ entry: Entry) {
        if let (signposts, id) = entry.signpost { signposts.end(entry.part, id) }
        state.withLock { state in
            let reading = read()
            state.accounts.end(entry.part, resuming: entry.paused, at: reading)
            if state.store != nil, state.accounts.elapsed >= window { enqueue(window(&state), in: &state) }
        }
    }

    private func window(_ state: inout State) -> CaptureDraft {
        let wall = now()
        let payload = state.accounts.close(at: read(), wall: wall, build: state.build, threads: threadsSince(&state))
        return CaptureDraft(kind: "parts", observedAt: CaptureTime.rfc3339(wall), payload: payload)
    }

    private func threadsSince(_ state: inout State) -> [EnergyThread] {
        let now = EnergyThread.snapshot(mainThreadID: state.mainThreadID)
        var byName: [String: UInt64] = [:]
        for (id, current) in now {
            let before = state.threadsAtStart[id]?.cpu ?? 0
            byName[current.name, default: 0] &+= current.cpu &- min(before, current.cpu)
        }
        let processCPU = state.accounts.windowCPU
        let live = byName.values.reduce(0, &+)
        let ended = processCPU > live ? processCPU - live : 0
        state.threadsAtStart = now
        var rows = byName.filter { $0.value > 0 }.map { EnergyThread(name: $0.key, cpuNanoseconds: $0.value) }
        rows.sort { $0.cpuNanoseconds > $1.cpuNanoseconds }
        if ended > 0 { rows.append(EnergyThread(name: "ended", cpuNanoseconds: ended)) }
        return rows
    }

    private func enqueue(_ draft: CaptureDraft, in state: inout State) {
        guard let store = state.store else {
            state.waiting.append(draft)
            if state.waiting.count > Self.waitingLimit { state.waiting.removeFirst() }
            return
        }
        let previous = state.tail
        state.tail = Task.detached { [self] in
            await previous?.value
            await measure(.energy) { _ = try? await store.append(domain: .energy, draft: draft) }
        }
    }
}

public struct EnergyThread: Sendable, Equatable {
    public let name: String
    public let cpuNanoseconds: UInt64

    static func snapshot(mainThreadID: UInt64) -> [UInt64: (name: String, cpu: UInt64)] {
        var list: thread_act_array_t?
        var count: mach_msg_type_number_t = 0
        guard task_threads(mach_task_self_, &list, &count) == KERN_SUCCESS, let list else { return [:] }
        defer {
            for index in 0..<Int(count) { mach_port_deallocate(mach_task_self_, list[index]) }
            vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: list)),
                          vm_size_t(Int(count) * MemoryLayout<thread_t>.stride))
        }
        var out: [UInt64: (name: String, cpu: UInt64)] = [:]
        for index in 0..<Int(count) {
            let thread = list[index]
            var basic = thread_basic_info()
            var basicCount = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<integer_t>.size)
            let basicResult = withUnsafeMutablePointer(to: &basic) {
                $0.withMemoryRebound(to: integer_t.self, capacity: Int(basicCount)) {
                    thread_info(thread, thread_flavor_t(THREAD_BASIC_INFO), $0, &basicCount)
                }
            }
            var ident = thread_identifier_info()
            var identCount = mach_msg_type_number_t(MemoryLayout<thread_identifier_info>.size / MemoryLayout<integer_t>.size)
            let identResult = withUnsafeMutablePointer(to: &ident) {
                $0.withMemoryRebound(to: integer_t.self, capacity: Int(identCount)) {
                    thread_info(thread, thread_flavor_t(THREAD_IDENTIFIER_INFO), $0, &identCount)
                }
            }
            guard basicResult == KERN_SUCCESS, identResult == KERN_SUCCESS else { continue }
            let cpu = (UInt64(basic.user_time.seconds) + UInt64(basic.system_time.seconds)) * 1_000_000_000
                + (UInt64(basic.user_time.microseconds) + UInt64(basic.system_time.microseconds)) * 1_000
            var name = "other"
            if let pthread = pthread_from_mach_thread_np(thread) {
                var buffer = [CChar](repeating: 0, count: 64)
                if pthread_getname_np(pthread, &buffer, buffer.count) == 0 {
                    let text = String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
                    if !text.isEmpty { name = text }
                }
            }
            if ident.thread_id == mainThreadID { name = "main" }
            out[ident.thread_id] = (name, cpu)
        }
        return out
    }
}
