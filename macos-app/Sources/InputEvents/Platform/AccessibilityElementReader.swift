import ApplicationServices
import BrowserPages
import Evidence
import Foundation

struct AccessibilityElementReader: InputElementReading {
    static let textLimit = 256
    static let urlLimit = 2048
    static let ancestorLevels = 3

    private let pages = BrowserPageReader.shared

    func read(_ target: InputLookupTarget, timeout: Double) -> InputElementAnswer {
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        var pid: Int32
        var app: String
        var point: (x: Double, y: Double)?
        var focusOwner: Int32?
        switch target {
        case .page(let browser, let name):
            guard let window = pages.focusedWindow(pid: browser, bundleID: name) else {
                return InputElementAnswer(.failed(.noElement), page: .page(.unknown))
            }
            return InputElementAnswer(.failed(.noElement), page: window.shownPage.map { .page($0) } ?? .notAPage)
        case .position(let delivered, let name, let x, let y):
            (pid, app) = (delivered, name)
            point = (x, y)
        case .focus(let delivered, let name, let modes):
            (pid, app) = (delivered, name)
            if let owner = Self.keyFocusOwner() {
                focusOwner = owner
                if owner != delivered {
                    guard let holder = LiveInputEventSource.processName(owner), modes.mode(of: holder) == .record,
                          !Browsers.isBrowser(holder) else {
                        return InputElementAnswer(.failed(.noElement), focusOwner: owner)
                    }
                    (pid, app) = (owner, holder)
                }
            }
        }
        let calls = AccessibilityElementCalls(deadline: deadline)
        let element: AXUIElement
        switch calls.element(in: pid, at: point) {
        case .success(let found): element = found
        case .failure(let error): return InputElementAnswer(.failed(error), focusOwner: focusOwner)
        }
        let lookup = ElementRead(calls: calls).lookup(element)
        guard Browsers.isBrowser(app) else { return InputElementAnswer(lookup, focusOwner: focusOwner) }
        guard let window = pages.window(containing: element, pid: pid, bundleID: app, deadline: deadline) else {
            return InputElementAnswer(lookup, page: .page(.unknown), focusOwner: focusOwner)
        }
        return InputElementAnswer(lookup, page: window.shownPage.map { .page($0) } ?? .notAPage,
                                  focusOwner: focusOwner)
    }

    static func keyFocusOwner() -> Int32? {
        ResourceMeter.shared.count(.lookupAXCalls)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString,
                                            &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        var pid: pid_t = 0
        guard AXUIElementGetPid(unsafeBitCast(value, to: AXUIElement.self), &pid) == .success, pid > 0 else {
            return nil
        }
        return pid
    }
}

extension InputLookupError: Error {}

protocol ElementCalls {
    associatedtype Element
    func values(_ element: Element, _ attributes: [String]) -> Result<[AnyObject], InputLookupError>
    func element(_ value: AnyObject) -> Element?
}

struct ElementRead<Calls: ElementCalls> {
    static var identity: [String] { [kAXRoleAttribute, kAXSubroleAttribute, kAXParentAttribute] }
    static var details: [String] { [kAXTitleAttribute, kAXDescriptionAttribute, kAXIdentifierAttribute, "AXURL"] }

    let calls: Calls

    func lookup(_ element: Calls.Element) -> InputElementLookup {
        let identity: [AnyObject]
        switch calls.values(element, Self.identity) {
        case .success(let list) where list.count == 3: identity = list
        case .success: return .failed(.noElement)
        case .failure(let error): return .failed(error)
        }
        let attributes = self.attributes(element, identity: identity)
        guard !InputElement.actionableRoles.contains(attributes.role ?? "") else {
            return .found(attributes, action: nil)
        }
        return .found(attributes, action: actionableAncestor(above: identity[2]))
    }

