import ApplicationServices
import Foundation

extension AccessibilityReader {
    enum Attribute: Int, CaseIterable {
        case role, subrole, title, description, value, position, size
        case enabled, visible, focused, selected, expanded, main, url, visibleChildren, children
        var nativeName: String {
            switch self {
            case .role: return kAXRoleAttribute
            case .subrole: return kAXSubroleAttribute
            case .title: return kAXTitleAttribute
            case .description: return kAXDescriptionAttribute
            case .value: return kAXValueAttribute
            case .position: return kAXPositionAttribute
            case .size: return kAXSizeAttribute
            case .enabled: return kAXEnabledAttribute
            case .visible: return "AXVisible"
            case .focused: return kAXFocusedAttribute
            case .selected: return kAXSelectedAttribute
            case .expanded: return kAXExpandedAttribute
            case .main: return kAXMainAttribute
            case .url: return kAXURLAttribute
            case .visibleChildren: return kAXVisibleChildrenAttribute
            case .children: return kAXChildrenAttribute
            }
        }
    }
    enum AttributeSlot {
        case value(CFTypeRef)
        case absent
        case failed(AXError)
        case unreadableError
    }
    struct AttributeBatch {
        let fields: [Attribute]
        let names: CFArray
        private let positions: [Int]
        init(_ fields: [Attribute]) {
            self.fields = fields
            names = fields.map(\.nativeName) as CFArray
            var positions = [Int](repeating: -1, count: Attribute.allCases.count)
            for (index, field) in fields.enumerated() { positions[field.rawValue] = index }
            self.positions = positions
        }
        func decode(_ raw: CFArray) -> AttributeValues? {
            guard CFArrayGetCount(raw) == fields.count else { return nil }
            return AttributeValues(raw: raw, positions: positions)
        }
    }
    struct AttributeValues {
        let raw: CFArray
        let positions: [Int]
        func slot(_ field: Attribute) -> AttributeSlot? {
            let index = positions[field.rawValue]
            guard index >= 0 else { return nil }
            let value = unsafeBitCast(CFArrayGetValueAtIndex(raw, index), to: CFTypeRef.self)
            if CFGetTypeID(value) == CFNullGetTypeID() { return .absent }
            if CFGetTypeID(value) == AXValueGetTypeID() {
                let ax = unsafeBitCast(value, to: AXValue.self)
                if AXValueGetType(ax) == .axError {
                    var error = AXError.success
                    guard AXValueGetValue(ax, .axError, &error) else { return .unreadableError }
                    if error == .attributeUnsupported || error == .noValue { return .absent }
                    return .failed(error)
                }
            }
            return .value(value)
        }
        subscript(_ field: Attribute) -> CFTypeRef? {
            guard case .value(let value) = slot(field) else { return nil }
            return value
        }
        func identity(_ field: Attribute) -> AccessibilityIdentityAttribute {
            switch slot(field) {
            case .value(let value): return (value as? String).map(AccessibilityIdentityAttribute.text) ?? .failed
            case .absent: return .absent
            default: return .failed
            }
        }
    }
}
