import ApplicationServices
import Darwin
import Evidence

enum FrontWindowReading: Equatable, Sendable {
    case window(UInt32)
    case unstated(FrontWindowCause)

    func stated(in windows: [CaptureWindow], application pid: Int32) -> CaptureFrontWindow {
        switch self {
        case .window(let id):
            let listed = windows.contains { $0.windowID == id && $0.application?.pid == pid }
            return listed ? CaptureFrontWindow(windowID: id) : CaptureFrontWindow(cause: .notListed)
        case .unstated(let cause):
            return CaptureFrontWindow(cause: cause)
        }
    }
}

enum AccessibilityFrontWindow {
    static let deadline = 0.100

    static func read(pid: pid_t) -> FrontWindowReading {
        guard AXIsProcessTrusted() else { return .unstated(.focusedWindowUnreadable) }
        let started = ProcessInfo.processInfo.systemUptime
        func prepare(_ element: AXUIElement) -> Bool {
            let left = deadline - (ProcessInfo.processInfo.systemUptime - started)
            return left > 0 && AXUIElementSetMessagingTimeout(element, Float(left)) == .success
        }
        let app = AXUIElementCreateApplication(pid)
        guard prepare(app) else { return .unstated(.focusedWindowUnreadable) }
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &value)
        if error == .noValue || error == .attributeUnsupported { return .unstated(.noFocusedWindow) }
        guard error == .success, let value, CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return .unstated(.focusedWindowUnreadable)
        }
        let window = unsafeBitCast(value, to: AXUIElement.self)
        var owner: pid_t = 0
        guard AXUIElementGetPid(window, &owner) == .success, owner == pid else {
            return .unstated(.focusedWindowUnreadable)
        }
        guard prepare(window), let id = AccessibilityWindowNumber.of(window) else {
            return .unstated(.windowNumberUnreadable)
        }
        return .window(id)
    }
}

enum AccessibilityWindowNumber {
    private typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<UInt32>) -> AXError

    private static let call: GetWindow? = {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
        return unsafeBitCast(symbol, to: GetWindow.self)
    }()

    static func of(_ element: AXUIElement) -> UInt32? {
        guard let call else { return nil }
        var id: UInt32 = 0
        guard call(element, &id) == .success, id != 0 else { return nil }
        return id
    }
}
