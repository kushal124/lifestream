import Evidence
import Foundation

struct InputKeyCharacters: Equatable, Sendable {
    static let capacity = 4
    var units: (UInt16, UInt16, UInt16, UInt16) = (0, 0, 0, 0)
    var count = 0

    init() {}

    init(_ text: String) {
        for unit in text.utf16.prefix(Self.capacity) {
            switch count {
            case 0: units.0 = unit
            case 1: units.1 = unit
            case 2: units.2 = unit
            default: units.3 = unit
            }
            count += 1
        }
    }

    var text: String {
        let all = [units.0, units.1, units.2, units.3]
        return String(decoding: all.prefix(max(0, min(count, Self.capacity))), as: UTF16.self)
    }

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.text == rhs.text }
}

enum RawInputEventType: UInt32, Sendable {
    case leftMouseDown = 1
    case leftMouseUp = 2
    case rightMouseDown = 3
    case rightMouseUp = 4
    case mouseMoved = 5
    case leftMouseDragged = 6
    case rightMouseDragged = 7
    case keyDown = 10
    case keyUp = 11
    case flagsChanged = 12
    case scrollWheel = 22
    case otherMouseDown = 25
    case otherMouseUp = 26
    case otherMouseDragged = 27
}

struct RawInputEvent: Equatable, Sendable {
    var type: RawInputEventType
    var timestamp: UInt64
    var receivedWall: Double
    var receivedUptime: UInt64
    var flags: UInt64 = 0
    var keyCode = 0
    var autorepeat = false
    var characters = InputKeyCharacters()
    var x: Double = 0
    var y: Double = 0
    var button = 0
    var clicks = 0
    var scrollDX: Double = 0
    var scrollDY: Double = 0
    var scrollPhase: UInt32 = 0
    var momentumPhase: UInt32 = 0
    var continuous = true
    var sourcePID: Int32 = 0
    var targetPID: Int32 = 0
    var secureInput = false
}

enum InputPageRead: Equatable, Sendable {
    case notAPage
    case page(BrowserPage)

    var page: BrowserPage? {
        if case .page(let page) = self { return page }
        return nil
    }

    var site: Site? {
        if case .page(.site(let site)) = self { return site }
        return nil
    }
}

enum InputBufferItem: Equatable, Sendable {
    case tap(RawInputEvent)
    case tapRestart(InputTapRestartReason, at: Date)
    case activate(pid: Int32, name: String?, at: Date)
    case terminated(pid: Int32)
    case screenLocked(Bool, at: Date)
    case onConsole(Bool, at: Date)
    case secureInput(Bool, at: Date)
    case layout(String, at: Date)
    case page(pid: Int32, read: InputPageRead, at: Date)
}

enum RawInputReading {
    static let maximumAge: UInt64 = 5_000_000_000

    static func instant(receivedWall: Double, receivedUptime: UInt64, timestamp: UInt64) -> Date {
        guard timestamp <= receivedUptime, receivedUptime - timestamp <= maximumAge else {
            return UTCInstant.millisecond(Date(timeIntervalSince1970: receivedWall))
        }
        let age = Double(receivedUptime - timestamp) / 1_000_000_000
        return UTCInstant.millisecond(Date(timeIntervalSince1970: receivedWall - age))
    }

    static func instant(_ event: RawInputEvent) -> Date {
        instant(receivedWall: event.receivedWall, receivedUptime: event.receivedUptime, timestamp: event.timestamp)
    }

    private static let modifierBits: [(InputModifier, UInt64)] = [
        (.caps, 0x0001_0000), (.shift, 0x0002_0000), (.ctrl, 0x0004_0000),
        (.opt, 0x0008_0000), (.cmd, 0x0010_0000), (.fn, 0x0080_0000),
    ]

    static func modifiers(_ flags: UInt64) -> [InputModifier] {
        modifierBits.filter { flags & $0.1 != 0 }.map(\.0).sorted()
    }

    static let keyNames: [Int: String] = [
        36: "return", 76: "return", 48: "tab", 49: "space", 51: "delete", 117: "forward_delete",
        53: "escape", 123: "left", 124: "right", 125: "down", 126: "up",
        115: "home", 119: "end", 116: "page_up", 121: "page_down",
        122: "f1", 120: "f2", 99: "f3", 118: "f4", 96: "f5", 97: "f6", 98: "f7", 100: "f8",
        101: "f9", 109: "f10", 103: "f11", 111: "f12", 105: "f13", 107: "f14", 113: "f15",
        106: "f16", 64: "f17", 79: "f18", 80: "f19", 90: "f20",
    ]

    static let focusMovingKeys: Set<String> = ["tab", "return", "escape", "up", "down"]

    static let functionKeyCode = 63

    static func mayOpenPanel(keyCode: Int, mods: [InputModifier]) -> Bool {
        mods.contains(.cmd) || mods.contains(.ctrl) || (mods.contains(.opt) && keyCode == 49)
    }

    static func changesPage(keyCode: Int, mods: [InputModifier]) -> Bool {
        if mods.contains(.ctrl), keyCode == 48 { return true }
        guard mods.contains(.cmd) else { return false }
        return [17, 13, 37, 33, 30, 18, 19, 20, 21, 23, 22, 26, 28, 25].contains(keyCode)
    }

    static func printable(_ characters: InputKeyCharacters) -> String? {
        let text = characters.text
        guard !text.isEmpty else { return nil }
        let printing = text.unicodeScalars.contains { scalar in
            !(scalar.value < 0x20 || scalar.value == 0x7F || (0xF700...0xF8FF).contains(scalar.value))
        }
        return printing ? text : nil
    }

    static func scrollPhase(scroll: UInt32, momentum: UInt32) -> InputScrollPhase? {
        switch momentum {
        case 1, 2: return .momentum
        case 3: return .momentumEnd
        default: break
        }
        switch scroll {
        case 1, 128: return .began
        case 2: return .changed
        case 4, 8: return .ended
        default: return nil
        }
    }

    static func button(_ event: RawInputEvent) -> InputButton {
        switch event.type {
        case .leftMouseDown, .leftMouseUp, .leftMouseDragged: return InputButton(number: 0)
        case .rightMouseDown, .rightMouseUp, .rightMouseDragged: return InputButton(number: 1)
        default: return InputButton(number: event.button)
        }
    }
}
