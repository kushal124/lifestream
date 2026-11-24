import ApplicationServices
import Carbon
import CoreGraphics
import Darwin
import Evidence
import Foundation
import os

final class EventTap: @unchecked Sendable {
    static let watchdogInterval = 5.0

    private let context: EventTapContext
    private let ready = DispatchSemaphore(value: 0)
    private let exited = DispatchSemaphore(value: 0)
    private let loop = OSAllocatedUnfairLock<LoopState>(uncheckedState: LoopState())
    private var thread: Thread?

    private struct LoopState {
        var runLoop: CFRunLoop?
        var created = false
    }

    init(buffer: InputEventBuffer) {
        context = EventTapContext(buffer: buffer)
    }

    func start() -> Bool {
        guard thread == nil else { return loop.withLockUnchecked { $0.created } }
        guard InputEventPermission.granted || AXIsProcessTrusted() else { return false }
        let thread = Thread { [self] in run() }
        thread.name = "org.lifestreamprotocol.input-tap"
        thread.qualityOfService = .userInteractive
        self.thread = thread
        thread.start()
        ready.wait()
        let created = loop.withLockUnchecked { $0.created }
        if !created {
            exited.wait()
            self.thread = nil
        }
        return created
    }

    func stop() {
        guard thread != nil else { return }
        if let runLoop = loop.withLockUnchecked({ $0.runLoop }) {
            CFRunLoopPerformBlock(runLoop, CFRunLoopMode.commonModes.rawValue) { CFRunLoopStop(CFRunLoopGetCurrent()) }
            CFRunLoopWakeUp(runLoop)
        }
        exited.wait()
        thread = nil
    }

    private func run() {
        defer { exited.signal() }
        let mouse = Self.mask(of: [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
                                   .otherMouseDown, .otherMouseUp, .mouseMoved, .leftMouseDragged,
                                   .rightMouseDragged, .otherMouseDragged, .scrollWheel])
        guard let port = tap(mouse | Self.mask(of: [.keyDown, .keyUp, .flagsChanged])) else {
            ready.signal()
            return
        }
        context.port = port
        let runLoop = CFRunLoopGetCurrent()
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
        CFRunLoopAddSource(runLoop, source, .commonModes)
        let context = self.context
        let watchdog = CFRunLoopTimerCreateWithHandler(kCFAllocatorDefault,
                                                       CFAbsoluteTimeGetCurrent() + Self.watchdogInterval,
                                                       Self.watchdogInterval, 0, 0) { _ in context.watch() }
        CFRunLoopAddTimer(runLoop, watchdog, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        loop.withLockUnchecked { state in
            state.runLoop = runLoop
            state.created = true
        }
        ready.signal()
        CFRunLoopRun()
        CGEvent.tapEnable(tap: port, enable: false)
        CFRunLoopTimerInvalidate(watchdog)
        CFRunLoopRemoveSource(runLoop, source, .commonModes)
        CFMachPortInvalidate(port)
        context.port = nil
        loop.withLockUnchecked { $0.runLoop = nil }
    }

    private func tap(_ mask: CGEventMask) -> CFMachPort? {
        CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                          eventsOfInterest: mask, callback: inputTapCallback,
                          userInfo: Unmanaged.passUnretained(context).toOpaque())
    }

    private static func mask(of types: [CGEventType]) -> CGEventMask {
        types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
    }
}

final class EventTapContext: @unchecked Sendable {
    let buffer: InputEventBuffer
    var port: CFMachPort?

    init(buffer: InputEventBuffer) {
        self.buffer = buffer
    }

    func restart(_ reason: InputTapRestartReason) {
        if let port { CGEvent.tapEnable(tap: port, enable: true) }
        buffer.append(.tapRestart(reason, at: Date()))
    }

    func watch() {
        guard let port, !CGEvent.tapIsEnabled(tap: port) else { return }
        CGEvent.tapEnable(tap: port, enable: true)
        buffer.append(.tapRestart(.watchdog, at: Date()))
    }
}

private func inputTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent,
                              info: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if let info {
        ResourceMeter.shared.measure(.inputTap) {
            let context = Unmanaged<EventTapContext>.fromOpaque(info).takeUnretainedValue()
            switch type {
            case .tapDisabledByTimeout:
                context.restart(.timeout)
            case .tapDisabledByUserInput:
                context.restart(.userInput)
            default:
                ResourceMeter.shared.count(.inputEventsRaw)
                if let raw = RawInputEvent(type: type, event: event) { context.buffer.append(.tap(raw)) }
            }
        }
    }
    return Unmanaged.passUnretained(event)
}

extension RawInputEvent {
    init?(type: CGEventType, event: CGEvent) {
        guard let kind = RawInputEventType(rawValue: type.rawValue) else { return nil }
        self.init(type: kind, timestamp: event.timestamp, receivedWall: Date().timeIntervalSince1970,
                  receivedUptime: clock_gettime_nsec_np(CLOCK_UPTIME_RAW))
        flags = event.flags.rawValue
        if kind == .flagsChanged { secureInput = IsSecureEventInputEnabled() }
        sourcePID = Int32(truncatingIfNeeded: event.getIntegerValueField(.eventSourceUnixProcessID))
        targetPID = Int32(truncatingIfNeeded: event.getIntegerValueField(.eventTargetUnixProcessID))
        switch kind {
        case .keyDown, .keyUp, .flagsChanged:
            keyCode = Int(event.getIntegerValueField(.keyboardEventKeycode))
            guard kind == .keyDown else { break }
            autorepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
            var length = 0
            withUnsafeMutablePointer(to: &characters.units) { tuple in
                tuple.withMemoryRebound(to: UniChar.self, capacity: InputKeyCharacters.capacity) { units in
                    event.keyboardGetUnicodeString(maxStringLength: InputKeyCharacters.capacity,
                                                   actualStringLength: &length, unicodeString: units)
                }
            }
            characters.count = min(max(0, length), InputKeyCharacters.capacity)
        case .scrollWheel:
            x = Double(event.location.x)
            y = Double(event.location.y)
            scrollDY = Double(event.getIntegerValueField(.scrollWheelEventPointDeltaAxis1))
            scrollDX = Double(event.getIntegerValueField(.scrollWheelEventPointDeltaAxis2))
            scrollPhase = UInt32(truncatingIfNeeded: event.getIntegerValueField(.scrollWheelEventScrollPhase))
            momentumPhase = UInt32(truncatingIfNeeded: event.getIntegerValueField(.scrollWheelEventMomentumPhase))
            continuous = event.getIntegerValueField(.scrollWheelEventIsContinuous) != 0
        default:
            x = Double(event.location.x)
            y = Double(event.location.y)
            button = Int(event.getIntegerValueField(.mouseEventButtonNumber))
            clicks = Int(event.getIntegerValueField(.mouseEventClickState))
        }
    }
}
