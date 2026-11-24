import ApplicationServices
import Evidence

protocol AccessibilityCalls: Sendable {
    func trusted() -> Bool
    func setTimeout(_ element: AXUIElement, _ seconds: Float) -> AXError
    func pid(_ element: AXUIElement) -> pid_t?
    func values(_ element: AXUIElement, _ names: CFArray, _ result: inout CFArray?) -> AXError
    func value(_ element: AXUIElement, _ name: String, _ result: inout CFTypeRef?) -> AXError
    func windowNumber(_ element: AXUIElement) -> UInt32?
}

struct LiveAccessibilityCalls: AccessibilityCalls {
    func trusted() -> Bool { AXIsProcessTrusted() }
    func setTimeout(_ element: AXUIElement, _ seconds: Float) -> AXError {
        AXUIElementSetMessagingTimeout(element, seconds)
    }
    func pid(_ element: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(element, &pid) == .success ? pid : nil
    }
    func values(_ element: AXUIElement, _ names: CFArray, _ result: inout CFArray?) -> AXError {
        ResourceMeter.shared.count(.axCalls)
        return AXUIElementCopyMultipleAttributeValues(element, names, [], &result)
    }
    func value(_ element: AXUIElement, _ name: String, _ result: inout CFTypeRef?) -> AXError {
        ResourceMeter.shared.count(.axCalls)
        return AXUIElementCopyAttributeValue(element, name as CFString, &result)
    }
    func windowNumber(_ element: AXUIElement) -> UInt32? {
        ResourceMeter.shared.count(.axCalls)
        return AccessibilityWindowNumber.of(element)
    }
}
