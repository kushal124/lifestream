import AppKit
import Foundation
import HomeLink
import Passwords
import XCTest
@testable import Lifestream

final class SetupTests: XCTestCase {
    private let build = "20261013.200000"

    private func world(placed: Bool = true, folder: Bool = true, release: Bool = true, outdated: Bool = false,
                       agents: HomeAgents.State = .current, except: [HomeJob: HomeAgents.State] = [:], paired: Bool = true) -> SetupWorld {
        var states = Dictionary(uniqueKeysWithValues: HomeJob.allCases.map { ($0, agents) })
        states.merge(except) { $1 }
        return SetupWorld(placed: placed, release: release, outdated: outdated,
                          folder: folder ? URL(fileURLWithPath: "/Volumes/Drive-A/Lifestream") : nil,
                          agents: states, paired: paired)
    }

    func testTheFirstRunOpensAtTheFirstScreenTheWorldDoesNotHold() {
        XCTAssertEqual(world(placed: false).opensAt, .move)
        XCTAssertEqual(world(placed: false, folder: false, release: false, agents: .notRegistered, paired: false).opensAt, .move)
        XCTAssertEqual(world(folder: false, release: false, agents: .notRegistered, paired: false).opensAt, .welcome)
        XCTAssertEqual(world(release: false, agents: .notRegistered, paired: false).opensAt, .welcome)
        XCTAssertEqual(world(agents: .notRegistered, paired: false).opensAt, .welcome)
        XCTAssertEqual(world(except: [.mcp: .stale]).opensAt, .welcome)
        XCTAssertEqual(world(agents: .requiresApproval).opensAt, .welcome)
        XCTAssertEqual(world(release: false).opensAt, .welcome)
        XCTAssertEqual(world(paired: false).opensAt, .welcome)
        XCTAssertNil(world().opensAt)
        XCTAssertNil(world(outdated: true).opensAt)
        XCTAssertEqual(world(except: [.home: .foreign, .door: .foreign]).opensAt, .welcome)
        XCTAssertEqual(world(except: [.resourceWatch: .notRegistered]).opensAt, .welcome)
    }

    func testNothingRecordsUntilTheAppIsPlacedAndHoldsAPass() {
        XCTAssertTrue(world().setUp)
        XCTAssertFalse(world(placed: false).setUp)
        XCTAssertFalse(world(folder: false, paired: false).setUp)
        XCTAssertFalse(world(paired: false).setUp)
        XCTAssertTrue(world(folder: false).setUp, "a Mac paired to a home elsewhere did not record")
        XCTAssertTrue(world(agents: .stale).setUp)
        XCTAssertNotNil(world(agents: .stale).opensAt)
        XCTAssertTrue(world(release: false).setUp)
    }

