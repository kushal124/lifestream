import Evidence
import Foundation

enum InputEventName: String, CaseIterable, Sendable {
    case keyDown = "key_down"
    case keyUp = "key_up"
    case flags
    case down
    case up
    case move
    case scroll
    case activate
    case logStart = "log_start"
    case logStop = "log_stop"
    case secureInput = "secure_input"
    case locked
    case tapRestart = "tap_restart"
    case layout
    case siteUnknown = "site_unknown"
}

enum InputModifier: String, CaseIterable, Comparable, Sendable {
    case caps, cmd, ctrl, fn, opt, shift

    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

struct InputButton: Equatable, Hashable, Sendable {
    let number: Int

    var spelling: String {
        switch number {
        case 0: return "left"
        case 1: return "right"
        case 2: return "middle"
        default: return "button\(number + 1)"
        }
    }

    init?(spelling: String) {
        switch spelling {
        case "left": number = 0
        case "right": number = 1
        case "middle": number = 2
        default:
            guard spelling.hasPrefix("button"), let value = Int(spelling.dropFirst(6)), value >= 4,
                  "button\(value)" == spelling else { return nil }
            number = value - 1
        }
    }

    init(number: Int) {
        self.number = max(0, number)
    }
}

enum InputScrollPhase: String, CaseIterable, Sendable {
    case began, changed, ended, momentum
    case momentumEnd = "momentum_end"
}

enum InputTapRestartReason: String, CaseIterable, Sendable {
    case timeout
    case userInput = "user_input"
    case watchdog
}

enum InputHiddenReason: String, CaseIterable, Sendable {
    case secureField = "secure_field"
}

enum InputLookupError: Equatable, Sendable {
    case timeout
    case noElement
    case busy
    case ax(Int32)

    var spelling: String {
        switch self {
        case .timeout: return "timeout"
        case .noElement: return "none"
        case .busy: return "busy"
        case .ax(let code): return "ax_\(code)"
        }
    }

    init?(spelling: String) {
        switch spelling {
        case "timeout": self = .timeout
        case "none": self = .noElement
        case "busy": self = .busy
        default:
            guard spelling.hasPrefix("ax_"), let code = Int32(spelling.dropFirst(3)),
                  "ax_\(code)" == spelling else { return nil }
            self = .ax(code)
        }
    }
}

struct InputElementAttributes: Equatable, Sendable {
    var role: String?
    var subrole: String?
    var title: String?
    var desc: String?
    var id: String?
    var url: String?
    var value: String?

    static let secureRole = "AXSecureTextField"

    var isSecure: Bool { role == Self.secureRole || subrole == Self.secureRole }
}

struct InputElement: Equatable, Sendable {
    var attributes = InputElementAttributes()
    var action: InputElementAttributes?
    var ms: Int?
    var err: InputLookupError?

    static let actionableRoles: Set<String> = [
        "AXButton", "AXLink", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXTab",
        "AXPopUpButton", "AXTextField", "AXTextArea", "AXCell", "AXRow",
    ]
}

struct InputKeyDown: Equatable, Sendable {
    var code: Int?
    var key: String?
    var name: String?
    var mods: [InputModifier] = []
    var isRepeat = false
    var hidden: InputHiddenReason?
    var app: Int?
    var syn: Int?
    var el: InputElement?
}

struct InputPointer: Equatable, Sendable {
    var button: InputButton
    var x: Double
    var y: Double
    var clicks: Int
    var mods: [InputModifier] = []
    var app: Int?
    var syn: Int?
    var el: InputElement?
}

struct InputMove: Equatable, Sendable {
    var x: Double
    var y: Double
    var drag: InputButton?
    var app: Int?
    var syn: Int?
}

struct InputScroll: Equatable, Sendable {
    var x: Double
    var y: Double
    var dx: Double
    var dy: Double
    var lines = false
    var phase: InputScrollPhase?
    var app: Int?
    var syn: Int?
}

enum InputEventBody: Equatable, Sendable {
    case keyDown(InputKeyDown)
    case keyUp(code: Int?, app: Int?, syn: Int?)
    case flags(code: Int, mods: [InputModifier])
    case down(InputPointer)
    case up(InputPointer)
    case move(InputMove)
    case scroll(InputScroll)
    case activate(app: Int, pid: Int)
    case logStart(inputMonitoring: Bool, accessibility: Bool)
    case logStop
    case secureInput(on: Bool)
    case locked(on: Bool)
    case tapRestart(InputTapRestartReason)
    case layout(id: String)
    case siteUnknown(on: Bool)

