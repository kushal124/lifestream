import ApplicationServices
import Evidence
import Foundation

struct AccessibilitySecureFields: SecureFieldTree {
    private let app: AXUIElement
    private let system = AXUIElementCreateSystemWide()
    private let deadline: Double
    private static let names = [kAXRoleAttribute, kAXSubroleAttribute, kAXChildrenAttribute] as CFArray

    init(pid: pid_t, deadline: Double) {
        app = AXUIElementCreateApplication(pid)
        self.deadline = deadline
    }

    func focusedElement() -> SecureFieldLookup<AXUIElement> { lookup(kAXFocusedUIElementAttribute, of: system) }
    func frontWindow() -> SecureFieldLookup<AXUIElement> { lookup(kAXFocusedWindowAttribute, of: app) }

    func read(_ node: AXUIElement) -> SecureFieldNode<AXUIElement>? {
        guard prepare(node) else { return nil }
        var values: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(node, Self.names, AXCopyMultipleAttributeOptions(rawValue: 0),
                                                     &values) == .success,
              let list = values as? [AnyObject], list.count == 3,
              let role = Self.text(list[0]), let subrole = Self.text(list[1]) else { return nil }
        var children: [AXUIElement] = []
        if let items = list[2] as? [AnyObject] {
            children = items.compactMap { item in
                CFGetTypeID(item) == AXUIElementGetTypeID() ? unsafeBitCast(item, to: AXUIElement.self) : nil
            }
        } else if Self.missing(list[2]) == false {
            return nil
        }
        return SecureFieldNode(role: role, subrole: subrole, children: children)
    }

    private func lookup(_ attribute: String, of owner: AXUIElement) -> SecureFieldLookup<AXUIElement> {
        guard prepare(owner) else { return .failed }
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(owner, attribute as CFString, &value)
        if error == .noValue || error == .attributeUnsupported { return .absent }
        guard error == .success, let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return .failed }
        return .found(unsafeBitCast(value, to: AXUIElement.self))
    }

    private func prepare(_ element: AXUIElement) -> Bool {
        let left = deadline - ProcessInfo.processInfo.systemUptime
        return left > 0 && AXUIElementSetMessagingTimeout(element, Float(left)) == .success
    }

    private static func text(_ value: AnyObject) -> String?? {
        if let string = value as? String { return .some(string) }
        return missing(value) == true ? .some(nil) : nil
    }

    private static func missing(_ value: AnyObject) -> Bool? {
        if CFGetTypeID(value) == CFNullGetTypeID() { return true }
        guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        let wrapped = unsafeBitCast(value, to: AXValue.self)
        guard AXValueGetType(wrapped) == .axError else { return nil }
        var error = AXError.success
        guard AXValueGetValue(wrapped, .axError, &error) else { return false }
        return error == .noValue || error == .attributeUnsupported
    }
}
