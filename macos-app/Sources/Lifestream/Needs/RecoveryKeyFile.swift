import AppKit
import Foundation
import Passwords
import UniformTypeIdentifiers

struct KeyName: Equatable {
    let number: Int
    let made: Date

    init(number: Int, madeMs: Int64) {
        self.number = number
        made = Date(timeIntervalSince1970: TimeInterval(madeMs) / 1000)
    }

    init(_ made: RecoveryMade) {
        self.init(number: made.number, madeMs: made.madeMs)
    }

    init?(_ slot: VaultState.Slot) {
        guard let number = slot.recovery, let made = slot.madeMs else { return nil }
        self.init(number: number, madeMs: made)
    }

    static func == (a: KeyName, b: KeyName) -> Bool {
        a.number == b.number && a.day == b.day
    }

    var title: String { "Recovery key \(number)" }
    var madeLine: String { "Made on \(day)" }
    var inLine: String { "recovery key \(number), made on \(day)" }
    var day: String { Self.day(made, "d MMMM yyyy") }
    var shortDay: String { Self.day(made, "d MMM yyyy") }

    static func opensWith(_ vault: VaultState?) -> String? {
        let names = (vault?.recoveries ?? []).compactMap(KeyName.init)
        guard !names.isEmpty else { return nil }
        return "\(vault?.keyed == true ? "Lifestream opens" : "Your passwords open") with \(names.map(\.inLine).joined(separator: ", or "))."
    }

    private static func day(_ date: Date, _ format: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = format
        return formatter.string(from: date)
    }
}

enum RecoveryKeyFile {
    static let inside = "Save it outside Lifestream's folder: a copy of the folder would carry its own key."

    enum Saved: Equatable {
        case saved(String)
        case refused(String)
    }

    static func name(_ key: KeyName) -> String {
        "Lifestream recovery key \(key.number) (\(key.shortDay)).txt"
    }

    static func grouped(_ key: String) -> String {
        let plain = Array(key.filter { !$0.isWhitespace })
        return stride(from: 0, to: plain.count, by: 4).map { String(plain[$0..<min($0 + 4, plain.count)]) }.joined(separator: " ")
    }

    static func text(key: String, name: KeyName, keyed: Bool) -> String {
        """
        Lifestream recovery key \(name.number)
        \(name.madeLine)

        \(grouped(key))

        It opens \(keyed ? "Lifestream and everything it keeps" : "your Lifestream passwords") on another Mac, or on this Mac if its Keychain loses Lifestream's key.
        A copy of Lifestream's folder from before a newer key opens only with the key of its time: keep this file with any such copy.
        Keep it away from this Mac: in your password manager, or printed.

        """
    }

    static func save(_ key: String, name: KeyName, keyed: Bool, to file: URL, folder: URL?) -> Saved {
        if let folder, inside(file, folder) { return .refused(inside) }
        do {
            try Data(text(key: key, name: name, keyed: keyed).utf8).write(to: file, options: .atomic)
            return .saved(file.lastPathComponent)
        } catch {
            return .refused("Lifestream couldn't save the file: \(error.localizedDescription). Choose another place, or copy the key.")
        }
    }

    static func inside(_ file: URL, _ folder: URL) -> Bool {
        let parent = real(file.deletingLastPathComponent())
        let target = FileManager.default.fileExists(atPath: file.path) ? real(file) : parent.appendingPathComponent(file.lastPathComponent)
        let root = real(folder).path
        let path = target.path
        return path == root || path.hasPrefix(root.hasSuffix("/") ? root : root + "/")
    }

    private static func real(_ url: URL) -> URL {
        guard let resolved = realpath(url.path, nil) else { return url.standardizedFileURL }
        defer { free(resolved) }
        return URL(fileURLWithPath: String(cString: resolved))
    }

    static var panelStart: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    @MainActor static func panel(_ name: String) -> NSSavePanel {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.allowedContentTypes = [.plainText]
        panel.canCreateDirectories = true
        panel.directoryURL = panelStart
        return panel
    }

    @MainActor static func choose(_ name: String, over window: NSWindow?) async -> URL? {
        let panel = panel(name)
        let answer = if let window { await panel.beginSheetModal(for: window) } else { panel.runModal() }
        return answer == .OK ? panel.url : nil
    }
}
