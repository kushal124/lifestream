import Foundation

enum AccessibilityIdentityAttribute: Equatable, Sendable {
    case text(String)
    case absent
    case failed
}

struct AccessibilityElementIdentity: Equatable, Sendable {
    let role: String
    let subrole: String?
    static func permittingContent(role: AccessibilityIdentityAttribute,
        subrole: AccessibilityIdentityAttribute) -> Self? {
        guard case .text(let role) = role, !role.isEmpty else { return nil }
        switch subrole {
        case .failed: return nil
        case .text("AXSecureTextField"): return nil
        case .text(let subrole): return Self(role: role, subrole: subrole)
        case .absent: return Self(role: role, subrole: nil)
        }
    }
}