    var name: InputEventName {
        switch self {
        case .keyDown: return .keyDown
        case .keyUp: return .keyUp
        case .flags: return .flags
        case .down: return .down
        case .up: return .up
        case .move: return .move
        case .scroll: return .scroll
        case .activate: return .activate
        case .logStart: return .logStart
        case .logStop: return .logStop
        case .secureInput: return .secureInput
        case .locked: return .locked
        case .tapRestart: return .tapRestart
        case .layout: return .layout
        case .siteUnknown: return .siteUnknown
        }
    }

    var isMarker: Bool {
        switch self {
        case .logStart, .logStop, .secureInput, .locked, .tapRestart, .layout, .siteUnknown: return true
        default: return false
        }
    }

    var appIndices: [Int] {
        switch self {
        case .keyDown(let key): return [key.app, key.syn].compactMap { $0 }
        case .keyUp(_, let app, let syn): return [app, syn].compactMap { $0 }
        case .down(let pointer), .up(let pointer): return [pointer.app, pointer.syn].compactMap { $0 }
        case .move(let move): return [move.app, move.syn].compactMap { $0 }
        case .scroll(let scroll): return [scroll.app, scroll.syn].compactMap { $0 }
        case .activate(let app, _): return [app]
        default: return []
        }
    }
}

struct InputEvent: Equatable, Sendable {
    var t: Int
    var body: InputEventBody
    var site: Int?

    init(t: Int, body: InputEventBody, site: Int? = nil) {
        self.t = t
        self.body = body
        self.site = site
    }
}

struct InputActivity: Equatable, Sendable {
    var app: Int
    var site: Int?
    var keys = 0
    var clicks = 0
    var scrolls = 0
    var moves = 0

    enum Kind: Sendable {
        case keys, clicks, scrolls, moves
    }

    static func order(_ lhs: InputActivity, _ rhs: InputActivity) -> Bool {
        (lhs.app, lhs.site ?? -1) < (rhs.app, rhs.site ?? -1)
    }

    mutating func count(_ kind: Kind) {
        switch kind {
        case .keys: keys += 1
        case .clicks: clicks += 1
        case .scrolls: scrolls += 1
        case .moves: moves += 1
        }
    }
}

struct InputActivityKey: Hashable, Sendable {
    let app: Int
    let site: Int?

    init(app: Int, site: Int?) {
        self.app = app
        self.site = site
    }

    init(_ activity: InputActivity) {
        self.init(app: activity.app, site: activity.site)
    }
}

struct InputChunk: Equatable, Sendable {
    var at: Date
    var until: Date
    var layout: String
    var apps: [String]
    var sites: [String] = []
    var events: [InputEvent]
    var activity: [InputActivity] = []
    var lost = 0
    var recovered = false

    init(at: Date, until: Date, layout: String, apps: [String], sites: [String] = [], events: [InputEvent],
         activity: [InputActivity] = [], lost: Int = 0, recovered: Bool = false) {
        self.at = UTCInstant.millisecond(at)
        self.until = UTCInstant.millisecond(until)
        self.layout = layout
        self.apps = apps
        self.sites = sites
        self.events = events
        self.activity = activity
        self.lost = lost
        self.recovered = recovered
    }
}
