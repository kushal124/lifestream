import Darwin
import Foundation
import Passwords
import Shipping

enum Uninstall {
    enum Recovery: String, Decodable, Sendable {
        case confirmed, unconfirmed
    }

    struct Plan: Decodable, Equatable, Sendable {
        let folder: String?
        let here: Bool
        let refused: String?
        var recovery: Recovery?
        var keyed = false
        var keyHere = false

        var closesAccess: Bool { folder != nil && here && (!keyed || keyHere) }

        private enum CodingKeys: String, CodingKey {
            case folder, here, refused, recovery
        }
    }

    enum KeyStep: Equatable, Sendable {
        case saved, unsaved, cancelled
    }

    enum Vault: Equatable, Sendable {
        case none, kept, unsaved
    }

    struct Applied: Decodable, Equatable, Sendable {
        let home: String
        let folder: String?
        let revoked: Int?
        var claudeFailed: String? = nil

        private enum CodingKeys: String, CodingKey {
            case home, folder, revoked
            case claudeFailed = "claude_failed"
        }
    }

    struct Steps: Sendable {
        var key: @Sendable () async -> KeyStep
        var thisHome: @Sendable () -> HomeKey
        var quiet: @Sendable () async -> Void
        var removeAgents: @Sendable () async throws -> Void
        var apply: @Sendable (_ erase: Bool, _ slot: Data?) async throws -> Applied
        var deleteKeychain: @Sendable (KeychainItem) throws -> Void
        var remove: @Sendable (URL) throws -> Void
        var dropNames: @Sendable (URL) -> [String]?
    }

    struct Outcome: Equatable, Sendable {
        var stopped: String?
        var applied: Applied?
        var failures: [String] = []
        var dropKept: URL?
        var vault = Vault.none
        var keyed = false
    }

    static let vaultKeys = [KeychainItem.vaultMachine, KeychainItem.oldPasswords]
    static let pass = KeychainItem(service: "org.lifestreamprotocol.homelink", account: "pass")

    static func keychainItems(erase: Bool, keyed: Bool) -> [KeychainItem] {
        erase && !keyed ? vaultKeys + [pass] : [pass]
    }

    static func asksForKey(_ plan: Plan?, erase: Bool) -> Bool {
        !erase && (plan == nil || plan?.recovery == .unconfirmed)
    }

    static func vault(_ plan: Plan?, key: KeyStep?) -> Vault {
        if key == .unsaved { return .unsaved }
        return plan?.recovery == nil ? .none : .kept
    }

    static func files(user: URL) -> [URL] {
        ["Library/Application Support/Lifestream Screen", "Library/Logs/lifestream", "Library/Application Support/lifestream/ship",
         "Library/Application Support/Lifestream/scratch/mac"]
            .map { user.appendingPathComponent($0, isDirectory: true) }
    }

    static func macFiles(user: URL) -> URL {
        user.appendingPathComponent("Library/Application Support/Lifestream/\(MacFiles.fileName)")
    }

    static func appData(user: URL, bundle: String) -> [URL] {
        ["Library/Caches/\(bundle)", "Library/HTTPStorages/\(bundle)", "Library/HTTPStorages/\(bundle).binarycookies",
         "Library/WebKit/\(bundle)", "Library/Saved Application State/\(bundle).savedState",
         "Library/Preferences/\(bundle).plist"]
            .map { user.appendingPathComponent($0) }
    }

    static func run(_ plan: Plan?, erase: Bool, drop: URL, user: URL, steps: Steps, said: @Sendable (String) async -> Void) async -> Outcome? {
        var key: KeyStep?
        if asksForKey(plan, erase: erase) {
            key = await steps.key()
            if key == .cancelled { return nil }
        }
        let home = steps.thisHome()
        var outcome = Outcome(vault: vault(plan, key: key), keyed: home.keyed)
        await said("Stopping recording and syncing")
        await steps.quiet()
        await said("Stopping Lifestream's background jobs")
        do { try await steps.removeAgents() } catch {
            outcome.stopped = "macOS did not stop Lifestream's background jobs: \(error)"
            return outcome
        }
        await said(erase ? "Erasing what Lifestream kept" : "Closing Lifestream to your devices")
        let slot = erase || !home.keyed ? nil : await Task.detached { (try? home.read()) ?? nil }.value
        do { outcome.applied = try await steps.apply(erase, slot) } catch {
            outcome.stopped = "\(error)"
            return outcome
        }
        if let failed = outcome.applied?.claudeFailed {
            outcome.failures.append("Claude Code could not be signed out, so its sign-in may stay in the Keychain: \(failed)")
        }
        await said(erase ? "Removing Lifestream's keys from the Keychain" : "Removing this Mac's pass to Lifestream from the Keychain")
        for item in keychainItems(erase: erase, keyed: home.keyed) {
            do { try steps.deleteKeychain(item) } catch { outcome.failures.append("The Keychain item \(item.name): \(error)") }
        }
        if erase, home.keyed {
            do { try home.delete() } catch { outcome.failures.append("The Keychain item \(home.name): \(error)") }
        }
        await said("Removing captures, logs and caches")
        for file in files(user: user) + [macFiles(user: user)] {
            do { try steps.remove(file) } catch { outcome.failures.append("\(file.path): \(error.localizedDescription)") }
        }
        do { try steps.deleteKeychain(.macFiles) } catch { outcome.failures.append("The Keychain item \(KeychainItem.macFiles.name): \(error)") }
        if let names = steps.dropNames(drop) {
            if names.allSatisfy({ $0 == ".DS_Store" }) {
                do { try steps.remove(drop) } catch { outcome.failures.append("\(drop.path): \(error.localizedDescription)") }
            } else {
                outcome.dropKept = drop
            }
        }
        return outcome
    }

