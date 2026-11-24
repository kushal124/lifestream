import Evidence
import Foundation
import XCTest
@testable import InputEvents

enum Synthetic {
    static let editor = "com.example.editor"
    static let browser = "com.example.browser"
    static let vault = "com.example.vault"
    static let agent = "com.example.agent"
    static let pids: [Int32: String] = [501: editor, 502: browser, 503: vault, 504: agent,
                                        88: InputChunker.loginWindow]

    static func date(_ spelling: String) -> Date {
        guard let value = UTCInstant.date(rfc3339: spelling) else {
            fatalError("the fixture instant \(spelling) is not the spelling under test")
        }
        return value
    }

    static let opened = date("2026-09-23T10:02:30.000Z")
    static let minute = date("2026-09-23T10:03:00.000Z")

    static func state(layout: String = "com.apple.keylayout.US", frontmost: (Int32, String)? = (501, editor),
                      screenLocked: Bool = false, onConsole: Bool = true, secureInput: Bool = false,
                      inputMonitoring: Bool = true) -> InputOpeningState {
        InputOpeningState(inputMonitoring: inputMonitoring, accessibility: true, screenLocked: screenLocked,
                          onConsole: onConsole, secureInput: secureInput, layout: layout,
                          frontmost: frontmost.map { (pid: $0.0, name: $0.1) })
    }

    static func raw(_ type: RawInputEventType, at: Date, target: Int32 = 501, source: Int32 = 0,
                    code: Int = 0, characters: String = "", flags: UInt64 = 0, x: Double = 0, y: Double = 0,
                    button: Int = 0, clicks: Int = 1, dx: Double = 0, dy: Double = 0,
                    phase: UInt32 = 0, momentum: UInt32 = 0, continuous: Bool = true,
                    autorepeat: Bool = false, secureInput: Bool = false) -> InputBufferItem {
        let uptime: UInt64 = 1_000_000_000_000
        var event = RawInputEvent(type: type, timestamp: uptime, receivedWall: at.timeIntervalSince1970,
                                  receivedUptime: uptime)
        event.targetPID = target
        event.sourcePID = source
        event.keyCode = code
        event.characters = InputKeyCharacters(characters)
        event.flags = flags
        event.x = x
        event.y = y
        event.button = button
        event.clicks = clicks
        event.scrollDX = dx
        event.scrollDY = dy
        event.scrollPhase = phase
        event.momentumPhase = momentum
        event.continuous = continuous
        event.autorepeat = autorepeat
        event.secureInput = secureInput
        return .tap(event)
    }

    static func element(role: String, subrole: String? = nil, title: String? = nil,
                        value: String? = nil) -> InputElementLookup {
        .found(InputElementAttributes(role: role, subrole: subrole, title: title, value: value), action: nil)
    }
}

final class FakeLookups: InputElementLookups {
    var requests: [(id: Int, target: InputLookupTarget, deadline: Double)] = []
    func request(_ id: Int, _ target: InputLookupTarget, deadline: Double) {
        requests.append((id, target, deadline))
    }
}

final class FakeSource: InputEventSource, @unchecked Sendable {
    private let lock = NSLock()
    var opening = Synthetic.state()
    var keys = true
    var names = Synthetic.pids
    private(set) var buffer: InputEventBuffer?
    private(set) var calls: [String] = []
    var probeAtStart: (() -> Bool)?
    private(set) var probedAtStart: Bool?
    var onStart: ((InputEventBuffer) -> Void)?

    func openingState() -> InputOpeningState {
        lock.withLock { calls.append("opening state") }
        return opening
    }

    func start(into buffer: InputEventBuffer) -> Bool {
        let probed = probeAtStart?()
        lock.withLock {
            calls.append("start")
            self.buffer = buffer
            probedAtStart = probed
        }
        onStart?(buffer)
        return keys
    }

    func stop() {
        lock.withLock { calls.append("stop") }
    }

    func processName(_ pid: Int32) -> String? { names[pid] }

    func session() -> (screenLocked: Bool, onConsole: Bool) { (false, true) }

    private(set) var modes: [RecordingModes] = []
    func setModes(_ modes: RecordingModes) { lock.withLock { self.modes.append(modes) } }

    func push(_ item: InputBufferItem) {
        let buffer = lock.withLock { self.buffer }
        buffer?.append(item)
    }
}

final class FakeClock: @unchecked Sendable {
    private let lock = NSLock()
    private var instant: Date

    init(_ instant: Date) {
        self.instant = instant
    }

    var now: Date {
        get { lock.withLock { instant } }
        set { lock.withLock { instant = newValue } }
    }

    var clock: InputEventClock {
        InputEventClock(now: { self.now }, uptime: { ProcessInfo.processInfo.systemUptime })
    }
}

final class FakeReader: InputElementReading, @unchecked Sendable {
    private let lock = NSLock()
    private var answer: InputElementLookup = Synthetic.element(role: "AXTextField", title: "Search")
    private var latency: Double = 0
    private(set) var reads: [InputLookupTarget] = []

    func set(_ answer: InputElementLookup, latency: Double = 0) {
        lock.withLock {
            self.answer = answer
            self.latency = latency
        }
    }

    private var page: InputPageRead?

    func set(page: InputPageRead?) {
        lock.withLock { self.page = page }
    }

    private var owner: Int32?

    func set(owner: Int32?) {
        lock.withLock { self.owner = owner }
    }

    func read(_ target: InputLookupTarget, timeout: Double) -> InputElementAnswer {
        let (answer, latency, page, owner) = lock.withLock {
            () -> (InputElementLookup, Double, InputPageRead?, Int32?) in
            reads.append(target)
            return (self.answer, self.latency, self.page, self.owner)
        }
        if latency > 0 { Thread.sleep(forTimeInterval: latency) }
        guard case .focus = target else { return InputElementAnswer(answer, page: page) }
        return InputElementAnswer(answer, page: page, focusOwner: owner)
    }
}

struct NeverHeld: Error {}

let waitLimit: TimeInterval = 30

extension XCTestCase {
    func until(_ what: String, file: StaticString = #filePath, line: UInt = #line, _ ready: () -> Bool) throws {
        let ends = Date().addingTimeInterval(waitLimit)
        while !ready() {
            guard Date() < ends else {
                XCTFail("never came in 30 s: \(what)", file: file, line: line)
                throw NeverHeld()
            }
            Thread.sleep(forTimeInterval: 0.005)
        }
    }
}

extension InputEventClock {
    static let held = InputEventClock(now: { Synthetic.opened }, uptime: { 1_000 })
}
