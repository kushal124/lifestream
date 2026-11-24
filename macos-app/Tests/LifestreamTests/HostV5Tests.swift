import AppKit
import DeviceFiles
import CoreImage
import Evidence
import HomeLink
import Passwords
import Recorder
import Shipping
import XCTest
@testable import Lifestream

@MainActor final class HostV6Tests: XCTestCase {
    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("host-v6-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: scratch)
    }

    nonisolated static func homeLink(_ code: String) -> String {
        "lifestream://pair?code=\(code)&host=mac-0001.local&port=4682&fp=\(String(repeating: "A", count: 52))&at=https%3A%2F%2F100.64.0.1%3A4682"
    }

    final class Home: @unchecked Sendable {
        private let lock = NSLock()
        private var _keyID: String? = "3fa2c91b"
        private var _codes = 0
        private var _asking: [[String: String]] = []
        private var _wifi = true
        private var _held: (verb: String, gate: DispatchSemaphore, fails: Bool)?
        private var _holding = false
        var holding: Bool { lock.withLock { _holding } }
        var keyID: String? {
            get { lock.withLock { _keyID } }
            set { lock.withLock { _keyID = newValue } }
        }
        func renew() { lock.withLock { _codes += 1 } }
        var wifi: Bool {
            get { lock.withLock { _wifi } }
            set { lock.withLock { _wifi = newValue } }
        }
        var asking: [[String: String]] {
            get { lock.withLock { _asking } }
            set { lock.withLock { _asking = newValue } }
        }
        func hold(_ verb: String = "pair", fails: Bool = false) -> DispatchSemaphore {
            let gate = DispatchSemaphore(value: 0)
            lock.withLock { _held = (verb, gate, fails) }
            return gate
        }

        func answer(_ request: [String: Any]) -> [String: Any] {
            let args = request["args"] as? [String] ?? []
            let verb = request["verb"] as? String
            let (answer, held) = lock.withLock { () -> ([String: Any], (verb: String, gate: DispatchSemaphore, fails: Bool)?) in
                let read = (verb == "pair" && args.first == "show") || (verb == "connect" && args.isEmpty)
                let held = read && _held?.verb == verb ? _held : nil
                if held != nil { _held = nil }
                return (answering(verb, args), held)
            }
            guard let held else { return answer }
            lock.withLock { _holding = true }
            held.gate.wait()
            lock.withLock { _holding = false }
            return held.fails ? ["error": "the home is restarting"] : answer
        }

        private func answering(_ verb: String?, _ args: [String]) -> [String: Any] {
            switch (verb, args.first) {
            case ("vault", _): return ["result": ["key_id": _keyID as Any, "locked": false, "recovery": _keyID == nil ? "unconfirmed" : "confirmed"]]
            case ("vault-recovery", _): return ["result": ["recovery_slot": "r-2", "made_ms": 1_794_916_800_000, "recovery": HostV6Tests.recoveryKey]]
            case ("vault-confirm", _): return ["error": "that recovery key does not open this vault: nothing was changed"]
            case ("connectors", "on") where args.last == "fax", ("connectors", "off") where args.last == "fax":
                return ["error": "fax: not a source name, nor a Streams row's id"]
            case ("connectors", "on"), ("connectors", "off"): return ["result": ["done": true]]
            case ("connectors", _): return ["result": HostV6Tests.report]
            case ("setup", "skip"), ("setup", "at"): return ["result": ["done": true]]
            case ("pair", "show") where args.count == 1 || (args.count == 3 && args[1] == "--account"):
                if _codes == 0 { _codes = 1 }
                let code = String(format: "4821%04d", _codes)
                let link: Any = _wifi ? HostV6Tests.homeLink(code) : NSNull()
                let why: Any = _wifi ? NSNull() : "Lifestream can't open its Wi-Fi connection. Quit what uses port 4682, or restart Lifestream."
                return ["result": ["code": code, "unit": NSNull(), "expires_ms": 4_102_444_800_000, "match": "K7QF",
                                   "link": link, "why": why, "account": args.count == 3 ? args[2] as Any : NSNull()]]
            case ("connect", nil): return ["result": ["requests": _asking]]
            case ("connect", "answer") where args.count == 3 && ["allow", "deny"].contains(args[2]):
                guard let index = _asking.firstIndex(where: { $0["id"] == args[1] }) else {
                    return ["error": "no request \(args[1]) waits: it was answered, its browser stopped asking, or the Browser step stopped waiting"]
                }
                _asking.remove(at: index)
                return ["result": ["answered": ["id": args[1], "unit": "extension-\(args[1])", "allowed": args[2] == "allow"]]]
            default: return ["error": "usage: home \(verb ?? "") \(args.joined(separator: " "))"]
            }
        }
    }

    nonisolated static let recoveryKey = "MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA"

    nonisolated(unsafe) private static let report: [String: Any] = HomeReport.report([
        HomeReport.connector("gmail", "Gmail", before: ["Make an app password."],
                             members: [HomeReport.member("account", "email", panel: "account"), HomeReport.member("password", "secret", panel: "account")]),
        HomeReport.connector("screen", "Screen"),
    ])

    final class Door: HomeTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var _requests: [HomeRequest] = []
        private var _states: [[String: Any]] = [[:]]
        var requests: [HomeRequest] { lock.withLock { _requests } }
        var gets: Int { lock.withLock { _requests.filter { $0.method == "GET" }.count } }
        func then(_ states: [[String: Any]]) { lock.withLock { _states = states } }
        private var _down = false
        var down: Bool {
            get { lock.withLock { _down } }
            set { lock.withLock { _down = newValue } }
        }

        private var _failGets = false
        var failGets: Bool {
            get { lock.withLock { _failGets } }
            set { lock.withLock { _failGets = newValue } }
        }