    static func live(key: @escaping @Sendable () async -> KeyStep, quiet: @escaping @Sendable () async -> Void) -> Steps {
        Steps(
            key: key,
            thisHome: { HomeKeys(reader: .app).thisHome() },
            quiet: quiet,
            removeAgents: {
                try await HomeAgents.remove()
                try await HomeAgents.untilNoneHeld()
            },
            apply: { erase, slot in
                guard let release = BundledRelease.inApp() else { throw ReleaseError(words: "this build of the app carries no release") }
                let data = try await Task.detached { () throws -> Data in
                    let arguments = applyArguments(erase: erase, slot: slot != nil)
                    guard let slot else { return try release.home(arguments) }
                    return try release.home(arguments, handing: keyOnInput(slot))
                }.value
                return try JSONDecoder().decode(Applied.self, from: data)
            },
            deleteKeychain: { try $0.delete() },
            remove: { url in
                do { try FileManager.default.removeItem(at: url) } catch CocoaError.fileNoSuchFile {}
            },
            dropNames: { try? FileManager.default.contentsOfDirectory(atPath: $0.path) })
    }

    static func applyArguments(erase: Bool, slot: Bool) -> [String] {
        ["uninstall", "--apply"] + (erase ? ["--erase"] : []) + (slot ? ["--key-on-input", "--json"] : [])
    }

    static func keyOnInput(_ slot: Data) -> Data {
        Data((slot.map { String(format: "%02x", $0) }.joined() + "\n").utf8)
    }

    static func plan() async -> Plan? {
        guard let release = BundledRelease.inApp() else { return nil }
        return await Task.detached {
            guard var plan = (try? release.home(["uninstall", "--erase"])).flatMap({ try? JSONDecoder().decode(Plan.self, from: $0) }) else { return nil }
            let home = HomeKeys(reader: .app).thisHome()
            plan.keyed = home.keyed
            plan.keyHere = home.keyed && (try? home.held()) == true
            return plan
        }.value
    }
}

enum Cleaner {
    static func script(pid: pid_t, paths: [URL], commands: [[String]]) -> String {
        let quoted = { (word: String) in "'" + word.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        var lines = ["#!/bin/sh",
                     "# Lifestream's uninstall: what is left once the app has quit.",
                     "while /bin/kill -0 \(pid) 2>/dev/null; do /bin/sleep 0.2; done"]
        lines += commands.map { $0.map(quoted).joined(separator: " ") + " >/dev/null 2>&1" }
        lines += paths.map { "/bin/rm -rf \(quoted($0.path))" }
        lines.append("/bin/rm -f \"$0\"")
        return lines.joined(separator: "\n") + "\n"
    }

    static func start(_ script: String) throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("lifestream-uninstall-\(UUID().uuidString).sh")
        try Data(script.utf8).write(to: file)
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID))
        var pid: pid_t = 0
        let arguments = ["/bin/sh", file.path].map { strdup($0) } + [nil]
        defer { arguments.forEach { free($0) } }
        let status = posix_spawn(&pid, "/bin/sh", nil, &attributes, arguments, environ)
        guard status == 0 else { throw ReleaseError(words: "the cleaner did not start: \(String(cString: strerror(status)))") }
    }

    static func forThisApp(user: URL = FileManager.default.homeDirectoryForCurrentUser, bundle: Bundle = .main) -> String {
        let id = bundle.bundleIdentifier ?? "org.lifestreamprotocol.screen-capture"
        return script(pid: getpid(),
                      paths: Uninstall.files(user: user) + Uninstall.appData(user: user, bundle: id) + [bundle.bundleURL],
                      commands: [["/usr/bin/defaults", "delete", id], ["/usr/bin/tccutil", "reset", "All", id]])
    }
}
