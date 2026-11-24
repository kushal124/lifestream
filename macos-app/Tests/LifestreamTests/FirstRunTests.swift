import AppKit
import Combine
import HomeLink
import Passwords
import Recorder
import Shipping
import XCTest
@testable import Lifestream

@MainActor final class FirstRunTests: XCTestCase {
    private var scratch: URL!
    private var suite = ""

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("first-run-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        suite = "FirstRunTests-\(UUID().uuidString)"
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: scratch)
    }

    private func fresh(_ folder: URL?) -> SetupWorld {
        SetupWorld(placed: true, release: false, outdated: false, folder: folder,
                   agents: Dictionary(uniqueKeysWithValues: HomeJob.allCases.map { ($0, .notRegistered) }), paired: false)
    }
    private var fresh: SetupWorld { fresh(folder) }
    private var folder: URL { scratch.appendingPathComponent("Lifestream") }

    private func look(free: Double, refused: String? = nil) -> MachineLook {
        MachineLook(folder: .init(path: folder.path, refused: refused, free_bytes: free,
                                  door: "http://127.0.0.1:4680", form: .plain))
    }

    final class FakeHome: @unchecked Sendable {
        let folder: URL
        init(_ folder: URL) { self.folder = folder }
        private let lock = NSLock()
        private var _asked: [String] = []
        private var _answersAfter = 2
        private var _loginWaits = false
        private var _paired = false
        private var _passRefused = false
        private var _starting = 0
        private var _pairNotNow = 0
        private var _locked = 0
        private var _waits: [String?] = []
        private var _clock = Date(timeIntervalSince1970: 1_790_000_000)
        var asked: [String] { lock.withLock { _asked } }
        var starting: Int {
            get { lock.withLock { _starting } }
            set { lock.withLock { _starting = newValue } }
        }
        var retryAfter: TimeInterval? = 0.005
        var words = FakeHome.startingWords
        var starts = true
        var pairNotNow: Int {
            get { lock.withLock { _pairNotNow } }
            set { lock.withLock { _pairNotNow = newValue } }
        }
        var waits: [String?] { lock.withLock { _waits } }
        var locked: Int {
            get { lock.withLock { _locked } }
            set { lock.withLock { _locked = newValue } }
        }
        var seeWaits: (@Sendable () async -> String?)?
        var answersAfter: Int {
            get { lock.withLock { _answersAfter } }
            set { lock.withLock { _answersAfter = newValue } }
        }
        var loginWaits: Bool {
            get { lock.withLock { _loginWaits } }
            set { lock.withLock { _loginWaits = newValue } }
        }
        var refuse: String?

        func note(_ step: String) { lock.withLock { _asked.append(step) } }

        var steps: StartSteps {
            StartSteps(
                world: { [self] in lock.withLock { (_asked.contains { $0.hasPrefix("adopt") } ? folder : nil,
                                                    _asked.contains("install"), _paired) } },
                adopt: { [self] path in
                    note("adopt " + (path == folder.path ? "<folder>" : path))
                    if let refuse { throw ReleaseError(words: refuse) }
                },
                keyed: keyed,
                install: { [self] in note("install") },
                command: { [self] in note("command") },
                agents: { [self] in note("agents") },
                loginWaits: { [self] in
                    note("login item")
                    return loginWaits
                },
                answers: { [self] _, _ in
                    note("answer?")
                    if let seeWaits {
                        let said = await seeWaits()
                        lock.withLock { _waits.append(said) }
                    }
                    return lock.withLock {
                        if _locked > 0 {
                            _locked -= 1
                            return .locked
                        }
                        _answersAfter -= 1
                        guard _answersAfter < 0 else { return .silent }
                        guard _starting > 0 else { return .serves }
                        _starting -= 1
                        return .notNow(words, retryAfter: retryAfter, starting: starts)
                    }
                },
                passRefused: { [self] in lock.withLock { _passRefused } },
                mintCode: { [self] in
                    note("code")
                    return "48213907"
                },
                name: { [self] name in note("name \(name)") },
                logTail: { "home.log:\n2026-10-21T09:14:05Z home: a synthetic last line\n\ndoor.log:\n(no log yet)" },
                answerWithin: 5, askEvery: .milliseconds(5),
                now: { [self] in lock.withLock { _clock } },
                sleep: { [self] wait in
                    lock.withLock { _clock += TimeInterval(wait.components.seconds) + TimeInterval(wait.components.attoseconds) / 1e18 }
                    await Task.yield()
                })
        }

        func paired() {
            lock.withLock {
                _paired = true
                _passRefused = false
            }
        }

        func revoked() {
            lock.withLock {
                _paired = true
                _passRefused = true
            }
        }

        var keychainRefuses = false
        private var _draft: String?
        private var _handed: [Data] = []
        var handed: [Data] { lock.withLock { _handed } }
        var draft: String? {
            get { lock.withLock { _draft } }
            set { lock.withLock { _draft = newValue } }
        }
        static let recovery = "MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA"
        static let slotKey = Data((0..<32).map { UInt8($0 &+ 40) })

        var keyed: KeyedSteps {
            KeyedSteps(
                trust: { [self] home in note("trust \(home)") },
                make: { [self] _ in
                    note("make key")
                    if keychainRefuses { throw KeyStoreError.keychain(-25293) }
                    let home = UUID().uuidString.lowercased()
                    draft = home
                    return (home, Self.slotKey)
                },
                draft: { [self] in
                    note("keys draft")
                    return try JSONDecoder().decode(Drafted.self, from: Data(#"{"recovery":"\#(Self.recovery)","slot":"r-1","number":1,"made_ms":1763337600000}"#.utf8))
                },
                adopt: { [self] path, handed in
                    note("adopt --keyed " + (path == folder.path ? "<folder>" : path))
                    lock.withLock { _handed.append(handed) }
                    if let refuse { throw ReleaseError(words: refuse) }
                },
                adopted: { [self] home, _ in if draft == home { draft = nil } })
        }

        static let startingWords = "Your home is starting: it answers in a moment."

        func pair() -> SetupStart.Paired {
            let notNow: Bool = lock.withLock {
                guard _pairNotNow > 0 else { return false }
                _pairNotNow -= 1
                return true
            }
            if notNow { return .notNow(Self.startingWords, retryAfter: retryAfter, starting: true) }
            paired()
            return .paired
        }
    }


    private func host(_ setup: SetupHost?, folder: @escaping @Sendable () -> URL? = { nil },
                      unit: @escaping @Sendable () -> String? = { nil }) -> MacHost {
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        return MacHost(needs: NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper)),
                       lines: StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true)),
                       socket: { nil },
                       readGrants: { [:] }, readFolder: { folder() }, unit: unit, ask: .untouched, setup: setup)
    }

    func testSetUpGoesThroughTheHostsActsAndItsStateNeverFlickers() async throws {
        let home = FakeHome(folder)
        let pairs = Collected<String>()
        let start = SetupStart(pair: { door, code in
            pairs.append("\(door) \(code)")
            home.paired()
            return .paired
        })
        let setup = SetupHost(world: fresh, start: start, release: nil, steps: home.steps, name: "MacBook Pro of Person A",
                              look: look(free: 1.2e12), quit: { XCTFail("Set up quit the app") })
        let steps = home.steps
        let host = host(setup, folder: { steps.world().0 }, unit: { steps.world().2 ? "macbook-pro-0001" : nil })
        XCTAssertNil(host.state.placement)
        XCTAssertEqual(host.state.machine, SetupHost.Machine(folder: folder.standardizedFileURL.path,
                                                             freeBytes: 1.2e12, daysOfRoom: 1045, name: "MacBook Pro of Person A", home: .plain))
        XCTAssertEqual(host.state.setup, SetupHost.Setup(state: "idle", error: nil))
        XCTAssertEqual(SetupHost(world: fresh(nil), start: start, release: nil, steps: home.steps, name: "MacBook Pro",
                                 look: look(free: 1e12), quit: {}).machine.folder, "~/Lifestream")
        let unread = try XCTUnwrap(String(data: try JSONEncoder().encode(SetupHost(world: fresh, start: start, release: nil,
                                                                                    steps: home.steps, name: "MacBook Pro", quit: {}).machine),
                                          encoding: .utf8))
        XCTAssertTrue(unread.contains(#""free_bytes":null"#) && unread.contains(#""days_of_room":null"#), unread)
        XCTAssertTrue(unread.contains(#""home":null"#) && unread.contains(#""disk":null"#), unread)
        XCTAssertTrue(unread.contains(#""name":"MacBook Pro""#), unread)

        XCTAssertEqual(HostAct.read(["type": "act", "act": "rename", "name": "Studio Mac"]), .failure(.update(nil)))
        XCTAssertEqual(HostAct.read(["type": "act", "act": "setup"]), .success(.setUp))
        XCTAssertEqual(HostAct.read(["type": "act", "act": "move-app"]), .success(.moveApp))
        XCTAssertNotEqual(HostAct.read(["type": "act", "act": "drag-app"]), .success(.moveApp))

        var seen: [String] = []
        host.published = { seen.append("\($0.setup?.state ?? "none") \($0.folder == nil ? "no folder" : "folder") \($0.unit.flatMap { $0.isEmpty ? nil : $0 } ?? "no unit")") }
        _ = try await host.perform(.setUp)
        XCTAssertEqual(host.state.setup?.state, "working", "the act answered before the state said working")
        XCTAssertEqual(seen.last, "working no folder no unit", "the page was not told before the act answered")
        _ = try await host.perform(.setUp)
        try await until("start.phase == .done") { start.phase == .done }
        try await until("host.state.unit names this Mac") { host.state.unit?.isEmpty == false }
        XCTAssertEqual(seen.reduce(into: [String]()) { if $0.last != $1 { $0.append($1) } },
                       ["working no folder no unit", "done folder macbook-pro-0001"],
                       "the setup state flickered between the press and the home")
        XCTAssertEqual(home.asked, ["adopt <folder>", "install", "command", "agents", "login item", "answer?", "answer?", "answer?", "code",
                                    "name MacBook Pro of Person A"], "a second press started a second Set up, or a step came out of order")
        XCTAssertEqual(pairs.values, ["http://127.0.0.1:4680 48213907"])
        do {
            _ = try await self.host(nil).perform(.setUp)
            XCTFail("a set-up Mac took Set up")
        } catch {}
        try record("set-up", ["asked": home.asked, "paired": pairs.values, "setup_states": seen])
    }

    func testNothingRecordsBeforeSetUpAndTheRecorderStartsTheMomentItCompletes() async throws {
        let home = FakeHome(folder)
        let start = SetupStart(pair: { _, _ in
            home.paired()
            return .paired
        })
        let steps = home.steps
        let world: @Sendable () -> SetupWorld = {
            let (folder, release, paired) = steps.world()
            return SetupWorld(placed: true, release: release, outdated: false, folder: folder,
                              agents: Dictionary(uniqueKeysWithValues: HomeJob.allCases.map { ($0, release ? .current : .notRegistered) }),
                              paired: paired)
        }
        let starts = Collected<String>()
        let gate = RecordingGate(world: world, paused: { false }, start: { starts.append("start") })
        gate.watch(start)

        gate.opens(SetupWorld(placed: false, release: true, outdated: false, folder: folder, agents: [:], paired: true))
        gate.opens(fresh)
        await gate.check()
        XCTAssertEqual(starts.values, [], "the app recorded before Set up had run")
        XCTAssertFalse(gate.open)

        await start.run(steps, folder: folder, door: "http://127.0.0.1:4680", name: "MacBook Pro of Person A")
        XCTAssertEqual(start.phase, .done)
        try await until("starts.values == [\"start\"]") { starts.values == ["start"] }
        XCTAssertTrue(world().setUp)

        await gate.check()
        gate.opens(world())
        XCTAssertEqual(starts.values, ["start"], "the gate started the recorder twice")

        let next = Collected<String>()
        let relaunch = RecordingGate(world: world, paused: { false }, start: { next.append("start") })
        await relaunch.check()
        XCTAssertEqual(next.values, ["start"])
        try record("recording-gate", ["before_set_up": [String](), "after_set_up": starts.values, "next_launch": next.values,
                                      "asked": home.asked])
    }

    func testAMacWithItsHomeElsewhereRecordsOnceItHoldsAPassAndKeepsThePersonsPause() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let agents = Dictionary(uniqueKeysWithValues: HomeJob.allCases.map { ($0, HomeAgents.State.notRegistered) })
        let gone = SetupWorld(placed: true, release: false, outdated: false, folder: nil, agents: agents, paired: false)
        let paired = SetupWorld(placed: true, release: false, outdated: false, folder: nil, agents: agents, paired: true)
        let world = Collected<SetupWorld>()
        world.append(gone)
        let starts = Collected<String>()
        let gate = RecordingGate(world: { world.values.last ?? gone }, paused: { KeptPause(defaults).paused },
                                 start: { starts.append("start") })
        await gate.check()
        XCTAssertFalse(gate.open, "a Mac with no pass recorded")
        world.append(paired)
        await gate.check()
        XCTAssertTrue(gate.open)
        XCTAssertEqual(starts.values, ["start"], "pairing again did not bring recording back")

        defaults.set(true, forKey: KeptPause.key)
        let relaunch = RecordingGate(world: { paired }, paused: { KeptPause(defaults).paused }, start: { starts.append("again") })
        await relaunch.check()
        XCTAssertTrue(relaunch.open)
        XCTAssertEqual(starts.values, ["start"], "a kept pause was dropped on a Mac with its home elsewhere")
    }

    func testAKeptPauseOpensTheGateButStartsNothingAtLaunch() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let setUp = SetupWorld(placed: true, release: true, outdated: false, folder: folder,
                               agents: Dictionary(uniqueKeysWithValues: HomeJob.allCases.map { ($0, .current) }), paired: true)
        let fresh = Collected<String>()
        let first = RecordingGate(world: { setUp }, paused: { KeptPause(defaults).paused }, start: { fresh.append("start") })
        await first.check()
        XCTAssertTrue(first.open)
        XCTAssertEqual(fresh.values, ["start"], "a Mac never paused did not record")

        defaults.set(true, forKey: KeptPause.key)
        let starts = Collected<String>()
        let relaunch = RecordingGate(world: { setUp }, paused: { KeptPause(defaults).paused }, start: { starts.append("start") })
        await relaunch.check()
        XCTAssertTrue(relaunch.open, "a kept pause left Start recording unable to start")
        XCTAssertEqual(starts.values, [], "the recorder started through a kept pause")
        relaunch.opens(setUp)
        XCTAssertEqual(starts.values, [])
    }

    func testAFailureSaysSoWithItsWayOutAndLoginItemsGoesOnOnceAllowed() async throws {
        let home = FakeHome(folder)
        home.answersAfter = 1_000
        let start = SetupStart(pair: { _, _ in
            home.paired()
            return .paired
        })
        var steps = home.steps
        steps.answerWithin = 0.05
        let setup = SetupHost(world: fresh, start: start, release: nil, steps: steps, name: "Desk Mac", look: look(free: 1.2e12), quit: {})
        await setup.setUp()
        try await until("setup.setup.state == \"failed\"") { setup.setup.state == "failed" }
        XCTAssertEqual(setup.setup.error, "Lifestream did not answer within 0 seconds.", "the error carries the logs, or other words")
        guard case .failed(let details) = start.phase else { return XCTFail("\(start.phase)") }
        XCTAssertTrue(details.contains("home: a synthetic last line"), "the details keep no log lines")

        home.answersAfter = 0
        let failedRun = home.asked.count
        await setup.setUp()
        try await until("start.phase == .done") { start.phase == .done }
        XCTAssertEqual(Array(home.asked[failedRun...]), ["agents", "login item", "answer?", "code", "name Desk Mac"])

        let waiting = FakeHome(folder)
        waiting.loginWaits = true
        let second = SetupStart(pair: { _, _ in .paired })
        let held = SetupHost(world: fresh, start: second, release: nil, steps: waiting.steps, name: "Desk Mac", look: look(free: 1.2e12), quit: {})
        await held.setUp()
        try await until("second.phase == .loginItems") { second.phase == .loginItems }
        XCTAssertEqual(held.setup, SetupHost.Setup(state: "login-items", error: nil))
        XCTAssertEqual(HostAct.read(["type": "act", "act": "open", "what": "login-items"]), .success(.open(.loginItems)))
        let heldHost = host(held)
        do {
            _ = try await heldHost.perform(.chooseFolder(.standard))
            XCTFail("the folder changed while Login Items waits")
        } catch let refusal as HostRefusal {
            XCTAssertEqual(refusal.words, "Lifestream is setting up in the folder chosen.")
        }
        held.choose(scratch.appendingPathComponent("Other"))
        XCTAssertEqual(held.machine.folder, folder.standardizedFileURL.path, "a folder chosen while Login Items waits replaced Set up's")
        waiting.loginWaits = false
        NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
        try await until("second.phase == .done") { second.phase == .done }
        XCTAssertEqual(waiting.asked.filter { $0.hasPrefix("adopt") }, ["adopt <folder>"], "Set up went on in another folder")
        try record("set-up-failure", ["details": details, "after_try_again": Array(home.asked[failedRun...]), "login_items": waiting.asked])
    }

    func testAHomeStartingIsWaitedForInItsDoorsWordsNeverTakenForOneDown() async throws {
        let home = FakeHome(folder)
        home.answersAfter = 1
        home.starting = 3
        let pairs = Collected<String>()
        let start = SetupStart(pair: { door, code in
            pairs.append("\(door) \(code)")
            return home.pair()
        })
        let setup = SetupHost(world: fresh, start: start, release: nil, steps: home.steps, name: "Desk Mac", look: look(free: 1.2e12), quit: {})
        home.seeWaits = { await MainActor.run { setup.setup.state == "working" ? setup.setup.waiting ?? "-" : setup.setup.state } }
        let states = Collected<String>()
        let watch = start.$phase.dropFirst().sink { _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { states.append("\(setup.setup.state) \(setup.setup.waiting ?? "-")") } }
        }
        defer { watch.cancel() }
        await setup.setUp()
        try await until("start.phase == .done") { start.phase == .done }
        XCTAssertEqual(home.asked, ["adopt <folder>", "install", "command", "agents", "login item",
                                    "answer?", "answer?", "answer?", "answer?", "answer?", "code", "name Desk Mac"],
                       "Set up paired before the door served, or stopped asking while it said not now")
        XCTAssertEqual(pairs.values, ["http://127.0.0.1:4680 48213907"])
        XCTAssertEqual(home.waits, ["-", "-", FakeHome.startingWords, FakeHome.startingWords, FakeHome.startingWords],
                       "the page was not told what Set up waits for")
        try await until("the page read done") { states.values.last == "done -" }
        XCTAssertEqual(states.values.reduce(into: [String]()) { if $0.last != $1 { $0.append($1) } },
                       ["working -", "working \(FakeHome.startingWords)", "working -", "done -"],
                       "a home starting read as failed, or the door's words outlived its serving")
        let encoded = try XCTUnwrap(String(data: try JSONEncoder().encode(SetupHost.Setup(state: "working", error: nil,
                                                                                          waiting: FakeHome.startingWords)), encoding: .utf8))
        XCTAssertTrue(encoded.contains(#""waiting":"Your home is starting: it answers in a moment.""#), encoded)
        let unwaited = try XCTUnwrap(JSONSerialization.jsonObject(with: try JSONEncoder().encode(SetupHost.Setup(state: "working",
                                                                                                                  error: nil))) as? [String: Any])
        XCTAssertTrue(unwaited["waiting"] is NSNull, "a Set up waiting on nothing stated a wait: \(unwaited)")

        let again = FakeHome(folder)
        again.answersAfter = 0
        again.pairNotNow = 1
        let codes = Collected<String>()
        let second = SetupStart(pair: { _, code in
            codes.append(code)
            return again.pair()
        })
        await second.run(again.steps, folder: folder, door: "http://127.0.0.1:4680", name: "Desk Mac")
        XCTAssertEqual(second.phase, .done)
        XCTAssertEqual(again.asked.filter { $0 == "code" }.count, 1, "a pairing the door said not now to minted a second code")
        XCTAssertEqual(codes.values, ["48213907", "48213907"])
        XCTAssertEqual(Array(again.asked.suffix(4)), ["answer?", "code", "answer?", "name Desk Mac"],
                       "Set up paired again before the door served again")
        try record("home-starting", ["asked": home.asked, "waits": home.waits.map { $0 ?? "none" }, "pair_again": again.asked])
    }

    func testAPassTheDoorRefusesReadsAsUnpairedAndSetUpPairsAgain() async throws {
        let home = FakeHome(folder)
        home.answersAfter = 0
        home.revoked()
        let codes = Collected<String>()
        let start = SetupStart(pair: { _, code in
            codes.append(code)
            return home.pair()
        })
        await start.run(home.steps, folder: folder, door: "http://127.0.0.1:4680", name: "Desk Mac")
        XCTAssertEqual(start.phase, .done)
        XCTAssertEqual(codes.values, ["48213907"], "a pass the home revoked read as paired, so Set up never paired again")
        XCTAssertEqual(Array(home.asked.suffix(3)), ["answer?", "code", "name Desk Mac"])

        let held = FakeHome(folder)
        held.answersAfter = 0
        held.paired()
        let second = SetupStart(pair: { _, _ in
            XCTFail("a pass the home takes was paired again")
            return .paired
        })
        await second.run(held.steps, folder: folder, door: "http://127.0.0.1:4680", name: "Desk Mac")
        XCTAssertEqual(second.phase, .done)
        XCTAssertFalse(held.asked.contains("code"))
    }

    func testTheDoorsWaitIsItsRetryAfterBoundedByTheDeadline() async throws {
        let home = FakeHome(folder)
        home.answersAfter = 0
        home.starting = 1_000
        home.retryAfter = 3_600
        let start = SetupStart(pair: { _, _ in home.pair() })
        var steps = home.steps
        steps.answerWithin = 0.2
        await start.run(steps, folder: folder, door: "http://127.0.0.1:4680", name: "Desk Mac")
        XCTAssertEqual(home.asked.filter { $0 == "answer?" }.count, 1, "Set up asked on a timer of its own, not the door's Retry-After")
        guard case .failed(let details) = start.phase else { return XCTFail("\(start.phase)") }
        XCTAssertTrue(details.hasPrefix("Lifestream did not finish starting within 0 seconds.\n\nThe door said: \(FakeHome.startingWords)\n\n"), details)
        XCTAssertFalse(home.asked.contains("code"), "Set up paired past its deadline")

        let held = FakeHome(folder)
        held.answersAfter = 0
        held.starting = 1_000
        held.retryAfter = 3_600
        held.words = "The home is held: a check found damage."
        held.starts = false
        let holding = SetupStart(pair: { _, _ in held.pair() })
        var heldSteps = held.steps
        heldSteps.answerWithin = 0.2
        await holding.run(heldSteps, folder: folder, door: "http://127.0.0.1:4680", name: "Desk Mac")
        guard case .failed(let heldDetails) = holding.phase else { return XCTFail("\(holding.phase)") }
        XCTAssertTrue(heldDetails.hasPrefix("Lifestream did not answer within 0 seconds.\n\nThe door said: \(held.words)\n\n"), heldDetails)

        let unstated = FakeHome(folder)
        unstated.answersAfter = 0
        unstated.starting = 2
        unstated.retryAfter = nil
        let next = SetupStart(pair: { _, _ in unstated.pair() })
        await next.run(unstated.steps, folder: folder, door: "http://127.0.0.1:4680", name: "Desk Mac")
        XCTAssertEqual(next.phase, .done)
        XCTAssertEqual(unstated.asked.filter { $0 == "answer?" }.count, 3)
    }

    func testTheDoorsNotNowIsReadFromItsAnswer() {
        let starting = Data(#"{"code":"NOT_NOW","message":"Your home is starting: it answers in a moment.","wait":"starting","title":"Your home is starting","line":"It answers in a moment.","acts":[]}"#.utf8)
        XCTAssertEqual(DoorAnswer(status: 503, body: starting, retryAfter: "5"),
                       .notNow("Your home is starting: it answers in a moment.", retryAfter: 5, starting: true))
        XCTAssertEqual(DoorAnswer(status: 503, body: starting, retryAfter: "soon"),
                       .notNow("Your home is starting: it answers in a moment.", retryAfter: nil, starting: true))
        let away = Data(#"{"code":"NOT_NOW","message":"Your home is starting: it answers in a moment.","wait":"needs","title":"Your home's folder isn't there","line":"Connect the drive.","acts":[]}"#.utf8)
        XCTAssertEqual(DoorAnswer(status: 503, body: away, retryAfter: "60"),
                       .notNow("Your home is starting: it answers in a moment.", retryAfter: 60, starting: false))
        XCTAssertEqual(DoorAnswer(status: 401, body: Data(#"{"code":"UNAUTHORIZED","message":"no pass"}"#.utf8), retryAfter: nil), .serves)
        XCTAssertEqual(DoorAnswer(status: 503, body: Data(#"{"code":"OUTCOME_UNKNOWN","message":"x"}"#.utf8), retryAfter: "5"), .serves)

        XCTAssertEqual(SetupStart.Paired(failed: LinkFailure.unavailable(code: "NOT_NOW", message: FakeHome.startingWords, retryAfter: 5,
                                                                         notNow: .starting(.init(title: "Your home is starting")))),
                       .notNow(FakeHome.startingWords, retryAfter: 5, starting: true))
        XCTAssertEqual(SetupStart.Paired(failed: LinkFailure.unavailable(code: "NOT_NOW", message: "Your home isn't ready.", retryAfter: 5, notNow: .busy)),
                       .notNow("Your home isn't ready.", retryAfter: 5, starting: false))
        XCTAssertEqual(SetupStart.Paired(failed: LinkFailure.unavailable(code: "OUTCOME_UNKNOWN", message: "Lifestream did not answer in time: it may have kept the change.", retryAfter: 5)),
                       .refused("Lifestream did not answer in time: it may have kept the change."))
        XCTAssertEqual(SetupStart.Paired(failed: LinkFailure.noAnswer(sent: false)), .refused(ReachWords.notSent))
        XCTAssertEqual(SetupStart.Paired(failed: LinkFailure.refused(status: 422, code: "PAIR_CODE", message: "That code is not this home's.")),
                       .refused("That code is not this home's."))
    }

    func testTheRoomAndAFolderSetUpCannotUse() async throws {
        XCTAssertEqual(Runway.days(free: 1.2e12), 1045)
        XCTAssertEqual(Runway.days(free: 60e9), 48)
        XCTAssertEqual(Runway.days(free: 6e9), 0)
        XCTAssertEqual(Runway.days(free: 4e9), 0)
        XCTAssertEqual(MachineLook.bytes(15.55e9), "16 GB")
        XCTAssertEqual(MachineLook.bytes(1.23e12), "1.2 TB")

        let home = FakeHome(folder)
        let full = SetupHost(world: fresh, start: SetupStart(pair: { _, _ in .paired }), release: nil, steps: home.steps, name: "Desk Mac",
                             look: look(free: 4e9), quit: {})
        XCTAssertEqual(full.setup, SetupHost.Setup(state: "failed", error: "This disk has 4 GB free. Choose a folder on a disk with more room."))
        XCTAssertEqual(full.machine.daysOfRoom, 0)
        await full.setUp()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(home.asked, [], "Set up ran on a disk that cannot hold it")
        home.refuse = "That folder holds another program's files."
        let start = SetupStart(pair: { _, _ in .paired })
        let refused = SetupHost(world: fresh, start: start, release: nil, steps: home.steps, name: "Desk Mac", look: look(free: 1.2e12), quit: {})
        await refused.setUp()
        try await until("start.phase == .refused(\"That folder holds another program's files.\")") { start.phase == .refused("That folder holds another program's files.") }
        XCTAssertEqual(refused.setup, SetupHost.Setup(state: "failed", error: "That folder holds another program's files."))
        XCTAssertEqual(home.asked, ["adopt <folder>"], "Set up went on past the refusal")
        refused.choose(scratch.appendingPathComponent("Other"))
        XCTAssertNotEqual(refused.setup.error, "That folder holds another program's files.", "the refusal outlived Change")
        XCTAssertEqual(refused.machine.folder, scratch.appendingPathComponent("Other").standardizedFileURL.path)
    }

    func testTheFolderPanelStartsAtTheHomeOrTheDrivesAndTheDefaultNeedsNoPanel() async throws {
        func act(_ body: [String: Any]) -> Result<HostAct, HostRefusal> {
            HostAct.read(["type": "act", "act": "choose-folder"].merging(body) { $1 })
        }
        XCTAssertEqual(act([:]), .success(.chooseFolder(.panel(drives: false))))
        XCTAssertEqual(act(["start": "volumes"]), .success(.chooseFolder(.panel(drives: true))))
        XCTAssertEqual(act(["default": kCFBooleanTrue as Any]), .success(.chooseFolder(.standard)))
        XCTAssertEqual(act(["default": kCFBooleanFalse as Any]), .success(.chooseFolder(.panel(drives: false))))
        for odd: [String: Any] in [["start": "home"], ["start": 1], ["default": 1], ["default": "true"],
                                   ["start": "volumes", "default": kCFBooleanTrue as Any]] {
            XCTAssertEqual(act(odd), .failure(.unreadable(nil)), "\(odd)")
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        XCTAssertEqual(SetupHost.panelStart(drives: false), home)
        XCTAssertEqual(SetupHost.panelStart(drives: true).path, "/Volumes")
        XCTAssertEqual(SetupHost.standardFolder, home.appendingPathComponent("Lifestream", isDirectory: true))

        let drive = scratch.appendingPathComponent("Archive/Lifestream", isDirectory: true)
        let start = SetupStart(pair: { _, _ in .paired })
        let setup = SetupHost(world: fresh, start: start, release: nil, steps: FakeHome(folder).steps, name: "MacBook Pro",
                              look: look(free: 1.2e12), quit: {})
        let host = host(setup)
        setup.choose(drive)
        XCTAssertEqual(host.state.machine?.folder, drive.standardizedFileURL.path)
        XCTAssertNil(host.state.machine?.freeBytes, "the room of the folder replaced stood for the new one")
        _ = try await host.perform(.chooseFolder(.standard))
        XCTAssertEqual(host.state.machine?.folder, "~/Lifestream")
        XCTAssertEqual(host.state.machine?.name, "MacBook Pro")
        let busy = SetupHost(world: fresh, start: SetupStart(pair: { _, _ in .paired }), release: nil, steps: FakeHome(folder).steps,
                             name: "MacBook Pro", look: look(free: 1.2e12), quit: {})
        let busyHost = self.host(busy)
        _ = try await busyHost.perform(.setUp)
        do {
            _ = try await busyHost.perform(.chooseFolder(.standard))
            XCTFail("the folder changed under Set up")
        } catch let refusal as HostRefusal {
            XCTAssertEqual(refusal.words, "Lifestream is setting up in the folder chosen.")
        }
        XCTAssertEqual(busyHost.state.machine?.folder, folder.standardizedFileURL.path)
        try record("where-folder", ["drive": "<scratch>/Archive/Lifestream", "default": "~/Lifestream", "panel": ["~", "/Volumes"]])
    }

    func testThisMacIsStatedAfterSetUpUntilTheOnboardingEnds() async throws {
        let home = scratch.appendingPathComponent("Lifestream", isDirectory: true)
        let looked = Collected<String>()
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        let free = 412e9
        let host = MacHost(needs: NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper)),
                           lines: StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true)),
                           socket: { nil },
                           readGrants: { [:] }, readFolder: { home }, machineName: "MacBook Pro",
                           lookFolder: { folder in
                               looked.append(folder.lastPathComponent)
                               return MachineLook(folder: .init(path: folder.path, refused: nil, free_bytes: free,
                                                                door: "http://127.0.0.1:4680"))
                           }, ask: .untouched)
        await host.read()
        XCTAssertNil(host.state.machine, "machine stated with the onboarding not showing")
        XCTAssertEqual(looked.values, [], "the folder looked at with the onboarding not showing")
        host.onboarding = true
        try await until("host.state.machine?.freeBytes == free") { host.state.machine?.freeBytes == free }
        XCTAssertEqual(host.state.machine, SetupHost.Machine(folder: home.standardizedFileURL.path, freeBytes: free,
                                                             daysOfRoom: Runway.days(free: free), name: "MacBook Pro", home: .new))
        await host.read()
        XCTAssertEqual(looked.values, ["Lifestream", "Lifestream"], "the room was not read again with the read")
        host.onboarding = false
        XCTAssertNil(host.state.machine, "machine outlived the onboarding")
        try record("machine-after-set-up", ["looked": looked.values, "days_of_room": Runway.days(free: free)])
    }

    func testTheFirstRunsWindowShowsThePageTheAppCarriesAndHearsIt() async throws {
        let release = scratch.appendingPathComponent("release")
        let files: [String: String] = [
            "dashboard/public/index.html": Self.carried,
            "dashboard/public/carried.js": Self.carriedScript,
            "design/css/kit.css": ".kit{}",
            "dashboard/secret.json": "{}",
        ]
        for (path, body) in files {
            let url = release.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(body.utf8).write(to: url)
        }
        let page = BundledPage(release: release, dashboard: URL(string: "http://127.0.0.1:1/")!)
        XCTAssertEqual(page.file("/")?.url.lastPathComponent, "index.html")
        XCTAssertEqual(page.file("/kit.css")?.type, "text/css")
        XCTAssertEqual(page.file("/geist.woff2")?.type, "font/woff2")
        XCTAssertEqual(page.file("/geist.woff2")?.url, release.appendingPathComponent("design/river/geist.woff2"))
        XCTAssertEqual(Array(BundledPage.named.keys).sorted(), ["/cockpit.css", "/geist.woff2", "/icons.json", "/kit.css", "/marked.js", "/purify.js"])
        XCTAssertNil(page.file("/../secret.json"), "a path left the page's folder")
        XCTAssertNil(page.file("/ui/../../secret.json"))
        XCTAssertNil(page.file("/.hidden.js"))
        let http = try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../dashboard/lib/http.mjs"),
                              encoding: .utf8)
        XCTAssertTrue(http.contains("'Content-Security-Policy': \"\(try XCTUnwrap(BundledPage.security["Content-Security-Policy"]))\""),
                      "the page the app carries runs under another policy than the dashboard's")

        let gone = try PageServer([:])
        let deadPort = try await gone.ready()
        gone.stop()
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let down = MainWindowController(web: WebContent(address: DashboardAddress(port: deadPort).carried, defaults: defaults, release: release,
                                                        dashboardHeld: { false }), host: host(nil), onScreen: false, closed: {})
        defer { down.close() }
        down.present(hash: FirstRun.welcome.hash)
        try await until("down.web.loaded && down.web.title.hasSuffix(\"· 503\")") { down.web.loaded && down.web.title.hasSuffix("· 503") }
        XCTAssertEqual(down.web.title, "view=onboarding&seg=welcome · kit · 503")
        XCTAssertTrue(down.onboarding)
        XCTAssertEqual(down.window?.contentView?.frame.size, MainWindowSize.onboarding)
        XCTAssertEqual(defaults.string(forKey: "DashboardLastURL"), "http://127.0.0.1:\(deadPort)/#view=onboarding")
        XCTAssertTrue(WebContent.leftInOnboarding(defaults))
        down.close()

        let server = try PageServer(["/api/ping": ("application/json", Data(#"{"pong":true}"#.utf8))])
        defer { server.stop() }
        let port = try await server.ready()
        let setup = SetupHost(world: fresh, start: SetupStart(pair: { _, _ in .paired }), release: nil, steps: FakeHome(folder).steps,
                              name: "Desk Mac", look: look(free: 1.2e12), quit: {})
        let up = MainWindowController(web: WebContent(address: DashboardAddress(port: port).carried, defaults: defaults, release: release,
                                                      dashboardHeld: { true }), host: host(setup), onScreen: false, closed: {})
        defer { up.close() }
        up.present(hash: FirstRun.welcome.hash)
        try await until("up.web.loaded && up.web.title.contains(\"pong\")") { up.web.loaded && up.web.title.contains("pong") }
        try await until("up.web.title.hasSuffix(\"· set up\")") { up.web.title.hasSuffix("· set up") }
        try await until("setup.setup.state == \"done\"") { setup.setup.state == "done" }
        try record("bundled-page", ["down": "view=onboarding&seg=welcome · kit · 503", "up": up.web.title,
                                    "url": up.web.currentURL.absoluteString.replacingOccurrences(of: "\(port)", with: "<port>")])
    }

    func testAPageOnTheDashboardsOriginLoadsAnAppsIconFromTheAppsScheme() async throws {
        _ = Detection.apps(Detection.Places(applications: [URL(fileURLWithPath: "/System/Applications")],
                                            support: FileManager.default.temporaryDirectory))
        let page = """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'; img-src 'self' data: blob: lifestream-app:">
        <title>Lifestream</title></head><body><img id="i" src="\(Detection.iconURL("com.apple.calculator"))">
        <script>const i = document.getElementById('i');
        i.onload = () => { document.title = 'icon ' + i.naturalWidth; }; i.onerror = () => { document.title = 'icon failed'; };</script>
        </body></html>
        """
        let server = try PageServer(["/": ("text/html", Data(page.utf8))])
        defer { server.stop() }
        let port = try await server.ready()
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let main = MainWindowController(web: WebContent(address: DashboardAddress(port: port), defaults: defaults, dashboardHeld: { true }),
                                        host: host(nil), onScreen: false, closed: {})
        defer { main.close() }
        main.present(nil)
        try await until("main.web.title.hasPrefix(\"icon\")") { main.web.title.hasPrefix("icon") }
        XCTAssertEqual(main.web.title, "icon 64")
    }

    func testTheMainWindowAtTheOnboardingStandsAtItsFrameAndGrowsOnce() async throws {
        let server = try PageServer(["/": ("text/html", Data(Self.page.utf8))])
        defer { server.stop() }
        let port = try await server.ready()
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set("http://127.0.0.1:\(port)/#view=onboarding&seg=model", forKey: "DashboardLastURL")
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 805)
        let again = MainWindowController(web: WebContent(address: DashboardAddress(port: port), defaults: defaults, dashboardHeld: { true }),
                                         host: host(nil), onScreen: false, screen: { screen }, closed: {})
        defer { again.close() }
        again.present(nil)
        try await until("again.web.loaded && again.web.title == \"Lifestream · view=onboarding&seg=model\"") { again.web.loaded && again.web.title == "Lifestream · view=onboarding&seg=model" }
        XCTAssertTrue(again.onboarding, "a window opened again at the onboarding stands at another frame, and Get started never grows it")
        XCTAssertEqual(again.window?.contentView?.frame.size, MainWindowSize.onboarding)
        XCTAssertEqual(MainWindowSize.onboarding, CGSize(width: 760, height: 752), "the window is not Cockpit's onboarding size")
        XCTAssertNil(again.window?.appearance, "the onboarding's window does not follow the Mac's appearance")
        again.web.show(hash: "view=ask&tour=1")
        try await until("!again.onboarding") { !again.onboarding }
        XCTAssertNil(again.window?.appearance, "the window took an appearance of its own once the onboarding ended")
        try await until("again.window?.frame.size == MainWindowSize.initial(screen: screen.size)") { again.window?.frame.size == MainWindowSize.initial(screen: screen.size) }
        XCTAssertEqual(MainWindowSize.initial(screen: CGSize(width: 1440, height: 805)), CGSize(width: 1392, height: 757),
                       "on a 1440 × 900 display with the Dock, Get started grows the window by barely more than the onboarding's height")
        try await until("again.web.title == \"Lifestream · view=ask&tour=1\"") { again.web.title == "Lifestream · view=ask&tour=1" }
        XCTAssertEqual(defaults.string(forKey: "DashboardLastURL"), "http://127.0.0.1:\(port)/#view=ask", "the place to come back to kept the walk")
    }

    func testMoveToApplicationsOpensACopyAsNewOrCopiesThenQuits() async throws {
        let item = scratch.appendingPathComponent("Downloads/Lifestream.app", isDirectory: true)
        let copy = scratch.appendingPathComponent("Applications/Lifestream.app", isDirectory: true)
        try FileManager.default.createDirectory(at: copy, withIntermediateDirectories: true)
        try quarantine(copy)
        let elsewhere = SetupWorld(placed: false, release: false, outdated: false, folder: nil, agents: [:], paired: false)
        var reopened: [AppPlacement.Placed] = []
        var quits = 0
        func setup(_ place: @escaping @Sendable () throws -> AppPlacement.Placed) -> SetupHost {
            SetupHost(world: elsewhere, start: SetupStart(pair: { _, _ in .paired }), release: nil, steps: nil, item: item, place: place,
                      reopen: { reopened.append($0) }, quit: { quits += 1 })
        }
        let first = setup { AppPlacement.Placed(app: copy, volume: nil) }
        XCTAssertEqual(first.placement, SetupHost.Placement(moving: false, error: nil))
        XCTAssertTrue(first.opensWindow(.move(from: item, to: copy, replacing: false)))
        XCTAssertEqual(quits, 0)
        XCTAssertFalse(first.opensWindow(.open(copy)))
        XCTAssertEqual(reopened, [AppPlacement.Placed(app: copy, volume: nil)])
        XCTAssertFalse(quarantined(copy))
        XCTAssertEqual(quits, 1)

        let moved = setup { AppPlacement.Placed(app: copy, volume: nil) }
        let host = host(moved)
        _ = try await host.perform(.moveApp)
        XCTAssertEqual(host.state.placement, SetupHost.Placement(moving: true, error: nil))
        try await until("quits == 2") { quits == 2 }
        XCTAssertEqual(reopened.count, 2)
        let failing = setup { throw CocoaError(.fileWriteNoPermission) }
        try failing.move()
        try await until("failing.placement?.error != nil") { failing.placement?.error != nil }
        XCTAssertEqual(failing.placement?.moving, false)
        XCTAssertEqual(failing.placement?.error?.hasPrefix("Lifestream couldn’t copy itself to Applications. "), true)
        XCTAssertEqual(failing.placement?.error?.hasSuffix("Drag it to Applications in the Finder, then open it from there."), true)
        XCTAssertEqual(quits, 2)
        let placed = SetupHost(world: fresh, start: SetupStart(pair: { _, _ in .paired }), release: nil, steps: nil, item: item,
                               place: { XCTFail("an app in Applications copied itself"); return AppPlacement.Placed(app: copy, volume: nil) },
                               reopen: { _ in }, quit: {})
        do {
            _ = try await self.host(placed).perform(.moveApp)
            XCTFail("an app in Applications took Move to Applications")
        } catch {}
        try record("move-to-applications", ["opened": reopened.map(\.app.lastPathComponent), "quits": quits,
                                            "failure": failing.placement?.error ?? ""])
    }

    func testMoveToApplicationsCopiesOverAnOlderCopyOpensANewerOneAndPutsTheDownloadInTheTrash() throws {
        let folders = AppPlacement.Folders(system: scratch.appendingPathComponent("Applications"),
                                           user: scratch.appendingPathComponent("home/Applications"))
        let download = scratch.appendingPathComponent("Downloads/Lifestream.app", isDirectory: true)
        func app(_ at: URL, generation: Int) throws {
            let release = at.appendingPathComponent("Contents/Resources/release")
            try FileManager.default.createDirectory(at: release, withIntermediateDirectories: true)
            try Data(#"{"commit":"0dab33c0","generation":\#(generation)}"#.utf8).write(to: release.appendingPathComponent("RELEASE.json"))
        }
        try app(download, generation: 1720)
        let inside = "Contents/Resources/release/RELEASE.json"
        try quarantine(download)
        try quarantine(download.appendingPathComponent(inside))
        var rootOwned: URL?
        func plan(writable: Bool = true) -> AppPlacement.Plan {
            AppPlacement.plan(original: download, folders: folders, writable: { _ in writable },
                              exists: { FileManager.default.fileExists(atPath: $0.path) }, usable: { $0 != rootOwned },
                              generation: AppPlacement.generation(of:))
        }
        let system = folders.system.appendingPathComponent("Lifestream.app", isDirectory: true)
        let user = folders.user.appendingPathComponent("Lifestream.app", isDirectory: true)
        XCTAssertEqual(plan(), .move(from: download, to: system, replacing: false))
        XCTAssertEqual(plan(writable: false), .move(from: download, to: user, replacing: false), "wrote where this account cannot")
        XCTAssertEqual(try AppPlacement.carry(plan()), system)
        XCTAssertEqual(AppPlacement.generation(of: system), 1720)
        XCTAssertTrue(FileManager.default.fileExists(atPath: download.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folders.system.path), ["Lifestream.app"], "a staged copy left behind")
        XCTAssertFalse(quarantined(system), "the copy keeps the quarantine: macOS translocates it, and the app asks to move again")
        XCTAssertFalse(quarantined(system.appendingPathComponent(inside)))
        XCTAssertTrue(quarantined(download), "the download was changed")
        XCTAssertEqual(plan(), .open(system))
        try quarantine(system)
        XCTAssertEqual(try AppPlacement.carry(plan()), system)
        XCTAssertFalse(quarantined(system), "opened a copy macOS translocates")
        let locked = system.appendingPathComponent(inside)
        try quarantine(system)
        try quarantine(locked)
        try FileManager.default.setAttributes([.posixPermissions: 0o444], ofItemAtPath: locked.path)
        XCTAssertEqual(try AppPlacement.carry(.open(system)), system, "a copy with a file it cannot clear trapped the person")
        XCTAssertFalse(quarantined(system))
        XCTAssertTrue(quarantined(locked), "the file was not locked after all: the case proves nothing")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: locked.path)
        _ = removexattr(locked.path, AppPlacement.quarantine, XATTR_NOFOLLOW)
        try app(system, generation: 1800)
        XCTAssertEqual(plan(), .open(system))
        try app(system, generation: 1700)
        XCTAssertEqual(plan(), .move(from: download, to: system, replacing: true))
        XCTAssertEqual(try AppPlacement.carry(plan()), system)
        XCTAssertEqual(AppPlacement.generation(of: system), 1720)
        try app(system, generation: 1800)
        rootOwned = system
        XCTAssertEqual(plan(), .move(from: download, to: user, replacing: false), "opened a copy the launch refuses")
        rootOwned = nil
        try FileManager.default.removeItem(at: system)
        try app(user, generation: 1900)
        XCTAssertEqual(plan(), .open(user))
        XCTAssertNil(AppPlacement.diskImage(of: download))
        XCTAssertEqual(AppPlacement.original(download), download, "a bundle that runs where it lies has no other original")
        try FileManager.default.removeItem(at: folders.user)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: folders.system.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folders.system.path) }
        var trashed: [URL] = []
        XCTAssertEqual(try AppPlacement.place(bundle: download, folders: folders, trash: { trashed.append($0) }), AppPlacement.Placed(app: user, volume: nil))
        XCTAssertFalse(quarantined(user))
        XCTAssertEqual(trashed, [download], "a move left the download behind, a second Lifestream for Spotlight and a later double-click")
    }


    private func quarantine(_ url: URL) throws {
        let value = "0083;00000000;Safari;"
        guard setxattr(url.path, AppPlacement.quarantine, value, value.utf8.count, 0, XATTR_NOFOLLOW) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EPERM)
        }
    }

    private func quarantined(_ url: URL) -> Bool {
        getxattr(url.path, AppPlacement.quarantine, nil, 0, 0, XATTR_NOFOLLOW) >= 0
    }

    func testARestartsPageAndAWalkCutShortComeBackOnceAndOnlySoon() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let now = Date(timeIntervalSince1970: 1_792_000_000)
        Resume(page: "view=onboarding&seg=model", at: now).save(defaults)
        XCTAssertEqual(Resume.take(defaults, now: now.addingTimeInterval(5))?.page, "view=onboarding&seg=model")
        XCTAssertNil(Resume.take(defaults, now: now.addingTimeInterval(6)), "read twice")
        Resume(page: "view=onboarding", at: now).save(defaults)
        XCTAssertNil(Resume.take(defaults, now: now.addingTimeInterval(Resume.fresh + 1)), "a stale record took over a later open")
        XCTAssertNil(defaults.data(forKey: Resume.key))
        Resume(leaving: URL(string: "\(BundledPage.scheme)://\(BundledPage.host)/#view=ask&tour=1"), at: now).save(defaults)
        XCTAssertEqual(Resume.take(defaults, now: now)?.page, "view=ask", "a restart resumed the walk")
        Resume(leaving: URL(string: "http://127.0.0.1:4317/#view=connectors&tour=4&dialog=settings/mac"), at: now).save(defaults)
        XCTAssertEqual(Resume.take(defaults, now: now)?.page, "view=connectors&dialog=settings/mac", "a restart resumed the walk")
        XCTAssertNil(Resume(leaving: nil, at: now).page, "a quit with no window open left a page")
    }

    private func record(_ name: String, _ fields: [String: Any]) throws {
        try FileManager.default.createDirectory(at: Shots.e2e, withIntermediateDirectories: true)
        let url = Shots.e2e.appendingPathComponent("\(name).json")
        try JSONSerialization.data(withJSONObject: fields, options: [.prettyPrinted, .sortedKeys]).write(to: url)
        print("recorded: \(url.path)")
    }

    private static let carried = """
    <!doctype html><html><head><meta charset="utf-8"><title>Lifestream</title></head><body>
    <script>window.inline = true;</script><script type="module" src="carried.js"></script></body></html>
    """

    private static let carriedScript = """
    const kit = (await fetch('/kit.css')).ok ? 'kit' : 'no kit';
    const api = await fetch('/api/ping').then(r => r.ok ? r.text() : String(r.status), () => 'failed');
    document.title = location.hash.slice(1) + ' · ' + kit + ' · ' + api + (window.inline ? ' · inline ran' : '');
    if (api.includes('pong')) {
      await webkit.messageHandlers.lifestream.postMessage({type: 'act', act: 'setup'});
      document.title += ' · set up';
    }
    """

    private static let page = """
    <!doctype html><html><head><meta charset="utf-8"><title>Lifestream</title></head><body><script>
    const name = () => { document.title = "Lifestream · " + location.hash.slice(1); };
    addEventListener("hashchange", name);
    name();
    </script></body></html>
    """
}

final class Collected<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var _values: [Value] = []
    var values: [Value] { lock.withLock { _values } }
    func append(_ value: Value) { lock.withLock { _values.append(value) } }
}
