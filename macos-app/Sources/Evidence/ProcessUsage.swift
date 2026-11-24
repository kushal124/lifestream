import Darwin
import Foundation

public struct ProcessUsage: Codable, Equatable, Sendable {
    public struct QoSTimes: Codable, Equatable, Sendable {
        public var background: UInt64 = 0
        public var utility: UInt64 = 0
        public var `default`: UInt64 = 0
        public var userInitiated: UInt64 = 0
        public var userInteractive: UInt64 = 0
        public var legacy: UInt64 = 0
        public var maintenance: UInt64 = 0

        enum CodingKeys: String, CodingKey {
            case background, utility, `default`, legacy, maintenance
            case userInitiated = "user_initiated"
            case userInteractive = "user_interactive"
        }

        public init() {}
    }

    public var cpuNs: UInt64 = 0
    public var cpuNsByQoS = QoSTimes()
    public var energyNj: UInt64 = 0
    public var instructions: UInt64 = 0
    public var cycles: UInt64 = 0
    public var diskReadBytes: UInt64 = 0
    public var diskWriteBytes: UInt64 = 0
    public var logicalWriteBytes: UInt64 = 0
    public var interruptWakeups: UInt64 = 0
    public var idleWakeups: UInt64 = 0
    public var footprintBytes: UInt64 = 0
    public var threads: UInt64 = 0

    enum CodingKeys: String, CodingKey {
        case instructions, cycles, threads
        case cpuNs = "cpu_ns"
        case cpuNsByQoS = "cpu_ns_by_qos"
        case energyNj = "energy_nj"
        case diskReadBytes = "disk_read_bytes"
        case diskWriteBytes = "disk_write_bytes"
        case logicalWriteBytes = "logical_write_bytes"
        case interruptWakeups = "interrupt_wakeups"
        case idleWakeups = "idle_wakeups"
        case footprintBytes = "footprint_bytes"
    }

    public init() {}

    public func since(_ earlier: ProcessUsage) -> ProcessUsage {
        func delta(_ now: UInt64, _ then: UInt64) -> UInt64 { now >= then ? now - then : 0 }
        var result = self
        result.cpuNs = delta(cpuNs, earlier.cpuNs)
        result.cpuNsByQoS.background = delta(cpuNsByQoS.background, earlier.cpuNsByQoS.background)
        result.cpuNsByQoS.utility = delta(cpuNsByQoS.utility, earlier.cpuNsByQoS.utility)
        result.cpuNsByQoS.default = delta(cpuNsByQoS.default, earlier.cpuNsByQoS.default)
        result.cpuNsByQoS.userInitiated = delta(cpuNsByQoS.userInitiated, earlier.cpuNsByQoS.userInitiated)
        result.cpuNsByQoS.userInteractive = delta(cpuNsByQoS.userInteractive, earlier.cpuNsByQoS.userInteractive)
        result.cpuNsByQoS.legacy = delta(cpuNsByQoS.legacy, earlier.cpuNsByQoS.legacy)
        result.cpuNsByQoS.maintenance = delta(cpuNsByQoS.maintenance, earlier.cpuNsByQoS.maintenance)
        result.energyNj = delta(energyNj, earlier.energyNj)
        result.instructions = delta(instructions, earlier.instructions)
        result.cycles = delta(cycles, earlier.cycles)
        result.diskReadBytes = delta(diskReadBytes, earlier.diskReadBytes)
        result.diskWriteBytes = delta(diskWriteBytes, earlier.diskWriteBytes)
        result.logicalWriteBytes = delta(logicalWriteBytes, earlier.logicalWriteBytes)
        result.interruptWakeups = delta(interruptWakeups, earlier.interruptWakeups)
        result.idleWakeups = delta(idleWakeups, earlier.idleWakeups)
        return result
    }

    public func adding(_ later: ProcessUsage) -> ProcessUsage {
        var result = later
        result.cpuNs += cpuNs
        result.cpuNsByQoS.background += cpuNsByQoS.background
        result.cpuNsByQoS.utility += cpuNsByQoS.utility
        result.cpuNsByQoS.default += cpuNsByQoS.default
        result.cpuNsByQoS.userInitiated += cpuNsByQoS.userInitiated
        result.cpuNsByQoS.userInteractive += cpuNsByQoS.userInteractive
        result.cpuNsByQoS.legacy += cpuNsByQoS.legacy
        result.cpuNsByQoS.maintenance += cpuNsByQoS.maintenance
        result.energyNj += energyNj
        result.instructions += instructions
        result.cycles += cycles
        result.diskReadBytes += diskReadBytes
        result.diskWriteBytes += diskWriteBytes
        result.logicalWriteBytes += logicalWriteBytes
        result.interruptWakeups += interruptWakeups
        result.idleWakeups += idleWakeups
        return result
    }
}

extension ProcessUsage {
    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    private static func nanoseconds(_ ticks: UInt64) -> UInt64 {
        let numer = UInt64(timebase.numer), denom = UInt64(max(timebase.denom, 1))
        return ticks / denom * numer + ticks % denom * numer / denom
    }

    public static func read(pid: pid_t) -> ProcessUsage? {
        var info = rusage_info_v6()
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
                proc_pid_rusage(pid, RUSAGE_INFO_V6, $0)
            }
        }
        guard status == 0 else { return nil }
        var task = proc_taskinfo()
        let size = Int32(MemoryLayout<proc_taskinfo>.size)
        let threads = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &task, size) == size ? UInt64(task.pti_threadnum) : 0
        var usage = ProcessUsage()
        usage.cpuNs = nanoseconds(info.ri_user_time + info.ri_system_time)
        usage.cpuNsByQoS.background = nanoseconds(info.ri_cpu_time_qos_background)
        usage.cpuNsByQoS.utility = nanoseconds(info.ri_cpu_time_qos_utility)
        usage.cpuNsByQoS.default = nanoseconds(info.ri_cpu_time_qos_default)
        usage.cpuNsByQoS.userInitiated = nanoseconds(info.ri_cpu_time_qos_user_initiated)
        usage.cpuNsByQoS.userInteractive = nanoseconds(info.ri_cpu_time_qos_user_interactive)
        usage.cpuNsByQoS.legacy = nanoseconds(info.ri_cpu_time_qos_legacy)
        usage.cpuNsByQoS.maintenance = nanoseconds(info.ri_cpu_time_qos_maintenance)
        usage.energyNj = info.ri_energy_nj
        usage.instructions = info.ri_instructions
        usage.cycles = info.ri_cycles
        usage.diskReadBytes = info.ri_diskio_bytesread
        usage.diskWriteBytes = info.ri_diskio_byteswritten
        usage.logicalWriteBytes = info.ri_logical_writes
        usage.interruptWakeups = info.ri_interrupt_wkups
        usage.idleWakeups = info.ri_pkg_idle_wkups
        usage.footprintBytes = info.ri_phys_footprint
        usage.threads = threads
        return usage
    }
}
