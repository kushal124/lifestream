import AppKit
import Passwords
import Recorder
import Shipping
import XCTest
@testable import Lifestream

@MainActor final class GeneralTests: XCTestCase {
    private func host(_ mac: FakeMac?) -> MacHost {
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        let needs = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        let lines = StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true))
        return MacHost(needs: needs, lines: lines,
                       socket: { nil }, readGrants: { [:] }, readFolder: { nil }, ask: .untouched,
                       general: mac.map { General(system: $0.system()) })
    }

    private func refusal(_ work: () async throws -> String?) async -> String? {
        do {
            _ = try await work()
            return nil
        } catch {
            return (error as? HostRefusal)?.words ?? "not words: \(error)"
        }
    }

    func testTheStateIsWhatMacOSAndTheUpdaterSay() async throws {
        let mac = FakeMac()
        let host = host(mac)
        XCTAssertNil(host.state.general, "stated before macOS was read")
        await host.read()
        try await until("the Command line row, read beside the window's reads") { host.state.general?.command != nil }
        XCTAssertEqual(host.state.general, General.State(login: false, autoUpdate: false, version: "2026.10.16", update: nil,
                                                         byHand: "This build does not update itself. A new build is installed by hand.",
                                                         command: FakeMac.answer(.absent)))
        mac.login = .requiresApproval
        await host.read()
        XCTAssertEqual(host.state.general?.login, false)
        mac.login = .enabled
        await host.read()
        XCTAssertEqual(host.state.general?.login, true)
        host.needs.update(holding: "2026.11.10", waiting: nil)
        XCTAssertEqual(host.state.general?.update, "Lifestream 2026.11.10 is ready")
        host.needs.update(holding: nil, waiting: nil)
        XCTAssertNil(host.state.general?.update)
    }

    func testOpenAtLoginChangesTheLoginItemThroughMacOS() async throws {
        let mac = FakeMac()
        let host = host(mac)
        await host.read()
        _ = try await host.perform(.general(.login(on: true)))
        XCTAssertEqual(mac.loginChanges, [true])
        XCTAssertEqual(host.state.general?.login, true, "not what macOS answers after")
        _ = try await host.perform(.general(.login(on: false)))
        XCTAssertEqual(mac.loginChanges, [true, false])
        XCTAssertEqual(host.state.general?.login, false)

        mac.login = .requiresApproval
        await host.read()
        _ = try await host.perform(.general(.login(on: true)))
        XCTAssertEqual(mac.loginChanges, [true, false])
        XCTAssertEqual(mac.openedLoginItems, 1)

        mac.login = .enabled
        mac.loginRefusal = "Operation not permitted"
        await host.read()
        let refused = await refusal { try await host.perform(.general(.login(on: false))) }
        XCTAssertEqual(refused, "Operation not permitted")
        XCTAssertEqual(host.state.general?.login, true)
    }

    func testTheUpdateActsAreTheUpdatersAndRefusedInABuildThatDoesNotUpdateItself() async throws {
        let mac = FakeMac()
        mac.updates = true
        let host = host(mac)
        await host.read()
        XCTAssertNil(host.state.general?.byHand, "a build that updates itself said not to")
        _ = try await host.perform(.general(.autoUpdate(on: true)))
        XCTAssertEqual(host.state.general?.autoUpdate, true)
        _ = try await host.perform(.general(.check))
        XCTAssertEqual(mac.checks, 1)

        let handBuilt = FakeMac()
        let hand = self.host(handBuilt)
        await hand.read()
        for act in [HostAct.GeneralAct.autoUpdate(on: true), .check] {
            let refused = await refusal { try await hand.perform(.general(act)) }
            XCTAssertEqual(refused, "This build does not update itself. A new build is installed by hand.", "\(act)")
        }
        XCTAssertEqual(handBuilt.checks, 0)
        XCTAssertEqual(hand.state.general?.autoUpdate, false)
        XCTAssertEqual(hand.state.general?.byHand, "This build does not update itself. A new build is installed by hand.")
    }

    func testUninstallRunsTheAppsUninstallOnceAndAHostWithNoGeneralRefusesItsActs() async throws {
        let mac = FakeMac()
        let host = host(mac)
        await host.read()
        XCTAssertEqual(mac.uninstalls, 0, "reading this Mac ran the uninstall")
        _ = try await host.perform(.general(.uninstall))
        XCTAssertEqual(mac.uninstalls, 1)

        let none = self.host(nil)
        await none.read()
        XCTAssertNil(none.state.general)
        let refused = await refusal { try await none.perform(.general(.uninstall)) }
        XCTAssertEqual(refused, HostRefusal.notHere.words)
    }

    func testTheCommandLineRowIsWhatTheCommandAnswersAfterEachAct() async throws {
        let mac = FakeMac()
        mac.commandAt = .absent
        let host = host(mac)
        await host.read()
        try await until("the row, read with the page") { host.state.general?.command == FakeMac.answer(.absent) }
        XCTAssertEqual(mac.commandCalls, ["command"], "the row was not read with the page")

        _ = try await host.perform(.general(.command(.install)))
        XCTAssertEqual(host.state.general?.command, FakeMac.answer(.installed))
        _ = try await host.perform(.general(.command(.remove)))
        XCTAssertEqual(host.state.general?.command?.state, .absent)
        await host.read()
        XCTAssertEqual(host.state.general?.command, FakeMac.answer(.absent), "Remove then a read again shows it installed")
        XCTAssertEqual(mac.commandCalls, ["command", "command install", "command remove"], "an activation within the minute ran the command")

        _ = try await host.perform(.general(.command(.install)))
        mac.commandAt = .absent
        mac.clock.advance(General.commandStands)
        await host.read()
        try await until("the link removed in a terminal, read as the app came back") { host.state.general?.command?.state == .absent }

        mac.commandAt = .blocked
        mac.clock.advance(General.commandStands)
        await host.read()
        try await until("the other program's link, read") { host.state.general?.command == FakeMac.answer(.blocked) }

        mac.commandRefusal = "Lifestream's command stopped with status 1"
        let refused = await refusal { try await host.perform(.general(.command(.install))) }
        XCTAssertEqual(refused, "Lifestream's command stopped with status 1")
        let asked = mac.commandCalls.count
        mac.clock.advance(General.commandStands)
        await host.read()
        try await until("the read the command refused") { mac.commandCalls.count == asked + 1 }
        XCTAssertEqual(host.state.general?.command, FakeMac.answer(.blocked), "a command that did not answer took the row away")

        let bare = FakeMac()
        bare.carriesRelease = false
        let none = self.host(bare)
        await none.read()
        XCTAssertNotNil(none.state.general)
        XCTAssertNil(none.state.general?.command)
        let notHere = await refusal { try await none.perform(.general(.command(.install))) }
        XCTAssertEqual(notHere, HostRefusal.notHere.words)
        XCTAssertEqual(bare.commandCalls, [])
        let stated = try XCTUnwrap(String(data: try JSONEncoder().encode(none.state.general), encoding: .utf8))
        XCTAssertTrue(stated.contains(#""command":null"#), stated)
        let installed = try XCTUnwrap(String(data: try JSONEncoder().encode(host.state.general), encoding: .utf8))
        XCTAssertTrue(installed.contains(#""command":{"#) && installed.contains(#""state":"blocked""#), installed)
    }

    func testTheThemeIsTheAppsAppearanceAndKeptAcrossLaunchesSystemByKeepingNothing() async throws {
        let mac = FakeMac()
        let host = host(mac)
        for theme in [AppAppearance.dark, .light, .system] {
            _ = try await host.perform(.general(.appearance(theme)))
        }
        XCTAssertEqual(mac.themes, [.dark, .light, .system])
        XCTAssertNil(AppAppearance.system.appearance)
        XCTAssertEqual(AppAppearance.light.appearance?.name, .aqua)
        XCTAssertEqual(AppAppearance.dark.appearance?.name, .darkAqua)
        let suite = "general-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(AppAppearance.kept(defaults), .system)
        AppAppearance.dark.keep(defaults)
        XCTAssertEqual(AppAppearance.kept(defaults), .dark)
        AppAppearance.system.keep(defaults)
        XCTAssertNil(defaults.object(forKey: AppAppearance.key))
        defaults.set("night", forKey: AppAppearance.key)
        XCTAssertEqual(AppAppearance.kept(defaults), .system)
    }
}

@MainActor private final class FakeMac {
    var login: HomeAgents.AppLogin = .notRegistered
    var loginChanges: [Bool] = []
    var loginRefusal: String?
    var openedLoginItems = 0
    var updates = false
    var automatic = false
    var checks = 0
    var uninstalls = 0
    var themes: [AppAppearance] = []
    var carriesRelease = true
    var commandAt: General.Command.Standing = .absent
    var commandRefusal: String?
    var commandCalls: [String] = []
    let clock = Clock()

    final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var now = Date(timeIntervalSince1970: 1_790_000_000)
        var date: Date { lock.withLock { now } }
        func advance(_ seconds: TimeInterval) { lock.withLock { now += seconds } }
    }

    struct Refusal: LocalizedError {
        let errorDescription: String?
    }

    static func answer(_ state: General.Command.Standing) -> General.Command {
        let prompt = "Lifestream runs on this Mac. Run ~/.local/bin/lifestream help connectors and follow it to add a connector for ___; type each lifestream command it names as ~/.local/bin/lifestream."
        switch state {
        case .installed: return General.Command(state: .installed, words: "lifestream works in new terminal windows.", prompt: prompt)
        case .absent: return General.Command(state: .absent, words: "Not installed.",
                                             prompt: prompt.replacingOccurrences(of: "~/.local/bin/lifestream", with: #""$HOME/Library/Application Support/Lifestream/current/bin/lifestream""#))
        case .blocked: return General.Command(state: .blocked, words: "Another program named lifestream is in ~/.local/bin. Lifestream left it alone.",
                                              prompt: prompt)
        }
    }

    func runCommand(_ act: General.CommandAct?) throws -> General.Command {
        commandCalls.append((["command"] + (act.map { [$0.rawValue] } ?? [])).joined(separator: " "))
        if let refusal = commandRefusal { throw Refusal(errorDescription: refusal) }
        switch act {
        case .install?: commandAt = .installed
        case .remove?: commandAt = .absent
        case nil: break
        }
        return Self.answer(commandAt)
    }

    func system() -> General.System {
        var command: (@Sendable (General.CommandAct?) async throws -> General.Command)?
        if carriesRelease {
            command = { act in try await MainActor.run { try self.runCommand(act) } }
        }
        return General.System(
            loginItem: { await MainActor.run { self.login } },
            setLoginItem: { on in
                try await MainActor.run {
                    if let refusal = self.loginRefusal { throw Refusal(errorDescription: refusal) }
                    self.loginChanges.append(on)
                    self.login = on ? .enabled : .notRegistered
                }
            },
            openLoginItems: { self.openedLoginItems += 1 },
            updates: updates,
            installsAutomatically: { self.automatic },
            setInstallsAutomatically: { self.automatic = $0 },
            checkForUpdates: { self.checks += 1 },
            version: "2026.10.16",
            uninstall: { self.uninstalls += 1 },
            setAppearance: { self.themes.append($0) },
            command: command,
            clock: { [clock] in clock.date })
    }
}
