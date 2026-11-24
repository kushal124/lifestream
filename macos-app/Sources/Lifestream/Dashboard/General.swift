import AppKit
import Foundation

@MainActor final class General {
    struct System {
        var loginItem: @Sendable () async -> HomeAgents.AppLogin
        var setLoginItem: @Sendable (Bool) async throws -> Void
        var openLoginItems: @MainActor () -> Void
        var updates: Bool
        var installsAutomatically: @MainActor () -> Bool
        var setInstallsAutomatically: @MainActor (Bool) -> Void
        var checkForUpdates: @MainActor () -> Void
        var version: String?
        var uninstall: @MainActor () -> Void
        var setAppearance: @MainActor (AppAppearance) -> Void
        var command: (@Sendable (CommandAct?) async throws -> Command)? = nil
        var clock: @Sendable () -> Date = { Date() }
    }

    struct Command: Codable, Equatable, Sendable {
        enum Standing: String, Codable, Sendable { case installed, absent, blocked }
        let state: Standing
        let words: String
        let prompt: String
    }

    enum CommandAct: String, Equatable, Sendable { case install, remove }

    struct State: Encodable, Equatable {
        let login: Bool
        let autoUpdate: Bool
        let version: String
        let update: String?
        var byHand: String? = nil
        var command: Command? = nil

        private enum CodingKeys: String, CodingKey {
            case login, version, update, command
            case autoUpdate = "auto_update"
            case byHand = "by_hand"
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(login, forKey: .login)
            try container.encode(autoUpdate, forKey: .autoUpdate)
            try container.encode(version, forKey: .version)
            try container.encode(update, forKey: .update)
            try container.encode(byHand, forKey: .byHand)
            try container.encode(command, forKey: .command)
        }
    }

    static let handBuilt = HostRefusal("This build does not update itself. A new build is installed by hand.")

    let system: System
    private(set) var login: HomeAgents.AppLogin?
    private(set) var command: Command?
    private var commandAt: Date?
    static let commandStands: TimeInterval = 60

    init(system: System) {
        self.system = system
    }

    func read() async {
        login = await system.loginItem()
    }

    func readCommand() async -> Bool {
        guard let run = system.command else { return false }
        if let commandAt, system.clock().timeIntervalSince(commandAt) < Self.commandStands { return false }
        commandAt = system.clock()
        guard let answer = try? await run(nil) else { return false }
        commandAt = system.clock()
        command = answer
        return true
    }

    func state(update: String?) -> State? {
        login.map { State(login: $0 == .enabled, autoUpdate: system.installsAutomatically(), version: system.version ?? "",
                          update: update, byHand: system.updates ? nil : Self.handBuilt.words, command: command) }
    }

    func perform(_ act: HostAct.GeneralAct) async throws {
        switch act {
        case .login(let on):
            if on, login == .requiresApproval { return system.openLoginItems() }
            var refusal: HostRefusal?
            do { try await system.setLoginItem(on) } catch { refusal = HostRefusal(error.localizedDescription) }
            await read()
            if let refusal { throw refusal }
        case .autoUpdate(let on):
            guard system.updates else { throw Self.handBuilt }
            system.setInstallsAutomatically(on)
        case .check:
            guard system.updates else { throw Self.handBuilt }
            system.checkForUpdates()
        case .command(let act):
            guard let run = system.command else { throw HostRefusal.notHere }
            do { command = try await run(act) } catch { throw HostRefusal(error.localizedDescription) }
            commandAt = system.clock()
        case .uninstall:
            system.uninstall()
        case .appearance(let theme):
            system.setAppearance(theme)
        }
    }
}

@MainActor extension General.System {
    static func live(updates: Updates, uninstall: @escaping @MainActor () -> Void) -> Self {
        Self(loginItem: { await Task.detached { HomeAgents.appLogin }.value },
             setLoginItem: { on in
                 try await Task.detached {
                     if on { HomeAgents.openAtLogin() } else { try await HomeAgents.closeAtLogin() }
                 }.value
             },
             openLoginItems: { NSWorkspace.shared.open(Grant.openAtLogin.pane) },
             updates: updates.available,
             installsAutomatically: { updates.installsAutomatically },
             setInstallsAutomatically: { updates.installsAutomatically = $0 },
             checkForUpdates: { updates.checkForUpdates() },
             version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
             uninstall: uninstall,
             setAppearance: { $0.choose() },
             command: BundledRelease.inApp().map { release -> @Sendable (General.CommandAct?) async throws -> General.Command in
                 { act in try await Task.detached { try HomeAgents.command(act, release: release) }.value }
             })
    }
}

enum AppAppearance: String, Equatable, Sendable, CaseIterable {
    case system, light, dark

    static let key = "appearance"

    var appearance: NSAppearance? {
        switch self {
        case .system: nil
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        }
    }

    static func kept(_ defaults: UserDefaults = .standard) -> AppAppearance {
        defaults.string(forKey: key).flatMap(Self.init(rawValue:)) ?? .system
    }

    func keep(_ defaults: UserDefaults = .standard) {
        if self == .system { defaults.removeObject(forKey: Self.key) } else { defaults.set(rawValue, forKey: Self.key) }
    }

    @MainActor func choose() {
        keep()
        NSApp.appearance = appearance
    }
}
