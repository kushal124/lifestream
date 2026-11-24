import Evidence
import Foundation

protocol InputEventSource: AnyObject {
    func openingState() -> InputOpeningState
    func start(into buffer: InputEventBuffer) -> Bool
    func listen() -> Bool
    func stop()
    func processName(_ pid: Int32) -> String?
    func session() -> (screenLocked: Bool, onConsole: Bool)
    func setModes(_ modes: RecordingModes)
}

extension InputEventSource {
    func listen() -> Bool { false }
}

struct InputElementAnswer: Equatable, Sendable {
    var lookup: InputElementLookup
    var page: InputPageRead?
    var focusOwner: Int32?

    init(_ lookup: InputElementLookup, page: InputPageRead? = nil, focusOwner: Int32? = nil) {
        self.lookup = lookup
        self.page = page
        self.focusOwner = focusOwner
    }
}

protocol InputElementReading: Sendable {
    func read(_ target: InputLookupTarget, timeout: Double) -> InputElementAnswer
}

struct InputEventClock: @unchecked Sendable {
    var now: () -> Date
    var uptime: () -> Double

    static let system = InputEventClock(now: { Date() }, uptime: { ProcessInfo.processInfo.systemUptime })
}
