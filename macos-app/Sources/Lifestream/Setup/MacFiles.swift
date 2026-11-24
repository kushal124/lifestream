import CryptoKit
import Darwin
import DeviceFiles
import Evidence
import Foundation
import Passwords

struct MacFiles: Sendable {
    enum Refusal: Error, Equatable, CustomStringConvertible {
        case recording
        case keychain(String)
        case form(String)
        case unlisted(String)

        var description: String {
            switch self {
            case .recording:
                return "This Mac already holds recordings. Uninstall Lifestream on this Mac, keeping your Lifestream data, "
                    + "then set it up again. Uninstall deletes what this Mac recorded and has not sent."
            case .keychain(let why): return why
            case .form: return MacFiles.formWords
            case .unlisted(let folder):
                return "Lifestream can't look inside \(folder), so it changed nothing. Try again."
            }
        }
    }

    enum Opened {
        case files(DeviceFiles)
        case startedAgain(DeviceFiles)
        case refused(String)
    }

    enum Step: Equatable, Sendable {
        case carry, empty, form, formed, rename
    }

    struct Watcher: Sendable {
        var stop: @Sendable () throws -> Void
        var start: @Sendable () -> Void
    }

    static let fileName = "mac-files.json"
    static let goneWords = "This Mac's Keychain no longer holds the key that opens what this Mac recorded. Open Lifestream and click Allow."
    static let formWords = "Lifestream can't read which key opens what this Mac records. Uninstall Lifestream on this Mac, keeping your "
        + "Lifestream data, then set it up again."
    static let unmadeWords = "Lifestream couldn't make a new key in this Mac's Keychain. Click Allow to try again."
    static let launchWithin: TimeInterval = 5

    private static let diagnostics = [#"^\.writer\.lock$"#, #"^runtime\.json$"#,
                                      #"^resources/(watch|recorder|diagnostics)-\d{4}-\d{2}-\d{2}\.jsonl$"#]
    private static let switchKeeps = diagnostics + ["^\(NSRegularExpression.escapedPattern(for: RecordingModes.fileName))(\\.carry)?$"]
    private static let dayFolder = #"^\d{4}-\d{2}-\d{2}$"#

    let machine: URL
    let spool: URL
    let ship: URL
    let key: HomeKey
    let plain: DeviceFiles
    let watcher: Watcher
    var step: @Sendable (Step) throws -> Void = { _ in }

    var formFile: URL { machine.appendingPathComponent(Self.fileName) }
    private var modes: URL { spool.appendingPathComponent(RecordingModes.fileName) }
    private var carry: URL { spool.appendingPathComponent(RecordingModes.fileName + ".carry") }

    func open(within seconds: TimeInterval = MacFiles.launchWithin) -> Opened {
        open { $0.found(within: seconds) }
    }

    func open(reading read: (HomeKey) -> KeyFound) -> Opened {
        let id: String?
        do {
            id = try keyID()
            if id != nil { try finishCarry() }
        } catch {
            return .refused("\(error)")
        }
        guard let id else { return .files(DeviceFiles(.plain)) }
        switch read(key) {
        case .key(let data) where VaultKeyID.of(data) == id:
            return .files(DeviceFiles(.keyed(SymmetricKey(data: data))))
        case .key, .gone:
            guard key.reader == .app else { return .refused(Self.goneWords) }
            do {
                return .startedAgain(try startAgain())
            } catch {
                return .refused(Self.unmadeWords)
            }
        case .malformed:
            return .refused(Self.formWords)
        case .refused(let why):
            return .refused(why)
        }
    }

    func becomeKeyed(_ files: DeviceFiles) throws {
        guard try !recording() else { throw Refusal.recording }
        let made: Data
        do {
            if try key.held() {
                guard let held = try key.read() else { throw KeyStoreError.unread }
                made = held
            } else {
                made = try key.make()
            }
        } catch {
            throw Refusal.keychain(Self.reason(error))
        }
        let id = VaultKeyID.of(made)
        try watcher.stop()
        defer { watcher.start() }
        try files.becomeKeyed(SymmetricKey(data: made)) { keyed in
            guard try !recording() else { throw Refusal.recording }
            try step(.carry)
            try carryModes(through: keyed)
            try step(.empty)
            try empty(keeping: Self.switchKeeps)
            try step(.form)
            do {
                try writeForm(id)
                try step(.formed)
            } catch {
                guard (try? keyID()) == id else { throw error }
            }
            try? finishSwitch()
        }
    }

    private func finishSwitch() throws {
        try step(.rename)
        try finishCarry()
    }

    private func startAgain() throws -> DeviceFiles {
        let made: Data
        do {
            try key.delete()
            made = try key.make()
        } catch {
            throw Refusal.keychain(Self.reason(error))
        }
        try watcher.stop()
        defer { watcher.start() }
        try empty(keeping: Self.diagnostics)
        try writeForm(VaultKeyID.of(made))
        return DeviceFiles(.keyed(SymmetricKey(data: made)))
    }

    func keyID() throws -> String? {
        let data: Data?
        do {
            data = try plain.read(formFile, maximumBytes: 1024)
        } catch {
            throw Refusal.form("\(error)")
        }
        guard let data else { return nil }
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], object.count == 2,
              object["form"] as? String == "keyed", let id = object["key"] as? String,
              id.range(of: #"^[0-9a-f]{8}$"#, options: .regularExpression) != nil else {
            throw Refusal.form("it does not say a keyed form and a key's id")
        }
        return id
    }

