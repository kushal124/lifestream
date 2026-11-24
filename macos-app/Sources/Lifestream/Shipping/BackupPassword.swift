import AppKit
import Foundation
import Security

struct BackupPassword: Sendable {
    let saved: @Sendable (_ udid: String) async -> String?
    let ask: @MainActor @Sendable (_ wrong: Bool) async -> String?

    @MainActor static func live(over window: @escaping @MainActor () -> NSWindow?) -> BackupPassword {
        BackupPassword(saved: { udid in await Task.detached(priority: .userInitiated) { finder(udid) }.value },
                       ask: { wrong in await sheet(over: window(), wrong: wrong) })
    }

    static let service = "iOS Backup"

    static func finder(_ udid: String) -> String? {
        if let password = item(account: udid) { return password }
        var found: CFTypeRef?
        let list: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                   kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
        guard SecItemCopyMatching(list as CFDictionary, &found) == errSecSuccess, let items = found as? [[String: Any]], items.count == 1,
              let account = items[0][kSecAttrAccount as String] as? String, account != udid else { return nil }
        return item(account: account)
    }

    private static func item(account: String) -> String? {
        var found: CFTypeRef?
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: account, kSecReturnData as String: true,
                                    kSecMatchLimit as String: kSecMatchLimitOne]
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static let title = "Password for this backup"
    static let line = "The password you set in Finder when you turned on Encrypt local backup. Lifestream uses it to read this backup and doesn't keep it."
    static let wrongLine = "That password doesn't open this backup."

    @MainActor static func sheet(over window: NSWindow?, wrong: Bool) async -> String? {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = line
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.placeholderString = "Password"
        let stack = NSStackView(frame: NSRect(x: 0, y: 0, width: 260, height: wrong ? 46 : 24))
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.addArrangedSubview(field)
        if wrong {
            let said = NSTextField(labelWithString: wrongLine)
            said.textColor = .systemRed
            said.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            stack.addArrangedSubview(said)
        }
        alert.accessoryView = stack
        alert.addButton(withTitle: "Read")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        let response: NSApplication.ModalResponse
        if let window {
            response = await withCheckedContinuation { continuation in
                alert.beginSheetModal(for: window) { continuation.resume(returning: $0) }
                if wrong { shake(alert.window) }
            }
        } else {
            response = alert.runModal()
        }
        let typed = field.stringValue
        field.stringValue = ""
        return response == .alertFirstButtonReturn && !typed.isEmpty ? typed : nil
    }

    @MainActor private static func shake(_ window: NSWindow) {
        let frame = window.frame
        let shake = CAKeyframeAnimation()
        let path = CGMutablePath()
        path.move(to: frame.origin)
        for _ in 0..<3 {
            path.addLine(to: CGPoint(x: frame.minX - 8, y: frame.minY))
            path.addLine(to: CGPoint(x: frame.minX + 8, y: frame.minY))
        }
        path.addLine(to: frame.origin)
        shake.path = path
        shake.duration = 0.4
        window.animations = ["frameOrigin": shake]
        window.animator().setFrameOrigin(frame.origin)
    }
}
