import AppKit
import BrowserPages
import Evidence
import Foundation

public enum InputFocusProbe {
    public struct Line: Encodable, Sendable {
        public let key: String
        public let mods: [String]
        public let tapTarget: String?
        public let frontmost: String?
        public let keyFocus: String?
        public let keyFocusMs: Double
        public let app: String?
        public let mode: String
        public let role: String?
        public let subrole: String?
        public let title: String?
        public let err: String?
        public let ms: Int
    }

    @MainActor public static func run(limit: Int, modes: RecordingModes, write: (Line) -> Void) -> Bool {
        let buffer = InputEventBuffer(capacity: 1024, wake: {}, wakeLater: {})
        let tap = EventTap(buffer: buffer)
        guard tap.start() else {
            tap.stop()
            return false
        }
        defer { tap.stop() }
        let reader = AccessibilityElementReader()
        var seen = 0
        while seen < limit {
            _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
            var taken = buffer.take()
            for case .tap(let raw) in taken.items where raw.type == .keyDown && seen < limit {
                seen += 1
                write(line(raw, modes: modes, reader: reader))
            }
            buffer.recycle(&taken.items)
        }
        return true
    }

    @MainActor private static func line(_ raw: RawInputEvent, modes: RecordingModes,
                                        reader: AccessibilityElementReader) -> Line {
        let target = raw.targetPID > 0 ? LiveInputEventSource.processName(raw.targetPID) : nil
        let started = ProcessInfo.processInfo.systemUptime
        let focus = AccessibilityElementReader.keyFocusOwner()
        let focusMs = ((ProcessInfo.processInfo.systemUptime - started) * 10_000).rounded() / 10
        let readStarted = ProcessInfo.processInfo.systemUptime
        let answer = reader.read(.focus(pid: raw.targetPID, app: target ?? InputProcessNames.unknown, modes: modes),
                                 timeout: InputChunker.Limits().lookupTimeout)
        let ms = Int(((ProcessInfo.processInfo.systemUptime - readStarted) * 1000).rounded())
        let owner = answer.focusOwner.flatMap(LiveInputEventSource.processName)
        var app = target
        var mode = modes.mode(of: target)
        if let owner, owner != target {
            app = owner
            mode = Browsers.isBrowser(owner) ? .exclude : modes.mode(of: owner)
        }
        var role: String?
        var subrole: String?
        var title: String?
        var err: String?
        switch answer.lookup {
        case .found(let attributes, _):
            role = attributes.role
            subrole = attributes.subrole
            title = attributes.title
        case .failed(let error):
            err = error.spelling
        }
        let name = RawInputReading.keyNames[raw.keyCode] ?? "printable"
        return Line(key: name, mods: RawInputReading.modifiers(raw.flags).map(\.rawValue), tapTarget: target,
                    frontmost: NSWorkspace.shared.frontmostApplication.flatMap(LiveInputEventSource.name(of:)),
                    keyFocus: focus.flatMap(LiveInputEventSource.processName), keyFocusMs: focusMs, app: app,
                    mode: mode.rawValue, role: role, subrole: subrole, title: title, err: err, ms: ms)
    }
}
