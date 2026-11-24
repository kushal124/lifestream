import Evidence
import Foundation

enum ThermalLevel: Int, Comparable, Sendable {
    case nominal, fair, serious, critical

    var name: String {
        switch self {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        }
    }

    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

struct StateSeconds: Equatable, Sendable {
    var awake = 0
    var displayAwake = 0
    var unlocked = 0
    var capturing = 0
    var onBattery = 0
    var lowPower = 0
    var thermalMax = ThermalLevel.nominal
    var front: [String: Int] = [:]
}

enum ResourceLine {
    static func encode(at: Date, until: Date, build: String, pid: Int32, process: ProcessUsage?,
                       helper: ProcessUsage? = nil, minute: ResourceMinute, states: StateSeconds) -> String {
        var line = "{\"at\":\(quoted(UTCInstant.rfc3339(at))),\"until\":\(quoted(UTCInstant.rfc3339(until)))"
        line += ",\"build\":\(quoted(build)),\"pid\":\(pid)"
        if let process { line += ",\"process\":" + usage(process) }
        if let helper, helper.cpuNs > 0 || helper.energyNj > 0 { line += ",\"helper\":" + usage(helper) }
        let parts = minute.work.sorted { ($0.key.rank, $0.key.name) < ($1.key.rank, $1.key.name) }
        line += ",\"work\":{" + parts.map { part, totals in
            "\(quoted(part.name)):{\"cpu_ns\":\(totals.cpuNs),\"wall_ns\":\(totals.wallNs),\"n\":\(totals.n)}"
        }.joined(separator: ",") + "}"
        let counts = minute.counts.sorted { $0.key.rawValue < $1.key.rawValue }
        line += ",\"counts\":{" + counts.map { "\(quoted($0.key.name)):\($0.value)" }.joined(separator: ",") + "}"
        line += ",\"state\":{\"awake_s\":\(states.awake),\"display_awake_s\":\(states.displayAwake)"
        line += ",\"unlocked_s\":\(states.unlocked),\"capturing_s\":\(states.capturing)"
        line += ",\"on_battery_s\":\(states.onBattery),\"low_power_s\":\(states.lowPower)"
        line += ",\"thermal_max\":\(quoted(states.thermalMax.name)),\"front\":{"
        line += states.front.filter { $0.value > 0 }.sorted { $0.key < $1.key }
            .map { "\(quoted($0.key)):\($0.value)" }.joined(separator: ",")
        return line + "}}}\n"
    }

    private static func usage(_ u: ProcessUsage) -> String {
        var line = "{\"cpu_ns\":\(u.cpuNs),\"cpu_ns_by_qos\":{"
        line += "\"background\":\(u.cpuNsByQoS.background),\"utility\":\(u.cpuNsByQoS.utility)"
        line += ",\"default\":\(u.cpuNsByQoS.default),\"user_initiated\":\(u.cpuNsByQoS.userInitiated)"
        line += ",\"user_interactive\":\(u.cpuNsByQoS.userInteractive),\"legacy\":\(u.cpuNsByQoS.legacy)"
        line += ",\"maintenance\":\(u.cpuNsByQoS.maintenance)}"
        line += ",\"energy_nj\":\(u.energyNj),\"instructions\":\(u.instructions)"
        line += ",\"cycles\":\(u.cycles),\"disk_read_bytes\":\(u.diskReadBytes)"
        line += ",\"disk_write_bytes\":\(u.diskWriteBytes)"
        line += ",\"logical_write_bytes\":\(u.logicalWriteBytes)"
        line += ",\"interrupt_wakeups\":\(u.interruptWakeups),\"idle_wakeups\":\(u.idleWakeups)"
        line += ",\"footprint_bytes\":\(u.footprintBytes),\"threads\":\(u.threads)}"
        return line
    }

    static func quoted(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case _ where scalar.value < 0x20: out += String(format: "\\u%04x", scalar.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }
}
