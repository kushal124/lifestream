import Darwin
import DeviceFiles

public enum ResourcePart: Hashable, Sendable {
    case capture, ocr, accessibility, browserPages, publish, videoCompaction, textCompaction, runtimeStatus
    case inputTap, inputLog, inputLookup, audioMic, audioSound, deviceUse, machineEvents
    case shipping(String?)
    case menuBar

    public var name: String {
        switch self {
        case .capture: return "capture"
        case .ocr: return "ocr"
        case .accessibility: return "accessibility"
        case .browserPages: return "browser_pages"
        case .publish: return "publish"
        case .videoCompaction: return "video_compaction"
        case .textCompaction: return "text_compaction"
        case .runtimeStatus: return "runtime_status"
        case .inputTap: return "input_tap"
        case .inputLog: return "input_log"
        case .inputLookup: return "input_lookup"
        case .audioMic: return "audio_mic"
        case .audioSound: return "audio_sound"
        case .deviceUse: return "device_use"
        case .machineEvents: return "machine_events"
        case .shipping(let domain): return domain.map { "shipping:\($0)" } ?? "shipping"
        case .menuBar: return "menu_bar"
        }
    }

    public var rank: Int {
        switch self {
        case .capture: return 0
        case .ocr: return 1
        case .accessibility: return 2
        case .browserPages: return 3
        case .publish: return 4
        case .videoCompaction: return 5
        case .textCompaction: return 6
        case .runtimeStatus: return 7
        case .inputTap: return 8
        case .inputLog: return 9
        case .inputLookup: return 10
        case .audioMic: return 11
        case .audioSound: return 12
        case .deviceUse: return 13
        case .machineEvents: return 14
        case .shipping: return 15
        case .menuBar: return 16
        }
    }

    static let rankCount = 17

    var slot: Int? {
        if case .shipping = self { return nil }
        return rank
    }

    static func fixed(_ rank: Int) -> ResourcePart {
        [.capture, .ocr, .accessibility, .browserPages, .publish, .videoCompaction, .textCompaction, .runtimeStatus,
         .inputTap, .inputLog, .inputLookup, .audioMic, .audioSound, .deviceUse, .machineEvents, .shipping(nil),
         .menuBar][rank]
    }
}

public enum ResourceCounter: Int, CaseIterable, Sendable {
    case frames, gaps, ocrRequests, ocrTilesReused, ocrTilesRecalled, ocrHelperLifts, ocrHelperRestarts, ocrReadsFailed, axCalls, lookupAXCalls, inputEventsRaw, inputEventsWritten
    case flushFull, flushBarrier, flushData, bytesWritten, shipperRuns, bundlesShipped, bytesShipped
    case audioMicMs, audioSoundMs, deviceReads, resourceLinesDropped

    public var name: String {
        switch self {
        case .frames: return "frames"
        case .gaps: return "gaps"
        case .ocrRequests: return "ocr_requests"
        case .ocrTilesReused: return "ocr_tiles_reused"
        case .ocrTilesRecalled: return "ocr_tiles_recalled"
        case .ocrHelperLifts: return "ocr_helper_lifts"
        case .ocrHelperRestarts: return "ocr_helper_restarts"
        case .ocrReadsFailed: return "ocr_reads_failed"
        case .axCalls: return "ax_calls"
        case .lookupAXCalls: return "lookup_ax_calls"
        case .inputEventsRaw: return "input_events_raw"
        case .inputEventsWritten: return "input_events_written"
        case .flushFull: return "flush_full"
        case .flushBarrier: return "flush_barrier"
        case .flushData: return "flush_data"
        case .bytesWritten: return "bytes_written"
        case .shipperRuns: return "shipper_runs"
        case .bundlesShipped: return "bundles_shipped"
        case .bytesShipped: return "bytes_shipped"
        case .audioMicMs: return "audio_mic_ms"
        case .audioSoundMs: return "audio_sound_ms"
        case .deviceReads: return "device_reads"
        case .resourceLinesDropped: return "resource_lines_dropped"
        }
    }
}

public struct ResourceTotals: Equatable, Sendable {
    public var cpuNs: UInt64
    public var wallNs: UInt64
    public var n: UInt64

    public init(cpuNs: UInt64 = 0, wallNs: UInt64 = 0, n: UInt64 = 0) {
        self.cpuNs = cpuNs
        self.wallNs = wallNs
        self.n = n
    }
}

public struct ResourceMinute: Equatable, Sendable {
    public var work: [ResourcePart: ResourceTotals]
    public var counts: [ResourceCounter: UInt64]