    func testTheHealInstallsTheReleaseThisAppCarriesOnlyOverNoneOrAnOlderOne() throws {
        let carried = ReleaseStamp(commit: "0dab33c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", generation: 1720)
        let older = ReleaseStamp(commit: "2165aaaacccccccccccccccccccccccccccccccc", generation: 1710)
        XCTAssertTrue(SetupWorld.outdated(current: nil, carried: carried), "nothing installed")
        XCTAssertFalse(SetupWorld.outdated(current: carried, carried: carried))
        XCTAssertTrue(SetupWorld.outdated(current: older, carried: carried))
        XCTAssertFalse(SetupWorld.outdated(current: older, carried: nil))
        XCTAssertFalse(SetupWorld.outdated(current: carried, carried: older))
        let legacy = ReleaseStamp(commit: "d67cde25bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", generation: nil)
        XCTAssertTrue(SetupWorld.outdated(current: legacy, carried: carried))
        XCTAssertFalse(SetupWorld.outdated(current: older, carried: legacy))
        XCTAssertFalse(SetupWorld.outdated(current: legacy, carried: legacy))

        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("stamp-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let manifest = folder.appendingPathComponent("RELEASE.json")
        try Data(#"{"commit":"0dab33c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","generation":1720,"built_ms":1791900000000,"floor":1713}"#.utf8).write(to: manifest)
        XCTAssertEqual(BundledRelease(folder: folder).stamp, carried)
        try Data(#"{"commit":"0dab33c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","generation":1720,"built_ms":1791900000000,"min_rollback":"d67cde25bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","readers":["d67cde25bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]}"#.utf8).write(to: manifest)
        XCTAssertEqual(ReleaseStamp(manifest: manifest), carried)
        try Data(#"{"commit":"d67cde25bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","built_ms":1791800000000}"#.utf8).write(to: manifest)
        XCTAssertEqual(ReleaseStamp(manifest: manifest), legacy)
        XCTAssertNil(ReleaseStamp(manifest: folder.appendingPathComponent("missing.json")))
    }

    func testAPassIsThatHomesUnlessTheHomeItLastHeardFromIsAnother() {
        XCTAssertFalse(SetupWorld.paired(holdsPass: false, passHome: nil, folderHome: "home-a"))
        XCTAssertTrue(SetupWorld.paired(holdsPass: true, passHome: "home-a", folderHome: "home-a"))
        XCTAssertFalse(SetupWorld.paired(holdsPass: true, passHome: "home-a", folderHome: "home-b"))
        XCTAssertTrue(SetupWorld.paired(holdsPass: true, passHome: "home-a", folderHome: nil))
        XCTAssertTrue(SetupWorld.paired(holdsPass: true, passHome: nil, folderHome: "home-a"))
    }

    func testAnAgentIsCurrentOnlyWhenLaunchdRunsItFromThisApp() {
        func state(_ registration: HomeAgents.Observed.Registration, _ held: HomeAgents.Observed.Held, handWritten: Bool = false) -> HomeAgents.State {
            HomeAgents.Observed(registration: registration, held: held, handWritten: handWritten).state(build: build)
        }
        XCTAssertEqual(state(.none, .none), .notRegistered)
        XCTAssertEqual(state(.requiresApproval, .none), .requiresApproval)
        XCTAssertEqual(state(.enabled, .byThisApp(build: build, refused: false, tried: true)), .current)
        XCTAssertEqual(state(.enabled, .byThisApp(build: build, refused: false, tried: false)), .starting)
        XCTAssertEqual(state(.enabled, .byThisApp(build: "20261012.090000", refused: false, tried: true)), .stale)
        XCTAssertEqual(state(.enabled, .byThisApp(build: "20261012.090000", refused: false, tried: false)), .stale)
        XCTAssertEqual(state(.enabled, .byThisApp(build: build, refused: true, tried: true)), .stale)
        XCTAssertEqual(state(.enabled, .byThisApp(build: nil, refused: false, tried: true)), .stale)
        XCTAssertEqual(state(.enabled, .none), .stale)
        XCTAssertEqual(state(.enabled, .byAnother), .foreign)
        XCTAssertEqual(state(.none, .none, handWritten: true), .foreign)
        XCTAssertEqual(state(.enabled, .byThisApp(build: build, refused: false, tried: true), handWritten: true), .foreign)
    }

    func testAReconcileRenewsEveryJobNotCurrentNorAwaitingApproval() {
        let states: [HomeJob: HomeAgents.State] = [.home: .current, .door: .stale, .dashboard: .notRegistered, .mcp: .requiresApproval,
                                                   .runner: .current, .resourceWatch: .current]
        XCTAssertEqual(HomeAgents.renewed(states), [.door, .dashboard])
        XCTAssertEqual(HomeAgents.renewed([.home: .starting, .door: .current, .dashboard: .current, .mcp: .current, .runner: .current,
                                           .resourceWatch: .current]), [])
    }

    func testAReconcileRegistersAllSixAgainWhenMacOSDroppedEveryOne() {
        let none = Dictionary(uniqueKeysWithValues: HomeJob.allCases.map { ($0, HomeAgents.State.notRegistered) })
        XCTAssertEqual(HomeAgents.renewed(none), HomeJob.allCases)
    }

    func testAJobAnotherDefinitionRunsIsRefusedByItsLabel() {
        let current = Dictionary(uniqueKeysWithValues: HomeJob.allCases.map { ($0, HomeAgents.State.current) })
        XCTAssertNil(HomeAgents.foreignRefusal(current))
        var states = current
        states[.door] = .foreign
        states[.resourceWatch] = .foreign
        XCTAssertEqual(HomeAgents.foreignRefusal(states, user: 501),
                       "Lifestream's jobs run only from this app, and another definition runs org.lifestreamprotocol.door, org.lifestreamprotocol.resource-watch. "
                       + "Remove each (launchctl bootout gui/501/<label>, then delete ~/Library/LaunchAgents/<label>.plist), then try again.")
    }

    func testTheAnswersFailureShowsTheLastLinesOfEachLog() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("logs-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let home = folder.appendingPathComponent("home.log"), door = folder.appendingPathComponent("door.log")
        let lines = (1...5_000).map { "synthetic line \($0)" }
        try Data((lines.joined(separator: "\n") + "\n").utf8).write(to: home)
        let tail = SetupStart.logTail(home: home, door: door)
        XCTAssertEqual(SetupStart.tail(home)?.split(separator: "\n").map(String.init), Array(lines.suffix(SetupStart.logLines)))
        XCTAssertTrue(tail.hasPrefix("home.log:\nsynthetic line 4993"))
        XCTAssertTrue(tail.contains("door.log:\n(no log yet)"))
        XCTAssertFalse(tail.contains("synthetic line 4992"))
    }

    func testTheAgentsRunTheAppOnlyFromWhereItStays() {
        let user = URL(fileURLWithPath: "/Users/person-a")
        XCTAssertNil(HomeAgents.placeRefusal(URL(fileURLWithPath: "/Applications/Lifestream.app"), user: user, writable: { _ in true }))
        XCTAssertNil(HomeAgents.placeRefusal(URL(fileURLWithPath: "/Users/person-a/Applications/Lifestream.app"), user: user, writable: { _ in true }))
        XCTAssertNotNil(HomeAgents.placeRefusal(URL(fileURLWithPath: "/Users/person-a/Downloads/Lifestream.app"), user: user))
        XCTAssertNotNil(HomeAgents.placeRefusal(URL(fileURLWithPath: "/Applications/Lifestream.app"), user: user, writable: { _ in false }))
        XCTAssertNotNil(HomeAgents.placeRefusal(URL(fileURLWithPath: "/Applications/Lifestream.app"), user: user, writable: { $0 != "/Applications" }))
        XCTAssertNotNil(HomeAgents.placeRefusal(URL(fileURLWithPath: "/private/var/folders/xx/AppTranslocation/0000/d/Lifestream.app"), user: user))
    }

    func testLaunchctlPrintSaysWhoSubmittedTheJobAndItsProcess() {
        let running = """
            gui/501/org.lifestreamprotocol.door = {
            \tactive count = 1
            \tpath = (submitted by smd.91)
            \tmanaged_by = com.apple.xpc.ServiceManagement
            \tstate = running
            \tparent bundle version = 20261013.200000
            \tpid = 618
            \tlast exit code = (never exited)
            \tresource coalition = {
            \t\tID = 779
            \t}
            }
            """
        XCTAssertEqual(Launchd.parse(running), Launchd.Job(submittedByApp: true, build: "20261013.200000", refused: false, tried: true))
        let refused = """
            gui/501/org.lifestreamprotocol.mcp = {
            \tmanaged_by = com.apple.xpc.ServiceManagement
            \tstate = spawn scheduled
            \tparent bundle version = 20261013.200000
            \tlast exit code = 78: EX_CONFIG
            \tevent triggers = {
            \t\torg.lifestreamprotocol.mcp => {
            \t\t\tpid = 4
            \t\t}
            \t}
            \tjob state = spawn failed
            \tproperties = keepalive | runatload | needs LWCR update | has LWCR
            }
            """
        XCTAssertEqual(Launchd.parse(refused), Launchd.Job(submittedByApp: true, build: "20261013.200000", refused: true, tried: true))
        let submitted = """
            gui/501/org.lifestreamprotocol.home = {
            \tmanaged_by = com.apple.xpc.ServiceManagement
            \tstate = spawn scheduled
            \tparent bundle version = 20261013.200000
            \tlast exit code = (never exited)
            }
            """
        XCTAssertEqual(Launchd.parse(submitted), Launchd.Job(submittedByApp: true, build: "20261013.200000", refused: false, tried: false))
        let betweenTries = """
            gui/501/org.lifestreamprotocol.door = {
            	active count = 0
            	path = (submitted by smd.89)
            	type = Submitted
            	managed_by = com.apple.xpc.ServiceManagement
            	state = spawn scheduled
            	parent bundle version = 20261013.200000
            	runs = 6
            	last exit code = 78: EX_CONFIG
            	resource coalition = {
            		state = active
            	}
            }
            """
        XCTAssertEqual(Launchd.parse(betweenTries), Launchd.Job(submittedByApp: true, build: "20261013.200000", refused: true, tried: true))
        let job = Launchd.parse(betweenTries)
        XCTAssertEqual(HomeAgents.Observed(registration: .enabled, held: .byThisApp(build: job.build, refused: job.refused, tried: job.tried),
                                           handWritten: false).state(build: build), .stale)
        let handWritten = """
            gui/501/org.lifestreamprotocol.home = {
            \tpath = /Users/person-a/Library/LaunchAgents/org.lifestreamprotocol.home.plist
            \tstate = running
            \tpid = 900
            }
            """
        XCTAssertEqual(Launchd.parse(handWritten), Launchd.Job(submittedByApp: false, build: nil, refused: false, tried: true))
    }

    func testEachInstallIsLogged() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("install-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appendingPathComponent("release", isDirectory: true)
        let machine = root.appendingPathComponent("machine", isDirectory: true)
        let log = root.appendingPathComponent("logs/install.log")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data(#"{"commit":"0dab33c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","generation":1720}"#.utf8).write(to: folder.appendingPathComponent("RELEASE.json"))
        let release = BundledRelease(folder: folder)
        func install(_ script: String) async throws -> String? {
            let node = folder.appendingPathComponent("node")
            try Data("#!/bin/sh\n\(script)\n".utf8).write(to: node)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
            return await SetupWorld.update(carried: release, machine: machine, log: log)
        }

        let refused = try await install("echo 'synthetic: a restart failed'; exit 1")
        XCTAssertEqual(refused, "synthetic: a restart failed", "the need keeps the install's words")
        let installed = try await install(#"echo '{"release":"0dab33c0","restarted":["door"]}'"#)
        XCTAssertNil(installed)

        let lines = try String(contentsOf: log, encoding: .utf8).split(separator: "\n").map {
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
        }
        XCTAssertEqual(lines.count, 2, "one line per install")
        XCTAssertEqual(lines[0]["release"] as? String, "0dab33c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        XCTAssertEqual(lines[0]["refused"] as? String, "synthetic: a restart failed")
        XCTAssertNotNil(lines[0]["at"] as? String)
        XCTAssertEqual((lines[1]["installed"] as? [String: Any])?["restarted"] as? [String], ["door"])
    }

    func testTheQuarantineMarkGoesOnceBeforeTheReleaseRuns() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("release-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let addOn = folder.appendingPathComponent("node_modules/add-on/addon.node")
        try FileManager.default.createDirectory(at: addOn.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("synthetic".utf8).write(to: addOn)
        let node = folder.appendingPathComponent("node")
        try Data(#"""
            #!/bin/sh
            if xattr -p com.apple.quarantine "$(dirname "$0")/node_modules/add-on/addon.node" >/dev/null 2>&1; then echo '{"marked":true}'; else echo '{"marked":false}'; fi
            """#.utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        let quarantine = "com.apple.quarantine"
        let value = Array("0083;6accd84a;Safari;".utf8)
        func mark(_ url: URL) { XCTAssertEqual(setxattr(url.path, quarantine, value, value.count, 0, XATTR_NOFOLLOW), 0) }
        func marked(_ url: URL) -> Bool { getxattr(url.path, quarantine, nil, 0, 0, XATTR_NOFOLLOW) >= 0 }
        let release = BundledRelease(folder: folder)
        func run() async throws -> String {
            String(decoding: try await Task.detached { try release.home(["machine"]) }.value, as: UTF8.self)
        }

        for url in [folder, addOn.deletingLastPathComponent(), addOn, node] { mark(url) }
        let first = try await run()
        XCTAssertEqual(first, #"{"marked":false}"#, "the add-on was still marked when the release ran")
        XCTAssertFalse([folder, addOn.deletingLastPathComponent(), addOn, node].contains(where: marked))
        mark(addOn)
        _ = try await run()
        XCTAssertTrue(marked(addOn))
        mark(folder)
        let finished = try await run()
        XCTAssertEqual(finished, #"{"marked":false}"#)
        XCTAssertFalse(marked(folder) || marked(addOn))
    }

    private func commandRelease(holdingInstall: Bool = false) throws -> (BundledRelease, calls: URL, machine: URL) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("release-\(UUID().uuidString)", isDirectory: true)
        let machine = folder.appendingPathComponent("machine", isDirectory: true)
        try FileManager.default.createDirectory(at: machine, withIntermediateDirectories: true)
        let calls = folder.appendingPathComponent("calls")
        let node = folder.appendingPathComponent("node")
        if holdingInstall { XCTAssertEqual(mkfifo(folder.appendingPathComponent("gate").path, 0o600), 0) }
        let hold = holdingInstall ? #"""
            case " $* " in
              *" install "*) if [ ! -f "$here/machine/command.json" ]; then read line < "$here/gate"; echo '{}' > "$here/machine/command.json"; fi ;;
            esac
            """# : ""
        try Data((#"""
            #!/bin/sh
            shift
            here="$(dirname "$0")"
            echo "$*" >> "$here/calls"
            """# + "\n" + hold + "\n" + #"""
            [ -p "$here/gate" ] && echo "$* done" >> "$here/calls"
            case " $* " in
              *" --json "*) echo '{"state":"installed","link":"~/.local/bin/lifestream","words":"lifestream works in new terminal windows.","did":[],"prompt":"Lifestream runs on this Mac. Run ~/.local/bin/lifestream help connectors and follow it to add a connector for ___; type each lifestream command it names as ~/.local/bin/lifestream."}' ;;
              *) echo 'linked ~/.local/bin/lifestream'; echo 'lifestream works in new terminal windows.' ;;
            esac
            """#).utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        return (BundledRelease(folder: folder), calls, machine)
    }

    private func lines(_ url: URL) -> [String] {
        ((try? String(contentsOf: url, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    }

    func testEveryCommandCallPassesJsonAndReadsTheAnswer() async throws {
        let (release, calls, _) = try commandRelease()
        for act in [General.CommandAct?.none, .install, .remove] {
            let answer = try await Task.detached { try release.command(act) }.value
            XCTAssertEqual(answer.state, .installed)
            XCTAssertEqual(answer.words, "lifestream works in new terminal windows.")
            XCTAssertTrue(answer.prompt.contains("add a connector for ___;"), answer.prompt)
        }
        XCTAssertEqual(lines(calls),
                       ["command --json", "command install --json", "command remove --json"])
    }

    func testTheLaunchInstallsTheCommandOnceAndAfterThatOnlyKeepsIt() async throws {
        let (release, calls, machine) = try commandRelease()
        await Task.detached { HomeAgents.keepCommand(release, machine: machine) }.value
        try Data("{}".utf8).write(to: machine.appendingPathComponent("command.json"))
        await Task.detached { HomeAgents.keepCommand(release, machine: machine) }.value
        XCTAssertEqual(lines(calls),
                       ["command install --json", "command --json"])
        await Task.detached { HomeAgents.keepCommand(nil, machine: machine) }.value
        XCTAssertEqual(lines(calls).count, 2)
    }

    func testACommandRunWaitsForTheOneGoingSoAPressDuringTheLaunchsInstallStartsOnWhatItWrote() async throws {
        let (release, calls, machine) = try commandRelease(holdingInstall: true)
        let gate = machine.deletingLastPathComponent().appendingPathComponent("gate")
        let runs = CommandRuns()
        let keep = Task.detached { HomeAgents.keepCommand(release, machine: machine, runs: runs) }
        try await until("the launch's install, waiting on the shell") { self.lines(calls) == ["command install --json"] }
        let press = Task.detached { try HomeAgents.command(.install, release: release, runs: runs) }
        let read = Task.detached { try HomeAgents.command(nil, release: release, runs: runs) }
        try await until("the press and the row's read, waiting for the launch's run") { runs.waiting == 2 }
        XCTAssertEqual(lines(calls), ["command install --json"], "a run started beside the launch's install")

        await Task.detached { try? "go\n".write(to: gate, atomically: false, encoding: .utf8) }.value
        await keep.value
        _ = try await press.value
        _ = try await read.value
        let ran = lines(calls)
        XCTAssertEqual(ran.count, 6, "\(ran)")
        XCTAssertEqual(Array(ran.prefix(2)), ["command install --json", "command install --json done"])
        for pair in stride(from: 0, to: ran.count, by: 2) {
            XCTAssertEqual(ran[pair + 1], ran[pair] + " done", "two runs at once: \(ran)")
        }
        XCTAssertEqual(Set(ran.suffix(4)), ["command install --json", "command install --json done", "command --json", "command --json done"])
        XCTAssertEqual(runs.waiting, 0)

        await Task.detached { HomeAgents.keepCommand(release, machine: machine, runs: runs) }.value
        XCTAssertEqual(lines(calls).suffix(2), ["command --json", "command --json done"])
    }

    @MainActor
    private func pairedThroughSetUp(_ fixture: MacFilesFixture, form: MachineLook.Form, id: String? = nil) async throws -> (SetupStart, HomeLink) {
        let process = fixture.process(.app)
        XCTAssertEqual(process.opened, .open)
        let link = MacLink.link(process, files: try XCTUnwrap(process.files), root: fixture.machine.appendingPathComponent("ship", isDirectory: true), transport: PairDoor())
        let home = FirstRunTests.FakeHome(SetupHost.standardFolder)
        let start = SetupStart(pair: { door, code in
            do {
                _ = try await link.pair(code: code, name: door, offers: [])
                return .paired
            } catch {
                return SetupStart.Paired(failed: error)
            }
        })
        let world = SetupWorld(placed: true, release: false, outdated: false, folder: nil,
                               agents: Dictionary(uniqueKeysWithValues: HomeJob.allCases.map { ($0, .notRegistered) }), paired: false)
        let folder = MachineLook.Folder(path: fixture.root.appendingPathComponent("Lifestream").path, refused: nil, free_bytes: 1.2e12,
                                        door: "http://127.0.0.1:4680", form: form, id: id)
        let suite = "SetupTests-\(UUID().uuidString)"
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let setup = SetupHost(world: world, start: start, release: nil, steps: home.steps, name: "Desk Mac",
                              look: MachineLook(folder: folder), defaults: try XCTUnwrap(UserDefaults(suiteName: suite)),
                              quit: { XCTFail("Set up quit the app") })
        let board = NSPasteboard(name: NSPasteboard.Name("setup-tests-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        setup.key.board = board
        setup.key.later = { _, _ in }
        await setup.setUp()
        try await until("the first run stops or shows its key") { start.phase != .running || setup.key.shown != nil }
        if setup.key.shown != nil {
            _ = try await setup.key.perform(.copy, over: nil)
            _ = try await setup.key.perform(.saved, over: nil)
            try await until("the first run stops") { start.phase != .running }
        }
        return (start, link)
    }

    private func encrypted(_ file: URL) throws -> Bool {
        (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) == nil
    }

    @MainActor
    func testAKeyedHomesPairingAnswerMakesTheMacKeyedBeforeAnyAnswerFileForANewKeyedHomeAndAKeptOneAlike() async throws {
        for (form, id) in [(MachineLook.Form.empty, nil), (.keyed, "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b")] as [(MachineLook.Form, String?)] {
            let fixture = try MacFilesFixture()
            defer { fixture.remove() }
            let (start, link) = try await pairedThroughSetUp(fixture, form: form, id: id)
            XCTAssertEqual(start.phase, .done, "\(form)")
            XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.machine.appendingPathComponent(MacFiles.fileName).path),
                          "\(form): the pairing answer did not make the Mac keyed")
            let ship = fixture.machine.appendingPathComponent("ship", isDirectory: true)
            for name in ["credentials.json", "answer.json"] {
                let file = ship.appendingPathComponent(name)
                XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "\(form): \(name) was written before the switch emptied the folder")
                XCTAssertTrue(try encrypted(file), "\(form): \(name) written plain")
            }
            XCTAssertNotNil(link.saved, "\(form): the kept answer does not read back through the process's instance")
            XCTAssertEqual(fixture.watcher.made, ["stop", "start"], "\(form)")
            XCTAssertNotNil(fixture.store.data, "\(form): no key was made")
        }
    }

    @MainActor
    func testARecordingMacIsRefusedAtPairingAndWritesNothingOfTheAnswer() async throws {
        let fixture = try MacFilesFixture()
        defer { fixture.remove() }
        try FileManager.default.createDirectory(at: fixture.spool.appendingPathComponent("2026-11-18", isDirectory: true),
                                                withIntermediateDirectories: true)
        let (start, link) = try await pairedThroughSetUp(fixture, form: .empty)
        guard case .failed(let details) = start.phase else { return XCTFail("a recording Mac paired: \(start.phase)") }
        XCTAssertTrue(details.hasPrefix(MacFiles.Refusal.recording.description), details)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.machine.appendingPathComponent(MacFiles.fileName).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.machine.appendingPathComponent("ship/answer.json").path))
        XCTAssertNil(link.saved)
        XCTAssertEqual(fixture.watcher.made, [], "the watcher was stopped for a refused switch")
        XCTAssertNil(fixture.store.data, "a key was made for a refused switch")
    }

    private final class PairDoor: HomeTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var turn = 0

        func perform(_ request: HomeRequest) async throws -> HomeResponse {
            let n = lock.withLock { () -> Int in
                turn += 1
                return turn
            }
            let answer: [String: Any] = ["home": ["id": "h-00000001", "version": "5b3c0d2", "floors": ["mac": "0.0.0"]],
                                         "pass": "p-00000001", "unit": "macbook-pro-0001", "sources": [String: Any](), "owner": [String](),
                                         "needs": [Any](), "calls": [Any](), "settings": [String: Any](), "keyed": true,
                                         "turn": ["run": "0000000000057a27", "n": n]]
            switch request.url.path {
            case "/v1/pair":
                return HomeResponse(status: 200, body: try JSONSerialization.data(withJSONObject: ["unit": "macbook-pro-0001", "answer": answer]))
            case "/v1/exchange":
                return HomeResponse(status: 200, body: try JSONSerialization.data(withJSONObject: answer))
            default:
                return HomeResponse(status: 404, body: Data("{}".utf8))
            }
        }
    }
}
