import Darwin
import Foundation

enum Launchd {
    struct Job: Equatable {
        let submittedByApp: Bool
        let build: String?
        let refused: Bool
        let tried: Bool
    }

    static var domain: String { "gui/\(getuid())" }

    static func job(_ label: String) -> Job? {
        guard let text = launchctl(["print", "\(domain)/\(label)"]) else { return nil }
        return parse(text)
    }

    static func parse(_ text: String) -> Job {
        var members: [String: String] = [:]
        for line in text.split(separator: "\n") where line.hasPrefix("\t") && !line.hasPrefix("\t\t") {
            let parts = line.dropFirst().split(separator: "=", maxSplits: 1)
            guard parts.count == 2 else { continue }
            members[parts[0].trimmingCharacters(in: .whitespaces)] = parts[1].trimmingCharacters(in: .whitespaces)
        }
        let running = members["pid"].flatMap { Int32($0) } != nil
        let refused = members["job state"] == "spawn failed" || (!running && members["last exit code"]?.hasPrefix("78:") == true)
        let exited = members["last exit code"].map { $0 != "(never exited)" } ?? false
        return Job(submittedByApp: members["managed_by"] == "com.apple.xpc.ServiceManagement",
                   build: members["parent bundle version"], refused: refused, tried: running || refused || exited)
    }

    static func kickstart(_ label: String, within seconds: TimeInterval, kill: Bool = false) async {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["kickstart"] + (kill ? ["-k"] : []) + ["\(domain)/\(label)"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return }
        let deadline = Date().addingTimeInterval(seconds)
        while process.isRunning, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(100))
        }
        if process.isRunning { process.terminate() }
    }

    static func kickstartWaiting(_ label: String, within seconds: TimeInterval) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["kickstart", "\(domain)/\(label)"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let ended = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in ended.signal() }
        guard (try? process.run()) != nil else { return }
        if ended.wait(timeout: .now() + seconds) == .timedOut { process.terminate() }
    }

    static func signal(_ label: String, _ name: String) {
        _ = launchctl(["kill", name, "\(domain)/\(label)"])
    }

    private static func launchctl(_ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
    }
}