    private func attributes(_ element: Calls.Element, identity: [AnyObject]) -> InputElementAttributes {
        let role = Self.text(identity[0])
        let subrole = Self.text(identity[1])
        var result = InputElementAttributes(role: role.value, subrole: subrole.value)
        let readsValue = !role.failed && !subrole.failed && result.role != nil && !result.isSecure
        let names = Self.details + (readsValue ? [kAXValueAttribute] : [])
        guard case .success(let values) = calls.values(element, names), values.count == names.count else {
            return result
        }
        result.title = Self.text(values[0]).value
        result.desc = Self.text(values[1]).value
        result.id = Self.text(values[2]).value
        result.url = Self.url(values[3])
        if readsValue {
            result.value = Self.text(values[4]).value ?? (values[4] as? NSNumber).map { Self.limited($0.stringValue) }
        }
        return result
    }

    private func actionableAncestor(above parent: AnyObject) -> InputElementAttributes? {
        var next = calls.element(parent)
        for _ in 0..<AccessibilityElementReader.ancestorLevels {
            guard let current = next, case .success(let identity) = calls.values(current, Self.identity),
                  identity.count == 3 else { return nil }
            if let role = identity[0] as? String, InputElement.actionableRoles.contains(role) {
                return attributes(current, identity: identity)
            }
            next = calls.element(identity[2])
        }
        return nil
    }

    private static func text(_ value: AnyObject) -> (value: String?, failed: Bool) {
        if let text = value as? String { return (text.isEmpty ? nil : limited(text), false) }
        if CFGetTypeID(value) == AXValueGetTypeID() {
            let axValue = unsafeBitCast(value, to: AXValue.self)
            guard AXValueGetType(axValue) == .axError else { return (nil, false) }
            var error = AXError.success
            _ = AXValueGetValue(axValue, .axError, &error)
            return (nil, !(error == .noValue || error == .attributeUnsupported))
        }
        return (nil, false)
    }

    private static func url(_ value: AnyObject) -> String? {
        let spelled = (value as? URL)?.absoluteString ?? (value as? String)
        return spelled.flatMap { $0.isEmpty ? nil : String($0.prefix(AccessibilityElementReader.urlLimit)) }
    }

    private static func limited(_ text: String) -> String {
        String(text.prefix(AccessibilityElementReader.textLimit))
    }
}

struct AccessibilityElementCalls: ElementCalls {
    let deadline: Double

    private var remaining: Double { deadline - ProcessInfo.processInfo.systemUptime }

    func element(in pid: Int32, at point: (x: Double, y: Double)?) -> Result<AXUIElement, InputLookupError> {
        let application = AXUIElementCreateApplication(pid)
        guard prepare(application) else { return .failure(.timeout) }
        ResourceMeter.shared.count(.lookupAXCalls)
        if let point {
            var hit: AXUIElement?
            let error = AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &hit)
            guard error == .success, let hit else { return .failure(failure(error)) }
            return .success(hit)
        }
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &value)
        guard error == .success, let value, CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return .failure(failure(error))
        }
        return .success(unsafeBitCast(value, to: AXUIElement.self))
    }

    func values(_ element: AXUIElement, _ attributes: [String]) -> Result<[AnyObject], InputLookupError> {
        guard prepare(element) else { return .failure(.timeout) }
        ResourceMeter.shared.count(.lookupAXCalls)
        var values: CFArray?
        let error = AXUIElementCopyMultipleAttributeValues(element, attributes as CFArray, [], &values)
        guard error == .success, let list = values as? [AnyObject] else { return .failure(failure(error)) }
        return .success(list)
    }

    func element(_ value: AnyObject) -> AXUIElement? {
        CFGetTypeID(value) == AXUIElementGetTypeID() ? unsafeBitCast(value, to: AXUIElement.self) : nil
    }

    private func prepare(_ element: AXUIElement) -> Bool {
        let left = remaining
        guard left > 0 else { return false }
        return AXUIElementSetMessagingTimeout(element, Float(left)) == .success
    }

    private func failure(_ error: AXError) -> InputLookupError {
        switch error {
        case .noValue, .attributeUnsupported, .invalidUIElement, .success: return .noElement
        case .cannotComplete where remaining <= 0.005: return .timeout
        default: return .ax(error.rawValue)
        }
    }
}