    public init(work: [ResourcePart: ResourceTotals] = [:], counts: [ResourceCounter: UInt64] = [:]) {
        self.work = work
        self.counts = counts
    }
}

public final class ResourceMeter: @unchecked Sendable {
    public static let shared: ResourceMeter = {
        let meter = ResourceMeter()
        DeviceFiles.meter = { meter.count($0) }
        return meter
    }()

    private let lock: UnsafeMutablePointer<os_unfair_lock>
    private var parts: [ResourceTotals]
    private var shipping: [String?: ResourceTotals] = [:]
    private var counts: [UInt64]

    public init() {
        lock = .allocate(capacity: 1)
        lock.initialize(to: os_unfair_lock())
        parts = Array(repeating: ResourceTotals(), count: ResourcePart.rankCount)
        counts = Array(repeating: 0, count: ResourceCounter.allCases.count)
    }

    deinit {
        lock.deinitialize(count: 1)
        lock.deallocate()
    }

    public func measure<T>(_ part: ResourcePart, units: Int = 1, _ body: () throws -> T) rethrows -> T {
        let nested = Self.nested()
        let outer = nested.pointee
        nested.pointee = Nested()
        let cpu = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
        let wall = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        defer {
            let spentWall = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) &- wall
            let spentCPU = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) &- cpu
            let inner = nested.pointee
            nested.pointee = Nested(cpu: outer.cpu &+ spentCPU, wall: outer.wall &+ spentWall)
            add(part, cpu: spentCPU > inner.cpu ? spentCPU - inner.cpu : 0,
                wall: spentWall > inner.wall ? spentWall - inner.wall : 0, units: units)
        }
        return try body()
    }

    public func count(_ part: ResourcePart, units: Int) {
        add(part, cpu: 0, wall: 0, units: units)
    }

    public func count(_ counter: ResourceCounter, _ amount: Int = 1) {
        guard amount > 0 else { return }
        os_unfair_lock_lock(lock)
        counts[counter.rawValue] &+= UInt64(amount)
        os_unfair_lock_unlock(lock)
    }

    func count(_ metered: DeviceFiles.Metered) {
        switch metered {
        case .written(let bytes): count(.bytesWritten, bytes)
        case .flush(.data): count(.flushData)
        case .flush(.barrier): count(.flushBarrier)
        case .flush(.full): count(.flushFull)
        }
    }

    public func take() -> ResourceMinute {
        var heldParts = Array(repeating: ResourceTotals(), count: ResourcePart.rankCount)
        var heldShipping: [String?: ResourceTotals] = [:]
        var heldCounts = [UInt64](repeating: 0, count: ResourceCounter.allCases.count)
        os_unfair_lock_lock(lock)
        swap(&heldParts, &parts)
        swap(&heldShipping, &shipping)
        swap(&heldCounts, &counts)
        os_unfair_lock_unlock(lock)
        var minute = ResourceMinute()
        for (rank, totals) in heldParts.enumerated() where totals.n > 0 {
            minute.work[ResourcePart.fixed(rank)] = totals
        }
        for (domain, totals) in heldShipping where totals.n > 0 {
            minute.work[.shipping(domain)] = totals
        }
        for counter in ResourceCounter.allCases where heldCounts[counter.rawValue] > 0 {
            minute.counts[counter] = heldCounts[counter.rawValue]
        }
        return minute
    }

    private func add(_ part: ResourcePart, cpu: UInt64, wall: UInt64, units: Int) {
        let n = UInt64(max(0, units))
        os_unfair_lock_lock(lock)
        if let slot = part.slot {
            parts[slot].cpuNs &+= cpu
            parts[slot].wallNs &+= wall
            parts[slot].n &+= n
        } else if case .shipping(let domain) = part {
            var totals = shipping[domain] ?? ResourceTotals()
            totals.cpuNs &+= cpu
            totals.wallNs &+= wall
            totals.n &+= n
            shipping[domain] = totals
        }
        os_unfair_lock_unlock(lock)
    }


    struct Nested {
        var cpu: UInt64 = 0
        var wall: UInt64 = 0
    }

    private static let nestingKey: pthread_key_t = {
        var key = pthread_key_t()
        pthread_key_create(&key) { $0.deallocate() }
        return key
    }()

    private static func nested() -> UnsafeMutablePointer<Nested> {
        if let slot = pthread_getspecific(nestingKey) { return slot.assumingMemoryBound(to: Nested.self) }
        let slot = UnsafeMutablePointer<Nested>.allocate(capacity: 1)
        slot.initialize(to: Nested())
        pthread_setspecific(nestingKey, slot)
        return slot
    }
}
