import LifestreamCaptureCore
import os
import QuartzCore
import SwiftUI
import UIKit

@MainActor
enum Interaction {
    case tabSwitch, returnToFront, searchKeystroke, sheet, refresh, unlock, firstFrame

    static let subsystem = "org.lifestreamprotocol.phone"
    static let category = "Interactions"
    private static let signposter = OSSignposter(subsystem: subsystem, category: category)
    private static var open: [Interaction: (id: Int, state: OSSignpostIntervalState, began: ContinuousClock.Instant)] = [:]
    private static var begun = 0
    private static var visited: Set<AppNavigation.Tab> = []
    private static var launched = false

    private static var recording: Bool { SpeedLog.shared != nil }

    func begin() {
        guard Self.recording else { return }
        if let superseded = Self.open.removeValue(forKey: self) { Self.signposter.endInterval(name, superseded.state) }
        Self.begun += 1
        Self.open[self] = (Self.begun, Self.signposter.beginAnimationInterval(name, id: Self.signposter.makeSignpostID()), ContinuousClock.now)
    }

    func endAtCommit() {
        guard let id = Self.open[self]?.id else { return }
        Commit.next { [self] in
            guard Self.open[self]?.id == id, let (_, state, began) = Self.open.removeValue(forKey: self) else { return }
            Self.signposter.endInterval(name, state)
            var fields: [String: Any] = [:]
            if self == .tabSwitch {
                let tab = AppNavigation.shared.selectedTab
                fields = ["tab": tab.title, "first": Self.visited.insert(tab).inserted]
            }
            SpeedLog.shared?.interaction("\(name)", lasted: .now - began, fields)
        }
    }

    func discard() {
        if let open = Self.open.removeValue(forKey: self) { Self.signposter.endInterval(name, open.state) }
    }

    func mark() {
        guard Self.recording, !Self.launched else { return }
        Self.launched = true
        Self.visited.insert(AppNavigation.shared.selectedTab)
        Commit.next { [self] in
            Self.signposter.emitEvent(name)
            SpeedLog.shared?.launched()
        }
    }

    private var name: StaticString {
        switch self {
        case .tabSwitch: "Tab switch"
        case .returnToFront: "Return to front"
        case .searchKeystroke: "Search keystroke"
        case .sheet: "Sheet"
        case .refresh: "Refresh"
        case .unlock: "Unlock"
        case .firstFrame: "First frame"
        }
    }
}

@MainActor
private enum Commit {
    private static var waiting: Set<UIUpdateLink> = []

    static func next(_ action: @escaping @MainActor () -> Void) {
        guard let scene = UIApplication.shared.connectedScenes.lazy.compactMap({ $0 as? UIWindowScene }).first else { return }
        let link = UIUpdateLink(windowScene: scene)
        link.addAction(to: .afterCATransactionCommit) { link, _ in
            link.isEnabled = false
            waiting.remove(link)
            action()
        }
        link.requiresContinuousUpdates = true
        link.isEnabled = true
        waiting.insert(link)
    }
}

extension Binding where Value == String {
    @MainActor func timed(_ interaction: Interaction) -> Binding<Value> {
        Binding(get: { wrappedValue }, set: { value, transaction in
            let typed = !value.isEmpty
            if typed { interaction.begin() } else { interaction.discard() }
            self.transaction(transaction).wrappedValue = value
            if typed { interaction.endAtCommit() }
        })
    }
}

@MainActor
final class SpeedLog: NSObject {
    static let shared: SpeedLog? = ProcessInfo.processInfo.arguments.contains("--ui-test-speed") ? SpeedLog() : nil

    private let file: FileHandle?
    private var previous: CFTimeInterval = 0
    private var front: CFTimeInterval = 0
    private var periods: [CFTimeInterval] = []

    private override init() {
        let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("speed.jsonl")
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        file = try? FileHandle(forWritingTo: url)
        _ = try? file?.seekToEnd()
        super.init()
        let arguments = ProcessInfo.processInfo.arguments
        let phase = arguments.firstIndex(of: "--ui-test-phase").flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil } ?? ""
        write(["launch": phase, "scale": CannedScale.factor ?? 0])
        CADisplayLink(target: self, selector: #selector(tick)).add(to: .main, forMode: .common)
    }

    func interaction(_ name: String, lasted: Duration, _ fields: [String: Any] = [:]) {
        write(fields.merging(["i": name, "ms": Self.ms(lasted), "t": front * 1000, "fp": Self.footprint()]) { _, own in own })
    }

    fileprivate func launched() {
        write(["i": "First frame", "ms": Self.sinceExec(), "t": front * 1000, "fp": Self.footprint()])
    }

    @objc private func tick(_ link: CADisplayLink) {
        guard UIApplication.shared.applicationState == .active else { previous = 0; return }
        defer { previous = link.timestamp }
        guard previous > 0 else { return }
        let gap = link.timestamp - previous, period = link.targetTimestamp - link.timestamp
        front += gap
        periods.append(gap)
        if periods.count == 240 {
            write(["hz": (1 / periods.sorted()[120]).rounded(), "t": front * 1000])
            periods.removeAll(keepingCapacity: true)
        }
        let missed = Int((gap / period).rounded()) - 1
        guard missed > 0 else { return }
        var late: [String: Any] = ["late": missed, "ms": (gap - period) * 1000, "t": front * 1000]
        if gap >= 0.25 { late["hang"] = gap * 1000 }
        write(late)
    }

    private func write(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        file?.write(data + Data([0x0A]))
    }

    private static func ms(_ duration: Duration) -> Double {
        Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
    }

    private static func footprint() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : 0
    }

    private static func sinceExec() -> Double {
        var info = kinfo_proc(), size = MemoryLayout<kinfo_proc>.size
        var name = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&name, 4, &info, &size, nil, 0) == 0 else { return -1 }
        let start = info.kp_proc.p_un.__p_starttime
        return (AppClock.now.timeIntervalSince1970 - (Double(start.tv_sec) + Double(start.tv_usec) / 1e6)) * 1000
    }
}