    private func recording() throws -> Bool {
        if try Self.listing(spool).contains(where: { $0.range(of: Self.dayFolder, options: .regularExpression) != nil }) { return true }
        return try ["ledger", "pending"].contains { !(try Self.listing(ship.appendingPathComponent($0))).isEmpty }
    }

    private static func listing(_ folder: URL) throws -> [String] {
        do {
            return try FileManager.default.contentsOfDirectory(atPath: folder.path)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
            return []
        } catch {
            throw Refusal.unlisted(folder.lastPathComponent)
        }
    }

    private func carryModes(through keyed: DeviceFiles) throws {
        guard let chosen = try plain.read(modes, maximumBytes: 1 << 20) else {
            try remove(carry)
            return
        }
        try keyed.replace(carry, with: chosen, commit: .durable)
    }

    private func finishCarry() throws {
        guard FileManager.default.fileExists(atPath: carry.path) else { return }
        guard Darwin.rename(carry.path, modes.path) == 0 else {
            throw Refusal.form("\(RecordingModes.fileName) was not put in place: \(String(cString: strerror(errno)))")
        }
        try DeviceFiles.syncDirectory(spool)
    }

    private func writeForm(_ id: String) throws {
        try FileManager.default.createDirectory(at: machine, withIntermediateDirectories: true)
        try plain.replace(formFile, with: Data(#"{"form":"keyed","key":"\#(id)"}"#.utf8), commit: .durable)
    }

    private func empty(keeping kept: [String]) throws {
        try sweep(spool, "", kept)
        try sweep(ship, "ship", kept)
    }

    private func sweep(_ folder: URL, _ relative: String, _ kept: [String]) throws {
        for name in try Self.listing(folder) {
            let url = folder.appendingPathComponent(name)
            let path = relative.isEmpty ? name : "\(relative)/\(name)"
            let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            if values.isDirectory == true, values.isSymbolicLink != true {
                try sweep(url, path, kept)
            } else if !kept.contains(where: { path.range(of: $0, options: .regularExpression) != nil }) {
                try remove(url)
            }
        }
    }

    private func remove(_ url: URL) throws {
        do { try FileManager.default.removeItem(at: url) } catch CocoaError.fileNoSuchFile {}
    }

    private static func reason(_ error: Error) -> String {
        (error as? KeyStoreError)?.reason ?? "\(error)"
    }
}