        private var _holdStarts = false
        private var _heldAct = "start"
        var heldAct: String {
            get { lock.withLock { _heldAct } }
            set { lock.withLock { _heldAct = newValue } }
        }
        private var _held: [CheckedContinuation<Void, Never>] = []
        var holdStarts: Bool {
            get { lock.withLock { _holdStarts } }
            set { lock.withLock { _holdStarts = newValue } }
        }
        private var _startsAnswered: [Int] = []
        var startsAnswered: [Int] { lock.withLock { _startsAnswered } }
        func release() {
            let held = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
                _holdStarts = false
                defer { _held = [] }
                return _held
            }
            held.forEach { $0.resume() }
        }

        func perform(_ request: HomeRequest) async throws -> HomeResponse {
            if case .json(let body) = request.body, String(decoding: body, as: UTF8.self).contains(#""do":"\#(heldAct)""#), holdStarts {
                await withCheckedContinuation { held in lock.withLock {
                    _held.append(held)
                    _requests.append(request)
                } }
                lock.withLock { _startsAnswered.append(_requests.count) }
                return try answer(request, kept: true)
            }
            return try answer(request, kept: false)
        }

        private func answer(_ request: HomeRequest, kept: Bool) throws -> HomeResponse {
            let state = try lock.withLock { () throws -> [String: Any] in
                if !kept { _requests.append(request) }
                if _down || (_failGets && request.method == "GET") { throw URLError(.cannotConnectToHost) }
                return _states.count > 1 && request.method == "GET" ? _states.removeFirst() : _states[0]
            }
            guard request.url.path == "/v1/ask/login" else { return HomeResponse(status: 404, body: Data()) }
            func whole(_ said: Any?) -> [String: Any] {
                var full: [String: Any] = ["state": "absent"]
                for member in ["bytes", "total", "attempt", "url", "code", "account", "plan", "why"] {
                    full[member] = NSNull()
                }
                full.merge(said as? [String: Any] ?? [:]) { _, new in new }
                return full
            }
            let full: [String: Any] = ["chatgpt": whole(state["chatgpt"]), "claude": whole(state["claude"])]
            return HomeResponse(status: request.method == "POST" ? 202 : 200, body: try JSONSerialization.data(withJSONObject: full))
        }
    }

    final class Memory: Credentials, @unchecked Sendable {
        private var data: Data?
        init(_ data: Data?) { self.data = data }
        func read() throws -> Data? { data }
        func write(_ data: Data) throws { self.data = data }
        func delete() throws { data = nil }
    }

    final class Asked: @unchecked Sendable {
        private let lock = NSLock()
        private var _steps: [String] = []
        var steps: [String] { lock.withLock { _steps } }
        func note(_ step: String) { lock.withLock { _steps.append(step) } }
        private var _held: Set<Grant> = []
        var held: Set<Grant> {
            get { lock.withLock { _held } }
            set { lock.withLock { _held = newValue } }
        }
        private var _unanswered = true
        var unanswered: Bool {
            get { lock.withLock { _unanswered } }
            set { lock.withLock { _unanswered = newValue } }
        }
        @MainActor var away = false
        @MainActor var opening: () async -> Void = {}
        @MainActor var settings = true
        private var _alerting: Set<Grant> = []
        var alerting: Set<Grant> {
            get { lock.withLock { _alerting } }
            set { lock.withLock { _alerting = newValue } }
        }
    }

    @MainActor final class Sight {
        var seen = true
        var looks = 0
    }

    private struct Made {
        let host: MacHost
        let home: ScriptedHome
        let door: Door
        let askDoor: AskLoginDoor
        let asked: Asked
        let reads: Asked
        let told: Asked
        let settings: MacSettings
        let sight: Sight
        let drawn: Asked
        let called: Asked
    }

    private func make(_ state: Home, grants now: [Grant: Bool] = [:], held: Set<Grant> = [],
                      unit: String? = "macbook-pro-0001", appleID: String? = nil, poll: Duration = .milliseconds(20),
                      sharing: Made? = nil) throws -> Made {
        let home = try ScriptedHome(state.answer)
        let socket = HomeSocket(path: home.path, folder: home.folder, patience: 0.5)
        let door = sharing?.door ?? Door()
        let stored = try JSONSerialization.data(withJSONObject: ["name": "http://127.0.0.1:4680", "pass": "fake-pass-000000000000",
                                                                 "paired": true, "unit": unit as Any])
        let link = HomeLink(device: .init(kind: .mac, version: "0.9.0", model: "Mac15,3", serial4: nil), credentials: Memory(stored),
                            folder: scratch, transport: door, files: DeviceFiles(.plain))
        let askDoor = sharing?.askDoor ?? .live { link }
        let asked = Asked()
        let reads = Asked()
        asked.held = held
        let ask = GrantAsk.System(held: { asked.held.contains($0) }, unanswered: { $0.questioned && asked.unanswered },
                                  question: { asked.note("question \($0.rawValue)") },
                                  pane: { grant in
                                      await asked.opening()
                                      asked.note("pane \(grant.rawValue)")
                                  },
                                  settingsOpen: { asked.settings }, away: { asked.away }, every: .milliseconds(10), opening: .milliseconds(50),
                                  alerts: { asked.alerting.contains($0) },
                                  alert: { grant in
                                      asked.note("alert \(grant.rawValue)")
                                      asked.alerting.remove(grant)
                                  },
                                  putAway: { asked.note("put away") })
        let store = MemoryStore()
        store.data = Data(repeating: 7, count: 32)
        let keeper = VaultKeeper(machine: store, old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { socket })
        let needs = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        let lines = StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true))
        let told = Asked()
        needs.knock = { told.note("knock") }
        let settings = MacSettings(file: FileManager.default.temporaryDirectory.appendingPathComponent("mac-settings-\(UUID().uuidString)/settings.json"), defaults: ["screen": ["apps": AppsField.of(.defaults)]], files: DeviceFiles(.plain))
        let apps = [("com.1password.1password", "1Password"), ("com.apple.Safari", "Safari"), ("com.example.notes-fake", "Notes Fake")]
            .map { Detection.App(id: $0.0, name: $0.1, url: URL(fileURLWithPath: "/Applications/\($0.1).app")) }
        let found = HostState.Found(browsers: [
            .init(id: "chrome", name: "Chrome", profiles: [.init(id: "person-a@example.com", name: "Person A")]),
            .init(id: "arc", name: "Arc", profiles: []),
        ], apps: apps)
        let drawn = Asked()
        let host = MacHost(needs: needs, lines: lines,
                           socket: { socket }, readGrants: { now.merging(asked.held.map { ($0, true) }) { $1 } }, readFolder: { nil },
                           detect: {
                               reads.note("read")
                               return found
                           },
                           unit: { unit }, appleID: { appleID }, door: askDoor, ask: ask, poll: poll,
                           drawQR: { link in
                               drawn.note(link)
                               return QRImage.dataURL(link)
                           },
                           settings: settings)
        let sight = Sight()
        host.seen = {
            sight.looks += 1
            return sight.seen
        }
        let called = Asked()
        host.asked = { called.note($0) }
        return Made(host: host, home: home, door: door, askDoor: askDoor, asked: asked, reads: reads, told: told, settings: settings, sight: sight,
                    drawn: drawn, called: called)
    }

    private func refusal(_ work: () async throws -> String?) async -> String? {
        do {
            _ = try await work()
            return nil
        } catch {
            return (error as? HostRefusal)?.words ?? "not words: \(error)"
        }
    }

    private func state(_ host: MacHost) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(HostBridge.scriptLiteral(host.state).utf8)) as? [String: Any])
    }

    private func lines(_ home: ScriptedHome) -> [String] {
        home.requests.map { request in
            ([request["verb"] as? String ?? "?"] + (request["args"] as? [String] ?? [])).joined(separator: " ")
        }
    }

    func testTheStateCarriesWhatTheOnboardingReads() async throws {
        let made = try make(Home(), grants: [.screenRecording: true, .accessibility: true, .bluetooth: true])
        defer { made.home.stop() }
        await made.host.read()
        await made.host.read()
        XCTAssertEqual(made.reads.steps.count, 1, "the apps were looked for again at a read that was not an open")
        let state = try state(made.host)
        XCTAssertNil(state["sheets"], "a connector has a sheet of its own")
        XCTAssertEqual(state["signins"] as? [String], ["key", "device", "client"], "the ways of signing in this app draws, whatever the connector")
        let browsers = try XCTUnwrap(state["browsers"] as? [[String: Any]])
        XCTAssertEqual(browsers.map { $0["id"] as? String }, ["chrome", "arc"])
        XCTAssertEqual((browsers[0]["profiles"] as? [[String: String]])?.first, ["id": "person-a@example.com", "name": "Person A"])
        XCTAssertNil(state["restart_due"], "the app never restarts itself for a grant: macOS's Quit & Reopen does")
        XCTAssertEqual(((state["ask_login"] as? [String: Any])?["chatgpt"] as? [String: Any])?["state"] as? String, "absent",
                       "Ask's subscriptions, read through the door")
        for absent in ["pairing", "phone_app", "connect_requests"] { XCTAssertNil(state[absent], "\(absent) while its step is closed") }

        let grants = try XCTUnwrap(state["grants"] as? [[String: Any]])
        XCTAssertEqual(grants.filter { $0["optional"] as? Bool == true }.map { $0["id"] as? String }, ["bluetooth"])
        XCTAssertNil(grants.first { $0["id"] as? String == "inputMonitoring" }, "Input Monitoring is asked, though Accessibility brings it")

        try record("host-v6-state", ["state": state])
    }

    func testTheStateNamesTheMacAccountWhileTheOnboardingShows() async throws {
        let made = try make(Home())
        defer { made.home.stop() }
        await made.host.read()
        XCTAssertNil(try state(made.host)["account_name"], "account_name stated with the onboarding not showing")
        made.host.onboarding = true
        XCTAssertEqual(try state(made.host)["account_name"] as? String, NSFullUserName(), "the state does not name the Mac account")
        made.host.onboarding = false
        XCTAssertNil(try state(made.host)["account_name"], "account_name outlived the onboarding")

        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        let unnamed = MacHost(needs: NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper)),
                              lines: StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true)),
                              socket: { nil },
                              readGrants: { [:] }, readFolder: { nil }, accountName: "", ask: .untouched)
        unnamed.onboarding = true
        XCTAssertEqual(try state(unnamed)["account_name"] as? String, "", "an account macOS names with nothing is not stated as ''")
        try record("account-name", ["stated": NSFullUserName().isEmpty ? "empty" : "named"])
    }

    func testAnAllowAsksItsGrantsOneAfterAnotherAndEachRowReadsAskingUntilItLands() async throws {
        let made = try make(Home(), grants: [.accessibility: false], held: [])
        defer { made.home.stop() }
        let host = made.host
        host.start(polling: { false })
        defer { host.stop() }
        func asking() throws -> [String] {
            try XCTUnwrap(state(host)["grants"] as? [[String: Any]]).filter { $0["asking"] as? Bool == true }.compactMap { $0["id"] as? String }
        }
        var screen: [Bool] = []
        var loading: [Int] = []
        host.published = { state in
            if let row = state.grants.first(where: { $0.id == "screenRecording" }) { screen.append(row.asking || row.granted) }
            loading.append(state.grants.filter(\.asking).count)
        }
        made.asked.opening = { host.grantAsk.cameBack() }
        try await until("!host.state.grants.isEmpty") { !host.state.grants.isEmpty }

        _ = try await host.perform(.allow([.screenRecording, .accessibility]))
        XCTAssertEqual(try asking(), ["screenRecording"], "the first row read idle as the act answered, or the next read asking before its turn")
        try await until("made.asked.steps == [\"put away\", \"pane screenRecording\"]") { made.asked.steps == ["put away", "pane screenRecording"] }
        XCTAssertNil(try state(host)["walk"])
        made.asked.away = true
        made.asked.held.insert(.screenRecording)
        try await until("made.asked.steps == [\"put away\", \"pane screenRecording\", \"pane accessibility\"]") {
            made.asked.steps == ["put away", "pane screenRecording", "pane accessibility"]
        }
        try await until("(try? asking()) == [\"accessibility\"]") { (try? asking()) == ["accessibility"] }
        XCTAssertEqual(host.state.grants.first { $0.id == "screenRecording" }?.granted, true)
        made.asked.held.insert(.accessibility)
        try await until("host.grantAsk.asking.isEmpty") { host.grantAsk.asking.isEmpty }
        XCTAssertEqual(made.asked.steps, ["put away", "pane screenRecording", "pane accessibility", "put away"])
        XCTAssertEqual(try asking(), [])
        XCTAssertEqual(host.state.grants.filter(\.granted).map(\.id).sorted(), ["accessibility", "screenRecording"])
        XCTAssertFalse(screen.drop { !$0 }.contains(false), "Screen Recording's row went idle between asking and granted")
        XCTAssertFalse(loading.contains { $0 > 1 }, "two rows read asking at once")
        let run = loading.drop { $0 == 0 }
        XCTAssertFalse(run.isEmpty)
        XCTAssertTrue(run.drop { $0 == 1 }.allSatisfy { $0 == 0 }, "the card read idle between one grant and the next")

        made.asked.away = false
        _ = try await host.perform(.allow([.microphone, .accessibility]))
        try await until("host.grantAsk.asking.isEmpty") { host.grantAsk.asking.isEmpty }
        XCTAssertEqual(Array(made.asked.steps.dropFirst(4)), ["put away", "question microphone"])
        func denied() throws -> [String] {
            try XCTUnwrap(state(host)["grants"] as? [[String: Any]]).filter { $0["denied"] as? Bool == true }.compactMap { $0["id"] as? String }
        }
        XCTAssertEqual(try denied(), ["microphone"])

        made.asked.away = false
        made.asked.opening = {}
        _ = try await host.perform(.allow([.bluetooth, .systemAudio]))
        XCTAssertEqual(try denied(), ["microphone"], "a grant asked again still read denied")
        try await until("made.asked.steps.last == \"question bluetooth\"") { made.asked.steps.last == "question bluetooth" }
        try await until("host.grantAsk.asking.isEmpty") { host.grantAsk.asking.isEmpty }
        XCTAssertEqual(try denied(), ["microphone", "bluetooth"], "the ask went on past a grant answered no")
        XCTAssertFalse(made.asked.steps.contains("question systemAudio"))
        made.asked.unanswered = false
        _ = try await host.perform(.allow([.microphone]))
        XCTAssertEqual(try denied(), ["bluetooth"], "a grant asked again still read denied")
        try await until("made.asked.steps.last == \"pane microphone\"") { made.asked.steps.last == "pane microphone" }
        made.asked.settings = false
        try await until("host.grantAsk.asking.isEmpty") { host.grantAsk.asking.isEmpty }
        XCTAssertEqual(try denied(), ["microphone", "bluetooth"], "System Settings quit and the grant was not denied")
        made.asked.settings = true

        made.asked.away = true
        _ = try await host.perform(.allow([.fullDiskAccess, .systemAudio]))
        try await until("made.asked.steps.last == \"pane fullDiskAccess\"") { made.asked.steps.last == "pane fullDiskAccess" }
        XCTAssertEqual(made.asked.steps.suffix(3), ["pane microphone", "put away", "pane fullDiskAccess"])
        NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
        try await until("(try? asking()) == []") { (try? asking()) == [] }
        XCTAssertFalse(made.asked.steps.contains("pane systemAudio"), "the next pane opened once the person came back")
        XCTAssertTrue(try denied().contains("fullDiskAccess"), "back without it, and not denied")
        _ = try await host.perform(.allow([.fullDiskAccess]))
        _ = try await host.perform(.allow([.systemAudio]))
        XCTAssertEqual(try asking(), ["systemAudio"], "another Allow did not replace the one standing")
        host.stop()
        XCTAssertTrue(host.grantAsk.asking.isEmpty)
        try record("host-v6-ask", ["asked": made.asked.steps])
    }

    func testScreenRecordingsFirstAskIsMacOSsAlertAloneThenThePaneWithThePanel() async throws {
        let made = try make(Home(), grants: [.screenRecording: false], held: [])
        defer { made.home.stop() }
        let host = made.host
        host.start(polling: { false })
        defer { host.stop() }
        try await until("!host.state.grants.isEmpty") { !host.state.grants.isEmpty }

        made.asked.alerting = [.screenRecording]
        made.asked.settings = false
        _ = try await host.perform(.allow([.screenRecording]))
        try await until("made.asked.steps == [\"put away\", \"alert screenRecording\"]") { made.asked.steps == ["put away", "alert screenRecording"] }
        try await Task.sleep(for: .milliseconds(60))
        XCTAssertNil(host.panel.shown, "the panel showed beside macOS's alert")
        XCTAssertEqual(host.grantAsk.asking, [.screenRecording])
        made.asked.away = true
        made.asked.settings = true
        try await until("host.panel.shown != nil") { host.panel.shown != nil }
        XCTAssertEqual(host.panel.shown?.after, "When macOS asks, choose **Quit & Reopen**. Lifestream comes back right here.")
        XCTAssertFalse(made.asked.steps.contains("pane screenRecording"), "a second pane opened over macOS's own")
        made.asked.held.insert(.screenRecording)
        try await until("host.grantAsk.asking.isEmpty") { host.grantAsk.asking.isEmpty }
        XCTAssertEqual(host.state.grants.first { $0.id == "screenRecording" }?.granted, true)
        XCTAssertEqual(made.asked.steps, ["put away", "alert screenRecording"])

        made.asked.held.remove(.screenRecording)
        made.asked.alerting = [.screenRecording]
        made.asked.settings = false
        made.asked.away = false
        _ = try await host.perform(.allow([.screenRecording]))
        try await until("made.asked.steps == [\"put away\", \"alert screenRecording\", \"put away\", \"alert screenRecording\"]") {
            made.asked.steps == ["put away", "alert screenRecording", "put away", "alert screenRecording"]
        }
        host.grantAsk.resigned()
        host.grantAsk.cameBack()
        try await until("host.grantAsk.asking.isEmpty") { host.grantAsk.asking.isEmpty }
        XCTAssertTrue(host.grantAsk.denied.contains(.screenRecording))
        XCTAssertNil(host.panel.shown)
        made.asked.settings = true
        _ = try await host.perform(.allow([.screenRecording]))
        try await until("made.asked.steps.last == \"pane screenRecording\"") { made.asked.steps.last == "pane screenRecording" }
        try await until("host.panel.shown != nil") { host.panel.shown != nil }
        try record("host-v6-screen-alert", ["asked": made.asked.steps])
    }

    func testSkipAndAtGoOverTheSocket() async throws {
        let made = try make(Home())
        defer { made.home.stop() }
        _ = try await made.host.perform(.skip(step: "iphone"))
        _ = try await made.host.perform(.at(step: "browser"))
        XCTAssertEqual(lines(made.home), ["setup skip macbook-pro-0001 iphone", "setup at macbook-pro-0001 browser"])
        let unpaired = try make(Home(), unit: nil)
        defer { unpaired.home.stop() }
        let alone = await refusal { try await unpaired.host.perform(.skip(step: "iphone")) }
        XCTAssertEqual(alone, "This Mac is not paired with Lifestream yet.")
        let nowhere = await refusal { try await unpaired.host.perform(.at(step: "browser")) }
        XCTAssertEqual(nowhere, "This Mac is not paired with Lifestream yet.")
        XCTAssertEqual(lines(unpaired.home), [], "a skip or a place went out for a Mac with no unit")
    }

    private func asks(_ home: ScriptedHome) -> [String] {
        lines(home).filter { $0.hasPrefix("pair") || $0.hasPrefix("connect") }
    }

    private func settle(_ made: Made, looking times: Int = 0) async throws {
        _ = try await made.host.perform(.skip(step: "model"))
        let looks = made.sight.looks
        try await until("the loop looked \(times) more times") { made.sight.looks >= looks + times }
    }

    func testThePairingCodeIsAskedForWhileTheCardIsWantedAndTheWindowSeen() async throws {
        let home = Home()
        let made = try make(home, appleID: "person-a@example.com")
        defer { made.home.stop() }
        let host = made.host
        host.start(polling: { false })
        defer { host.stop() }
        func pairing() -> [String: Any]? { (try? self.state(host))?["pairing"] as? [String: Any] }
        func shows() -> Int { asks(made.home).filter { $0.hasPrefix("pair show") }.count }

        XCTAssertTrue(host.want(.pairing(open: true)), "pairing is not one of the page's setters")
        try await until("the first code in the state") { pairing()?["code"] as? String == "48210001" }
        XCTAssertEqual(asks(made.home).first, "pair show --account person-a@example.com")
        try await until("the code asked for again at each poll") { shows() >= 4 }
        let first = try XCTUnwrap(pairing())
        XCTAssertEqual(first["link"] as? String, Self.homeLink("48210001"))
        XCTAssertEqual(PairingLink(try XCTUnwrap(first["link"] as? String))?.addresses.map(\.absoluteString),
                       ["https://mac-0001.local:4682", "https://100.64.0.1:4682"])
        let qr = try XCTUnwrap(first["qr"] as? String)
        XCTAssertTrue(qr.hasPrefix("data:image/png;base64,"))
        let png = try XCTUnwrap(Data(base64Encoded: String(qr.dropFirst("data:image/png;base64,".count))))
        let drawing = try XCTUnwrap(NSBitmapImageRep(data: png), "the QR code is no image")
        let quiet = Int(QRImage.quiet * QRImage.module)
        XCTAssertEqual(drawing.pixelsWide, drawing.pixelsHigh)
        XCTAssertEqual(drawing.pixelsWide % Int(QRImage.module), 0)
        for x in 0..<drawing.pixelsWide {
            for y in 0..<drawing.pixelsHigh where x < quiet || y < quiet || x >= drawing.pixelsWide - quiet || y >= drawing.pixelsHigh - quiet {
                guard let colour = drawing.colorAt(x: x, y: y)?.usingColorSpace(.sRGB), colour.brightnessComponent > 0.99 else {
                    return XCTFail("a dark pixel in the quiet zone at \(x), \(y)")
                }
            }
        }
        XCTAssertEqual(try Self.decoded(qr), Self.homeLink("48210001"))
        XCTAssertEqual(first["match"] as? String, "K7QF")
        XCTAssertEqual(first["expires_ms"] as? Int64, 4_102_444_800_000)
        let app = try XCTUnwrap(try self.state(host)["phone_app"] as? [String: Any])
        XCTAssertEqual(app["link"] as? String, HostState.PhoneApp.link)
        XCTAssertEqual(try Self.decoded(try XCTUnwrap(app["qr"] as? String)), HostState.PhoneApp.link)
        XCTAssertEqual(made.drawn.steps, [Self.homeLink("48210001")], "a link drawn again at each answer")

        home.renew()
        try await until("the new code in the state") { pairing()?["code"] as? String == "48210002" }
        XCTAssertEqual(try Self.decoded(try XCTUnwrap(pairing()?["qr"] as? String)), Self.homeLink("48210002"))
        XCTAssertEqual(made.drawn.steps, [Self.homeLink("48210001"), Self.homeLink("48210002")])

        home.wifi = false
        home.renew()
        try await until("the code with no link") { pairing()?["code"] as? String == "48210003" }
        XCTAssertTrue(pairing()?["link"] is NSNull, "a link to nothing")
        XCTAssertTrue(pairing()?["qr"] is NSNull, "a QR code of nothing")
        XCTAssertEqual(pairing()?["why"] as? String, "Lifestream can't open its Wi-Fi connection. Quit what uses port 4682, or restart Lifestream.")
        XCTAssertNotNil(try self.state(host)["phone_app"], "the app's link is not the Wi-Fi's: it stays beside the words")
        home.wifi = true
        try await until("the same digits with their link") { pairing()?["link"] as? String == Self.homeLink("48210003") }
        XCTAssertEqual(pairing()?["code"] as? String, "48210003")
        XCTAssertTrue(pairing()?["why"] is NSNull)
        XCTAssertEqual(try Self.decoded(try XCTUnwrap(pairing()?["qr"] as? String)), Self.homeLink("48210003"))
        XCTAssertEqual(made.drawn.steps.count, 3, "each link drawn once")

        made.sight.seen = false
        host.wake()
        try await settle(made)
        let unseen = shows()
        try await settle(made, looking: 5)
        XCTAssertEqual(shows(), unseen, "the code was asked for while the window was unseen")
        XCTAssertEqual(pairing()?["code"] as? String, "48210003", "the code left the state as the window went unseen")
        made.sight.seen = true
        host.wake()
        try await until("asked as the window is seen") { shows() > unseen }

        XCTAssertTrue(host.want(.pairing(open: false)))
        XCTAssertNil(pairing(), "the code outlived the card's close")
        XCTAssertNil(try self.state(host)["phone_app"], "the app's link outlived the card's close")
        try await settle(made)
        let closed = shows()
        try await settle(made, looking: 5)
        XCTAssertEqual(shows(), closed, "the code was asked for after the card closed")
        XCTAssertNil(pairing())
        XCTAssertEqual(Set(asks(made.home)), ["pair show --account person-a@example.com"])
        try record("host-v6-pairing", ["socket": lines(made.home), "drawn": made.drawn.steps])
    }

    func testACodeOfAMacWithNoAppleIDCarriesNone() async throws {
        let made = try make(Home())
        defer { made.home.stop() }
        made.host.start(polling: { false })
        defer { made.host.stop() }
        _ = made.host.want(.pairing(open: true))
        try await until("the code in the state") { made.host.state.pairing != nil }
        XCTAssertEqual(asks(made.home).first, "pair show")
    }

    func testTheBrowserWaitIsAskedForWhileTheFlowIsWanted() async throws {
        let home = Home()
        let made = try make(home)
        defer { made.home.stop() }
        let host = made.host
        host.start(polling: { false })
        defer { host.stop() }
        func requests() -> [[String: Any]]? { (try? self.state(host))?["connect_requests"] as? [[String: Any]] }
        func connects() -> Int { asks(made.home).filter { $0 == "connect" }.count }
        let knocks = made.told.steps.count

        XCTAssertTrue(host.want(.connectWait(open: true)), "connect-wait is not one of the page's setters")
        try await until("the wait's first answer in the state") { requests()?.isEmpty == true }
        try await until("a fresh answer asked with the first answer") { made.told.steps.count == knocks + 1 }
        try await until("the requests asked for again at each poll") { connects() >= 4 }
        XCTAssertEqual(made.told.steps.count, knocks + 1, "a later answer knocked again")

        home.asking = [["id": "r-0001", "browser": "Chrome"]]
        try await until("the request in the state") { requests()?.count == 1 }
        let request = try XCTUnwrap(requests()?.first)
        XCTAssertEqual(request["id"] as? String, "r-0001")
        XCTAssertEqual(request["browser"] as? String, "Chrome")
        XCTAssertEqual(Set(request.keys), ["id", "browser"])
        let asked = connects()
        try await until("asked again with the request standing") { connects() >= asked + 3 }
        XCTAssertEqual(made.called.steps, ["Chrome"], "a request seen before called the window again")

        _ = try await host.perform(.connectAnswer(id: "r-0001", allow: true))
        XCTAssertTrue(lines(made.home).contains("connect answer r-0001 allow"))
        XCTAssertEqual(requests()?.count, 0, "an answered request stayed in the state, so the page could only guess it was answered")
        let again = await refusal { try await host.perform(.connectAnswer(id: "r-0001", allow: true)) }
        XCTAssertEqual(again, "no request r-0001 waits: it was answered, its browser stopped asking, or the Browser step stopped waiting")

        XCTAssertTrue(host.want(.connectWait(open: false)))
        XCTAssertNil(requests(), "the requests outlived the flow")
        try await settle(made)
        let left = connects()
        try await settle(made, looking: 5)
        XCTAssertEqual(connects(), left, "the requests were asked for after the flow was left")
        XCTAssertEqual(Set(asks(made.home)), ["connect", "connect answer r-0001 allow"], "an act reached the home as a verb of its own")
        XCTAssertEqual(made.drawn.steps, [], "a link drawn with no pairing card")
        try record("host-v6-browser", ["socket": lines(made.home), "told": made.told.steps, "called": made.called.steps])
    }

    func testTheWindowsSightLeavesTheBrowserWaitsAnswerAlone() async throws {
        let home = Home()
        let made = try make(home, poll: .seconds(600))
        defer { made.home.stop() }
        let host = made.host
        host.start(polling: { false })
        defer { host.stop() }
        func connects() -> Int { asks(made.home).filter { $0 == "connect" }.count }

        _ = host.want(.pairing(open: true))
        _ = host.want(.connectWait(open: true))
        try await until("both in the state") { host.state.pairing != nil && host.state.connectRequests != nil }
        let gate = home.hold("connect")
        host.wake()
        try await until("the wait's ask on the socket, its answer made and held") { home.holding }
        let asked = connects()
        home.asking = [["id": "r-0001", "browser": "Chrome"]]
        made.sight.seen = false
        host.wake()
        made.sight.seen = true
        host.wake()
        gate.signal()
        try await settle(made)
        XCTAssertEqual(connects(), asked, "the wait's answer was dropped and asked again as the window's sight changed")
        XCTAssertEqual(host.state.connectRequests?.count, 0, "the wait's answer was not published")
    }

    func testAResetDropsTheIntentAndTheWindowsCloseHoldsItTillTheWindowOpensAgain() async throws {
        let made = try make(Home())
        defer { made.home.stop() }
        let host = made.host
        host.start(polling: { false })
        defer { host.stop() }
        func both() -> Bool { host.state.pairing != nil && host.state.connectRequests != nil }
        func neither() -> Bool { host.state.pairing == nil && host.state.phoneApp == nil && host.state.connectRequests == nil }

        _ = host.want(.pairing(open: true))
        _ = host.want(.connectWait(open: true))
        try await until("both in the state") { both() }
        host.resetIntent()
        XCTAssertTrue(neither(), "a reset left a member in the state")
        try await settle(made)
        let reset = asks(made.home).count
        try await settle(made, looking: 5)
        XCTAssertEqual(asks(made.home).count, reset, "asked after the reset, before the page said again")

        _ = host.want(.pairing(open: true))
        _ = host.want(.connectWait(open: true))
        try await until("both in the state again") { both() }
        host.stop()
        XCTAssertTrue(neither(), "the window's close left a member in the state")
        host.wake()
        try await settle(made)
        let closed = asks(made.home).count
        host.wake()
        try await settle(made)
        XCTAssertEqual(asks(made.home).count, closed, "asked after the window closed")
        XCTAssertTrue(neither())
        XCTAssertTrue(host.closed)

        host.start(polling: { false })
        XCTAssertFalse(host.closed)
        try await until("both asked for again as the window opened") { both() && asks(made.home).count > closed }
        host.resetIntent()
        host.stop()
        try await settle(made)
        let empty = asks(made.home).count
        host.start(polling: { false })
        try await settle(made)
        XCTAssertEqual(asks(made.home).count, empty, "asked on opening again for an intent the page had reset")
        XCTAssertTrue(neither())
    }

    func testAHomeThatDoesNotAnswerIsAskedOnceAtATimeAndAgainOnceItFails() async throws {
        let home = Home()
        let made = try make(home, poll: .seconds(600))
        defer { made.home.stop() }
        let host = made.host
        host.start(polling: { false })
        defer { host.stop() }
        func shows() -> Int { asks(made.home).filter { $0 == "pair show" }.count }

        _ = host.want(.pairing(open: true))
        try await until("the first code in the state") { host.state.pairing?.code == "48210001" }
        let gate = home.hold(fails: true)
        host.wake()
        try await until("the next ask on the socket, unanswered") { home.holding }
        XCTAssertEqual(shows(), 2)
        for _ in 0..<5 { host.wake() }
        XCTAssertEqual(host.state.pairing?.code, "48210001", "a home that does not answer changed the state")
        gate.signal()
        try await settle(made)
        XCTAssertEqual(shows(), 2, "a second ask was started while one was outstanding")
        XCTAssertEqual(host.state.pairing?.code, "48210001", "a failed ask changed the state")
        home.renew()
        host.wake()
        try await until("asked again once it failed") { host.state.pairing?.code == "48210002" }
        XCTAssertEqual(shows(), 3)
    }

    func testWorkOfAnOlderRunPublishesNothing() async throws {
        let home = Home()
        let made = try make(home, poll: .seconds(600))
        defer { made.home.stop() }
        let host = made.host
        host.start(polling: { false })
        defer { host.stop() }
        func shows() -> Int { asks(made.home).filter { $0 == "pair show" }.count }
        var codes: [String?] = []
        host.published = { codes.append($0.pairing?.code) }

        _ = host.want(.pairing(open: true))
        try await until("the first code in the state") { host.state.pairing?.code == "48210001" }
        home.renew()
        let gate = home.hold()
        host.wake()
        try await until("the ask on the socket, its answer made and held") { home.holding }
        XCTAssertEqual(shows(), 2)
        home.renew()
        codes = []
        for _ in 0..<3 {
            _ = host.want(.pairing(open: false))
            _ = host.want(.pairing(open: true))
        }
        XCTAssertNil(host.state.pairing)
        gate.signal()
        try await until("the new run's code in the state") { host.state.pairing?.code == "48210003" }
        try await settle(made)
        XCTAssertFalse(codes.contains("48210002"), "an answer of an older run was published: \(codes)")
        XCTAssertFalse(made.drawn.steps.contains(Self.homeLink("48210002")), "an answer of an older run was drawn")
        XCTAssertEqual(made.drawn.steps, [Self.homeLink("48210001"), Self.homeLink("48210003")])
        XCTAssertEqual(shows(), 3, "the new run asked beside the old run's ask")

        let late = home.hold()
        host.wake()
        try await until("the ask on the socket, its answer made and held") { home.holding }
        XCTAssertEqual(shows(), 4)
        _ = host.want(.pairing(open: false))
        late.signal()
        try await settle(made)
        XCTAssertNil(host.state.pairing, "a closed card's code came back")
        XCTAssertEqual(shows(), 4)
        try record("host-v6-late", ["socket": lines(made.home), "published": codes.map { $0 ?? "none" }])
    }

    private static func decoded(_ qr: String) throws -> String? {
        let png = try XCTUnwrap(Data(base64Encoded: String(qr.dropFirst("data:image/png;base64,".count))))
        let image = try XCTUnwrap(CIImage(data: png), "the QR code is no image")
        let detector = try XCTUnwrap(CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]))
        return detector.features(in: image).compactMap { ($0 as? CIQRCodeFeature)?.messageString }.first
    }

    private func subscription(_ host: MacHost, _ of: String) -> [String: Any]? {
        ((try? self.state(host)["ask_login"] as? [String: Any])?[of] as? [String: Any])
    }

    func testAsksSubscriptionsGoThroughTheDoorWithThisMacsPassAndAreFollowedUntilNeitherDownloadsNorSignsIn() async throws {
        let made = try make(Home())
        defer { made.home.stop() }
        let host = made.host
        made.door.then([["claude": ["state": "fetching", "bytes": 120_000_000, "total": 324_000_000]],
                        ["claude": ["state": "fetching", "bytes": 300_000_000, "total": 324_000_000]],
                        ["claude": ["state": "signing_in", "attempt": "0f3a9c2e7b1d4a60", "url": "https://claude.example.com/oauth/authorize"]],
                        ["claude": ["state": "signed_in", "account": "person-a@example.com", "plan": "max"]]])
        _ = try await host.perform(.askLogin(.start(.claude)))
        XCTAssertEqual(subscription(host, "claude")?["bytes"] as? Int64, 120_000_000, "the download's share passed to the page")
        try await until("Claude followed through its download and sign-in") { self.subscription(host, "claude")?["state"] as? String == "signed_in" }
        XCTAssertEqual(subscription(host, "claude")?["plan"] as? String, "max")
        let settled = made.door.gets
        let posts = made.door.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.map(\.body), [.json(Data(#"{"do":"start","of":"claude"}"#.utf8))])
        for request in made.door.requests {
            XCTAssertEqual(request.url.absoluteString, "http://127.0.0.1:4680/v1/ask/login")
            XCTAssertEqual(request.headers["Lifestream-Device"], "mac/0.9.0")
            XCTAssertEqual(request.headers["Authorization"], "Bearer fake-pass-000000000000")
        }
        _ = try await host.perform(.skip(step: "model"))
        _ = try await host.perform(.skip(step: "model"))
        XCTAssertEqual(made.door.gets, settled, "the subscriptions were followed on once they settled")

        _ = try await host.perform(.askLogin(.code(attempt: "0f3a9c2e7b1d4a60", code: "synthetic-code#synthetic-state")))
        _ = try await host.perform(.askLogin(.signOut(.claude)))
        let acts = made.door.requests.filter { $0.method == "POST" }.suffix(2).map(\.body)
        XCTAssertEqual(acts, [.json(Data(#"{"attempt":"0f3a9c2e7b1d4a60","code":"synthetic-code#synthetic-state","do":"code","of":"claude"}"#.utf8)),
                              .json(Data(#"{"do":"sign_out","of":"claude"}"#.utf8))])

        made.door.then([["chatgpt": ["state": "failed", "why": "Chat needs a paid ChatGPT plan."]]])
        await host.read()
        XCTAssertEqual(subscription(host, "chatgpt")?["why"] as? String, "Chat needs a paid ChatGPT plan.")

        made.door.then([["chatgpt": ["state": "signing_in", "attempt": "login-1", "code": "WXYZ-1234", "url": "https://auth.example.com/device"]]])
        _ = try await host.perform(.askLogin(.start(.chatgpt)))
        XCTAssertEqual(subscription(host, "chatgpt")?["code"] as? String, "WXYZ-1234")
        let following = made.door.gets
        try await until("the code followed") { made.door.gets > following + 1 }
        made.door.then([["chatgpt": ["state": "signed_out"]]])
        let cancelled = made.door.gets
        _ = try await host.perform(.askLogin(.cancel(.chatgpt)))
        XCTAssertEqual(made.door.requests.last { $0.method == "POST" }?.body, .json(Data(#"{"do":"cancel","of":"chatgpt"}"#.utf8)))
        XCTAssertEqual(subscription(host, "chatgpt")?["state"] as? String, "signed_out", "the cancel's own answer not the state")
        try await until("the follow read it settled") { made.door.gets > cancelled }
        let ended = made.door.gets
        _ = try await host.perform(.skip(step: "model"))
        _ = try await host.perform(.skip(step: "model"))
        XCTAssertEqual(made.door.gets, ended, "followed on once the door said it settled")
        try record("host-v6-ask-login", ["door": made.door.requests.map { "\($0.method) \($0.url.path)" },
                                         "ask_login": try XCTUnwrap(try self.state(host)["ask_login"])])
    }

    func testTheWindowClosingCancelsEachSubscriptionUnderWayAndAStartNotAnsweredYet() async throws {
        let made = try make(Home())
        defer { made.home.stop() }
        let host = made.host
        made.door.then([["claude": ["state": "fetching", "bytes": 0, "total": 324_000_000], "chatgpt": ["state": "signed_in"]]])
        _ = try await host.perform(.askLogin(.start(.claude)))
        host.stop()
        try await until("Claude's operation cancelled as the window closed") {
            made.door.requests.contains { $0.method == "POST" && $0.body == .json(Data(#"{"do":"cancel","of":"claude"}"#.utf8)) }
        }
        XCTAssertFalse(made.door.requests.contains { $0.body == .json(Data(#"{"do":"cancel","of":"chatgpt"}"#.utf8)) },
                       "a subscription signed in was cancelled")
    }

    func testAStartNotAnsweredWhenTheWindowClosesIsCancelledOnceAfterItsAnswer() async throws {
        let made = try make(Home())
        defer { made.home.stop() }
        let host = made.host
        made.door.holdStarts = true
        let start = Task { try await host.perform(.askLogin(.start(.chatgpt))) }
        try await until("the start sent and held") { made.door.requests.contains { $0.method == "POST" } }
        let cancel = HomeRequest.Body.json(Data(#"{"do":"cancel","of":"chatgpt"}"#.utf8))
        host.stop()
        made.door.release()
        _ = try? await start.value
        try await until("the start cancelled as the window closed") { made.door.requests.contains { $0.body == cancel } }
        let sent = made.door.requests.firstIndex { $0.body == cancel } ?? -1
        XCTAssertGreaterThanOrEqual(sent, try XCTUnwrap(made.door.startsAnswered.first), "the cancel sent before the start's answer")
        await host.read()
        XCTAssertEqual(made.door.requests.filter { $0.body == cancel }.count, 1, "cancelled more than once")
    }

    func testANewerWindowsStartGoesAfterTheClosingWindowsCancel() async throws {
        let first = try make(Home())
        defer { first.home.stop() }
        let second = try make(Home(), sharing: first)
        defer { second.home.stop() }
        first.door.holdStarts = true
        let start = Task { try await first.host.perform(.askLogin(.start(.chatgpt))) }
        try await until("the first window's start sent and held") { first.door.requests.contains { $0.method == "POST" } }
        first.host.stop()
        let pressed = Asked()
        let newer = Task {
            pressed.note("start")
            return try await second.host.perform(.askLogin(.start(.chatgpt)))
        }
        try await until("the second window's start pressed") { pressed.steps == ["start"] }
        first.door.release()
        _ = try? await start.value
        _ = try await newer.value
        let (begin, cancel) = (HomeRequest.Body.json(Data(#"{"do":"start","of":"chatgpt"}"#.utf8)),
                               HomeRequest.Body.json(Data(#"{"do":"cancel","of":"chatgpt"}"#.utf8)))
        XCTAssertEqual(first.door.requests.filter { $0.method == "POST" }.map(\.body), [begin, cancel, begin])
    }

    func testACancelledSignInsCodeNeverComesBackToTheSameHostOpenedAgain() async throws {
        let made = try make(Home())
        defer { made.home.stop() }
        let host = made.host
        host.start(polling: { false })
        defer { host.stop() }
        let signing: [String: Any] = ["state": "signing_in", "attempt": "0f3a9c2e7b1d4a60",
                                      "url": "https://auth.example.com/device", "code": "ABCD-1234"]
        made.door.then([["chatgpt": signing, "claude": signing]])
        _ = try await host.perform(.askLogin(.start(.chatgpt)))
        XCTAssertEqual(subscription(host, "chatgpt")?["code"] as? String, "ABCD-1234")

        host.stop()
        for member in ["attempt", "url", "code"] {
            XCTAssertNil(subscription(host, "chatgpt")?[member] as? String, "a cancelled sign-in kept its \(member) past the close")
        }
        made.door.failGets = true
        host.start(polling: { false })
        await host.read()
        XCTAssertNil(subscription(host, "chatgpt")?["code"] as? String, "the cancelled code came back as the window opened again")
        XCTAssertEqual(subscription(host, "chatgpt")?["state"] as? String, "signed_out",
                       "a cancelled sign-in still signing in, with nothing to open, its Sign in not offered")

        made.door.holdStarts = true
        let start = Task { try await host.perform(.askLogin(.start(.claude))) }
        try await until("the start sent and held") {
            made.door.requests.contains { $0.body == .json(Data(#"{"do":"start","of":"claude"}"#.utf8)) }
        }
        host.stop()
        host.start(polling: { false })
        made.door.release()
        _ = try? await start.value
        XCTAssertNil(subscription(host, "claude")?["code"] as? String, "a start answered after the close landed in the next opening")
    }

    func testASignOutAnsweredAfterTheWindowOpenedAgainShows() async throws {
        let made = try make(Home())
        defer { made.home.stop() }
        let host = made.host
        host.start(polling: { false })
        defer { host.stop() }
        made.door.then([["claude": ["state": "signed_in", "account": "person-a@example.com", "plan": "pro"]]])
        await host.read()
        XCTAssertEqual(subscription(host, "claude")?["state"] as? String, "signed_in")

        made.door.heldAct = "sign_out"
        made.door.holdStarts = true
        let out = Task { try await host.perform(.askLogin(.signOut(.claude))) }
        try await until("the sign-out sent and held") {
            made.door.requests.contains { $0.body == .json(Data(#"{"do":"sign_out","of":"claude"}"#.utf8)) }
        }
        host.stop()
        host.start(polling: { false })
        await host.read()
        XCTAssertEqual(subscription(host, "claude")?["state"] as? String, "signed_in", "the opening's read, before the sign-out ended")
        made.door.then([["claude": ["state": "signed_out"]]])
        made.door.release()
        _ = try? await out.value
        try await until("signed out shown once the sign-out ended") { self.subscription(host, "claude")?["state"] as? String == "signed_out" }
    }

    func testEachOpeningLooksForTheBrowsersAndAppsAgain() async throws {
        let made = try make(Home())
        defer { made.home.stop() }
        let host = made.host
        host.start(polling: { false })
        defer { host.stop() }
        try await until("looked for as the window opened") { made.reads.steps.count == 1 }
        host.stop()
        host.start(polling: { false })
        try await until("looked for again as the window opened again") { made.reads.steps.count == 2 }
    }

    func testASubscriptionInAStateNotAsksIsUnreadable() throws {
        let read = try AskLoginDoor.decode(Data(#"{"chatgpt":{"state":"signed_out"},"claude":{"state":"absent"}}"#.utf8))
        XCTAssertEqual(read.chatgpt.state, .signedOut)
        XCTAssertThrowsError(try AskLoginDoor.decode(Data(#"{"chatgpt":{"state":"paused"},"claude":{"state":"absent"}}"#.utf8))) {
            XCTAssertEqual($0 as? LinkFailure, .unreadable(200))
        }
    }

    func testAStartAnsweredIsTheStateThoughTheDoorsReadsFail() async throws {
        let made = try make(Home())
        defer { made.home.stop() }
        let host = made.host
        made.door.failGets = true
        made.door.then([["claude": ["state": "signing_in", "attempt": "0f3a9c2e7b1d4a60"]]])
        _ = try await host.perform(.askLogin(.start(.claude)))
        XCTAssertEqual(subscription(host, "claude")?["state"] as? String, "signing_in")
        host.stop()
        try await until("the sign-in cancelled as the window closed") {
            made.door.requests.contains { $0.method == "POST" && $0.body == .json(Data(#"{"do":"cancel","of":"claude"}"#.utf8)) }
        }
    }

    func testASignInIsFollowedThroughAFailedRead() async throws {
        let made = try make(Home())
        defer { made.home.stop() }
        let host = made.host
        made.door.then([["claude": ["state": "signing_in", "attempt": "0f3a9c2e7b1d4a60"]]])
        _ = try await host.perform(.askLogin(.start(.claude)))
        made.door.failGets = true
        let before = made.door.gets
        try await until("the follow asked again past a failed read") { made.door.gets > before + 2 }
        made.door.then([["claude": ["state": "signed_in", "account": "person-a@example.com", "plan": "max"]]])
        made.door.failGets = false
        try await until("followed to its end") { self.subscription(host, "claude")?["state"] as? String == "signed_in" }
    }

    func testADownloadUnderWayWhenTheWindowOpensIsFollowed() async throws {
        let made = try make(Home())
        defer { made.home.stop() }
        let host = made.host
        made.door.then([["chatgpt": ["state": "fetching", "bytes": 120_000_000, "total": 347_000_000]],
                        ["chatgpt": ["state": "fetching", "bytes": 300_000_000, "total": 347_000_000]],
                        ["chatgpt": ["state": "signed_out"]]])
        await host.read()
        try await until("the download followed to its end") { self.subscription(host, "chatgpt")?["state"] as? String == "signed_out" }
    }

    func testADoorAwayWhileASignInRunsIsAskedAgainAndTheNextCodeFollowedOnceBack() async throws {
        let made = try make(Home())
        defer { made.home.stop() }
        let host = made.host
        made.door.then([["chatgpt": ["state": "signing_in", "attempt": "login-1", "code": "WXYZ-1234", "url": "https://auth.example.com/device"]]])
        _ = try await host.perform(.askLogin(.start(.chatgpt)))
        made.door.down = true
        let refused = made.door.requests.count
        try await until("the follow asked the door that does not answer, and again") { made.door.requests.count > refused + 1 }
        do {
            _ = try await host.perform(.askLogin(.start(.chatgpt)))
            XCTFail("a start the door never heard answered done")
        } catch let refusal as HostRefusal {
            XCTAssertEqual([refusal.words, refusal.said.rawValue], [HostRefusal(.notSent).words, HostRefusal.Said.notSent.rawValue], "the door away said as other than not sent")
        }
        made.door.down = false
        made.door.then([["chatgpt": ["state": "signing_in", "attempt": "login-2", "code": "ABCD-5678", "url": "https://auth.example.com/device"]],
                        ["chatgpt": ["state": "signing_in", "attempt": "login-2", "code": "ABCD-5678", "url": "https://auth.example.com/device"]],
                        ["chatgpt": ["state": "signed_in", "account": "person-a@example.com"]]])
        _ = try await host.perform(.askLogin(.start(.chatgpt)))
        try await until("the new code followed to its sign-in") { self.subscription(host, "chatgpt")?["state"] as? String == "signed_in" }
    }

    func testAKeyTheHomeDoesNotKeepIsSaidAndStaysShown() async throws {
        let made = try make(Home())
        defer { made.home.stop() }
        let recovery = made.host.needs.recovery
        recovery.board = NSPasteboard(name: NSPasteboard.Name("recovery-\(UUID().uuidString)"))
        defer { recovery.board.releaseGlobally() }
        recovery.later = { _, _ in }
        await made.host.needs.read()
        await recovery.make()
        let shown = try XCTUnwrap(recovery.shown)
        XCTAssertEqual(shown.key, Self.recoveryKey)
        recovery.copy()
        await recovery.confirm()
        let refused = recovery.refusal?.words
        XCTAssertEqual(refused, "that recovery key does not open this vault: nothing was changed", "the home's refusal was not said")
        XCTAssertEqual(recovery.shown, shown, "the key refused left the window")
        made.home.stop()
        await recovery.confirm()
        let silent = recovery.refusal?.words
        XCTAssertEqual(silent, ReachWords.notSent, "a home that did not answer was not said")
        XCTAssertEqual(recovery.shown, shown, "the key the home never heard left the window")
        XCTAssertEqual(lines(made.home).filter { $0 == "vault-confirm" }.count, 1)
        try record("host-v6-vault-refused", ["refused": refused as Any, "silent": silent as Any, "socket": lines(made.home)])
    }

    func testABrowserNotOnThisMacIsSaidAndAnAccountOpensItsSheet() async throws {
        let state = Home()
        let made = try make(state)
        defer { made.home.stop() }
        let host = made.host
        let missing = await refusal { try await host.perform(.open(.browserStore("netscape"))) }
        XCTAssertEqual(missing, "That browser is not on this Mac: install it, then add the extension.")
        XCTAssertNil(host.panel.shown, "the drag panel showed for a browser that is not here")

        await host.needs.read()
        let gmail = Task { try await host.perform(.sheet(.init(connector: "gmail", route: "gmail-imap"))) }
        try await until("if case .account? = host.sheet { return true } else { return false }") { if case .account? = host.sheet { return true } else { return false } }
        host.sheet = nil
        _ = try await gmail.value
    }

    func testTheUnitTurnFoundAndApps() async throws {
        let state = Home()
        let made = try make(state)
        defer { made.home.stop() }
        let host = made.host
        await host.read()
        var shown = try self.state(host)
        XCTAssertEqual(shown["unit"] as? String, "macbook-pro-0001")
        let apps = try XCTUnwrap(shown["apps"] as? [String: Any])
        let offered = try XCTUnwrap(apps["offered"] as? [[String: Any]])
        XCTAssertEqual(offered.map { $0["id"] as? String }, ["com.1password.1password", "com.example.notes-fake", "com.apple.Safari"])
        XCTAssertEqual(offered.map { $0["name"] as? String }, ["1Password", "Notes Fake", "Safari"])
        XCTAssertEqual(offered.map { $0["suggested"] as? Bool }, [true, false, false],
                       "a password manager on this Mac not suggested, or another app suggested")
        XCTAssertNil(shown["never"], "the never list outlived the contract")
        XCTAssertNotNil(apps["private_windows"] as? Bool)
        let own = Detection.App(id: RecordingModes.ownApp, name: "Lifestream", url: URL(fileURLWithPath: "/Applications/Lifestream.app"))
        XCTAssertEqual(HostState.Apps.of(apps: [own], named: [RecordingModes.ownApp]).offered, [], "this app was offered")
        let safari = Detection.App(id: "com.apple.Safari", name: "Safari", url: URL(fileURLWithPath: "/Applications/Safari.app"))
        let firefox = Detection.App(id: "org.mozilla.firefox", name: "Firefox", url: URL(fileURLWithPath: "/Applications/Firefox.app"))
        XCTAssertTrue(HostState.Apps.of(apps: [safari], named: [], language: "en-GB").privateWindows)
        XCTAssertFalse(HostState.Apps.of(apps: [safari, firefox], named: [], language: "en-GB").privateWindows)
        XCTAssertFalse(HostState.Apps.of(apps: [safari], named: [], language: "de-DE").privateWindows)
        let system = Detection.Places(applications: [URL(fileURLWithPath: "/System/Applications")],
                                      support: FileManager.default.temporaryDirectory)
        let calculator = try XCTUnwrap(Detection.apps(system).first { $0.id == "com.apple.calculator" })
        XCTAssertEqual(calculator.icon, "lifestream-app://icon/com.apple.calculator")
        XCTAssertEqual(HostState.Apps.of(apps: [calculator], named: []).offered.map(\.icon), [calculator.icon])
        XCTAssertEqual(HostState.Apps.of(apps: [], named: ["com.apple.Safari"]).offered, [], "an app never found was offered by its id")
        let png = try XCTUnwrap(Detection.iconPNG("com.apple.calculator"))
        XCTAssertEqual(try XCTUnwrap(NSBitmapImageRep(data: png)).pixelsWide, Detection.iconPixels)
        XCTAssertNil(Detection.iconPNG("com.example.not-found"), "the scheme served an app the list never found")
        XCTAssertLessThan(try JSONEncoder().encode(HostState.Apps.of(apps: [calculator], named: [])).count, 200,
                          "the picture is in the state")

        let field: HomeLink.JSON = .array([.object(["app": .string("com.apple.Safari"), "mode": .string("exclude")]),
                                           .object(["site": .string("mybank.example.com"), "mode": .string("exclude")])])
        _ = try await host.perform(.setting(connector: "screen", member: "apps", value: field))
        XCTAssertEqual(made.settings.value("screen", "apps"), field)
        shown = try self.state(host)
        let named = try XCTUnwrap((shown["apps"] as? [String: Any])?["offered"] as? [[String: Any]])
        XCTAssertEqual(named.map { $0["id"] as? String }, ["com.1password.1password", "com.apple.Safari", "com.example.notes-fake"],
                       "the list went stale")
        _ = try await host.perform(.setting(connector: "screen", member: "apps",
                                            value: .array(field.array! + [.object(["site": .string("not a site!"), "mode": .string("exclude")])])))
        XCTAssertEqual(made.settings.value("screen", "apps"), field, "a bad item was kept, or refused the list")
        let bad = await refusal { try await host.perform(.setting(connector: "screen", member: "apps", value: .string("all"))) }
        XCTAssertEqual(bad, "Lifestream cannot use that setting, so nothing was done.")
        XCTAssertEqual(made.settings.value("screen", "apps"), field, "a refused value changed something")
        try await until("made.told.steps.count == 2") { made.told.steps.count == 2 }

        _ = try await host.perform(.turn(sources: ["screen"], on: false))
        XCTAssertTrue(lines(made.home).contains("connectors off screen"))
        XCTAssertEqual(made.told.steps.count, 3)
        _ = try await host.perform(.turn(sources: ["chrome:profile-2:macbook-pro-0001"], on: false))
        XCTAssertTrue(lines(made.home).contains("connectors off chrome:profile-2:macbook-pro-0001"))
        XCTAssertEqual(made.told.steps.count, 4)
        let unknown = await refusal { try await host.perform(.turn(sources: ["fax"], on: false)) }
        XCTAssertEqual(unknown, "fax: not a source name, nor a Streams row's id")

        _ = try await host.perform(.skip(step: "iphone"))
        XCTAssertEqual(made.told.steps.count, 4)
        _ = try await host.perform(.skip(step: "found"))
        XCTAssertEqual(made.told.steps.count, 5)

        try record("host-v6-fix", ["socket": lines(made.home), "told": made.told.steps, "apps": apps])
    }

    private func record(_ name: String, _ fields: [String: Any]) throws {
        try FileManager.default.createDirectory(at: Shots.e2e, withIntermediateDirectories: true)
        let url = Shots.e2e.appendingPathComponent("\(name).json")
        try JSONSerialization.data(withJSONObject: fields, options: [.prettyPrinted, .sortedKeys]).write(to: url)
        print("recorded: \(url.path)")
    }
}
