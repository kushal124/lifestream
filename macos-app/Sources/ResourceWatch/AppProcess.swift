import Evidence
import Darwin
import Foundation

public struct AppReading: Equatable, Sendable {
    public var pid: pid_t
    public var started: Date
    public var build: String
    public var usage: ProcessUsage

    public init(pid: pid_t, started: Date, build: String, usage: ProcessUsage) {
        self.pid = pid
        self.started = started
        self.build = build
        self.usage = usage
    }
}

public final class AppProcessFinder {
    public static let buildKey = "LifestreamCommit"

    private let bundle: URL
    private let executable: String
    private var current: (pid: pid_t, started: Date, build: String)?

    public init(bundle: URL) {
        self.bundle = realpath(bundle.path, nil).map { resolved in
            defer { free(resolved) }
            return URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
        } ?? bundle
        executable = self.bundle.appendingPathComponent("Contents/MacOS/Lifestream").path
    }

    public func read() -> AppReading? {
        if let known = current, Self.started(known.pid) == known.started,
           let usage = ProcessUsage.read(pid: known.pid) {
            return AppReading(pid: known.pid, started: known.started, build: known.build, usage: usage)
        }
        current = nil
        guard let found = scan(), let usage = ProcessUsage.read(pid: found.pid) else { return nil }
        let build = Self.build(of: bundle)
        current = (found.pid, found.started, build)
        return AppReading(pid: found.pid, started: found.started, build: build, usage: usage)
    }

    private func scan() -> (pid: pid_t, started: Date)? {
        let own = getpid()
        var capacity = Int(proc_listallpids(nil, 0)) + 64
        var pids = [pid_t](repeating: 0, count: max(capacity, 64))
        capacity = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size)))
        var path = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
        var best: (pid: pid_t, started: Date)?
        for pid in pids.prefix(max(capacity, 0)) where pid > 0 && pid != own {
            guard proc_pidpath(pid, &path, UInt32(path.count)) > 0,
                  String(cString: path) == executable,
                  Self.runsApp(pid), let started = Self.started(pid) else { continue }
            if best == nil || started < best!.started { best = (pid, started) }
        }
        return best
    }

    private static func started(_ pid: pid_t) -> Date? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return Date(timeIntervalSince1970: Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1_000_000)
    }

    private static func runsApp(_ pid: pid_t) -> Bool {
        guard let arguments = arguments(pid) else { return false }
        guard arguments.count > 1 else { return true }
        let first = arguments[1]
        return first == "app" || first.hasPrefix("--") || first.hasPrefix("-psn_")
    }

    static func arguments(_ pid: pid_t) -> [String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0 else { return nil }
        return parseArguments(Array(buffer.prefix(size)))
    }

    static func parseArguments(_ bytes: [UInt8]) -> [String]? {
        guard bytes.count > 4 else { return nil }
        let argc = Int(Int32(littleEndian: bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }))
        var index = 4
        while index < bytes.count, bytes[index] != 0 { index += 1 }
        while index < bytes.count, bytes[index] == 0 { index += 1 }
        var arguments: [String] = []
        while arguments.count < argc, index < bytes.count {
            let end = bytes[index...].firstIndex(of: 0) ?? bytes.count
            arguments.append(String(decoding: bytes[index..<end], as: UTF8.self))
            index = end + 1
        }
        return arguments.count == argc ? arguments : nil
    }

    static func build(of bundle: URL) -> String {
        let plist = bundle.appendingPathComponent("Contents/Info.plist")
        guard let data = try? Data(contentsOf: plist),
              let values = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let commit = values[buildKey] as? String, !commit.isEmpty else { return "unknown" }
        return commit
    }
}
