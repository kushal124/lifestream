import DeviceFiles
import Foundation
import HomeLink
import Passwords
import Recorder
import Shipping
import UserNotifications
import XCTest
@testable import Lifestream

@MainActor final class AgentsTests: XCTestCase {
    final class Home: @unchecked Sendable {
        private let lock = NSLock()
        private var agents: [[String: Any]] = [AgentsTests.claude]

        func answer(_ request: [String: Any]) -> [String: Any] {
            let args = request["args"] as? [String] ?? []
            return lock.withLock {
                switch (request["verb"] as? String, args.first) {
                case ("vault", _): return ["result": ["key_id": "3fa2c91b", "locked": false, "recovery": "confirmed"]]
                case ("agents", "disconnect") where args.count == 3 && args[1] == "--":
                    agents.removeAll { $0["id"] as? String == args[2] }
                    return ["result": [String: Any]()]
                case ("agents", "unlist") where args.count == 3 && args[1] == "--":
                    if let held = agents.first(where: { $0["id"] as? String == args[2] }), let name = held["name"] as? String {
                        let words = "Disconnect \(name) first."
                        return ["error": words, "refusal": ["status": 409, "code": "AGENT_CONNECTED", "words": words, "extra": [String: Any]()]]
                    }
                    return ["result": ["readers": [[String: Any]]()]]
                default: return ["error": "usage: home \(request["verb"] ?? "") \(args.joined(separator: " "))"]
                }
            }
        }
    }

    final class Door: HomeTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var _requests: [[String: Any]] = []
        private var _asks: [[String: Any]] = []
        private var _down = false
        private var _refusing = false
        private var _answers: [Data] = []
        private var _sets: [(agent: String, body: Data)] = []
        private var _versions: [String: Int] = [:]
        private var _replied: [String: HomeResponse] = [:]
        private var _reads = Hold(armed: false)
        private var _contacts = 0
        private var _guided: [(route: String, pass: String?, body: [String: Any]?)] = []

        var requests: [[String: Any]] {
            get { lock.withLock { _requests } }
            set { lock.withLock { _requests = newValue } }
        }
        var asks: [[String: Any]] {
            get { lock.withLock { _asks } }
            set { lock.withLock { _asks = newValue } }
        }
        var down: Bool {
            get { lock.withLock { _down } }
            set { lock.withLock { _down = newValue } }
        }
        var refusing: Bool {
            get { lock.withLock { _refusing } }
            set { lock.withLock { _refusing = newValue } }
        }
        var bodies: [Data] { lock.withLock { _answers } }
        var answers: [[String: Any]] { bodies.map { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] ?? [:] } }
        var sets: [(agent: String, body: [String: Any])] {
            lock.withLock { _sets }.map { ($0.agent, (try? JSONSerialization.jsonObject(with: $0.body)) as? [String: Any] ?? [:]) }
        }
        var contacts: Int { lock.withLock { _contacts } }
        var guided: [(route: String, pass: String?, body: [String: Any]?)] { lock.withLock { _guided } }
        func version(_ agent: String, _ version: Int) { lock.withLock { _versions[agent] = version } }

        func door(reads: Hold = Hold(armed: false)) -> AgentsDoor {
            lock.withLock { _reads = reads }
            return .of(AgentsTests.link(over: self))
        }

        func perform(_ request: HomeRequest) async throws -> HomeResponse {
            let path = request.url.path
            lock.withLock { _contacts += 1 }
            if let file = AgentsTests.guideDoor[request.method + " " + path] {
                var sent: [String: Any]?
                if case .json(let data) = request.body { sent = try JSONSerialization.jsonObject(with: data) as? [String: Any] }
                lock.withLock { _guided.append((request.method + " " + path, request.headers["Authorization"], sent)) }
                let contract = path == "/v1/agents/guides" ? ["status": 200, "answer": AgentsTests.guidesPage] : AgentsTests.guideContract(file)
                return try Self.json(contract["status"] as? Int ?? 0, contract["answer"]!)
            }
            if request.method == "GET", path == "/v1/agents/waiting" {
                let (data, reads) = try lock.withLock { () throws -> (Data, Hold) in
                    if _down { throw URLError(.cannotConnectToHost) }
                    let listed: [String: Any] = ["position": "1:0", "today": "2026-11-14", "requests": _requests.map { $0.filter { $0.key != "number" } }, "asks": _asks]
                    return (try JSONSerialization.data(withJSONObject: listed), _reads)
                }
                await reads.pass()
                return HomeResponse(status: 200, body: data)
            }
            guard request.method == "POST", case .json(let data) = request.body,
                  let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw URLError(.badURL) }
            let parts = path.split(separator: "/").map(String.init)
            return try lock.withLock {
                if _down || _refusing { throw URLError(.cannotConnectToHost) }
                if parts == ["v1", "agents", "answer"] {
                    _answers.append(data)
                    return try answer(body)
                }
                guard parts.count == 4, parts[0] == "v1", parts[1] == "agents", parts[3] == "access" else { throw URLError(.badURL) }
                _sets.append((parts[2], data))
                let now = _versions[parts[2]] ?? 1
                guard body["expect"] as? Int == now else { return try Self.json(409, AgentsTests.contract("access-stale")["answer"]!) }
                _versions[parts[2]] = now + 1
                return try Self.json(200, AgentsTests.contract("access-widened")["answer"]!)
            }
        }

        private func answer(_ body: [String: Any]) throws -> HomeResponse {
            let id = body["id"] as? String
            if let id, let reply = _replied[id] { return reply }
            if let id, let index = _requests.firstIndex(where: { $0["id"] as? String == id }) {
                let request = _requests.remove(at: index)
                let file = body["answer"] as? String == "deny" ? "answer-sign-in-deny"
                    : body["answer"] as? Int == request["number"] as? Int ? "answer-sign-in" : "answer-sign-in-wrong"
                let reply = try Self.json(200, AgentsTests.contract(file)["answer"]!)
                _replied[id] = reply
                return reply
            }
            if let index = _asks.firstIndex(where: { $0["id"] as? String == id }) {
                let version = _asks[index]["version"] as? Int ?? 0
                if body["answer"] as? String != "no", body["expect"] as? Int != version {
                    return try Self.json(409, AgentsTests.contract("answer-stale")["answer"]!)
                }
                _asks.remove(at: index)
                let (file, now) = body["answer"] as? String == "no" ? ("answer-no", version) : ("answer-always", version + 1)
                return try Self.json(200, (AgentsTests.contract(file)["answer"] as! [String: Any]).merging(["version": now]) { $1 })
            }
            return try Self.json(404, AgentsTests.contract("answer-unknown")["answer"]!)
        }

        static func json(_ status: Int, _ object: Any) throws -> HomeResponse {
            HomeResponse(status: status, body: try JSONSerialization.data(withJSONObject: object))
        }
    }

    final class Stored: Credentials, @unchecked Sendable {
        private var data: Data?
        init(_ data: Data?) { self.data = data }
        func read() throws -> Data? { data }
        func write(_ data: Data) throws { self.data = data }
        func delete() throws { data = nil }
    }

    nonisolated static func link(over door: HomeTransport, paired: Bool = true) -> HomeLink {
        let stored = paired ? try? JSONSerialization.data(withJSONObject: ["name": "http://127.0.0.1:4680", "pass": "fake-pass-000000000000",
                                                                           "paired": true, "unit": "macbook-pro-0001"]) : nil
        return HomeLink(device: .init(kind: .mac, version: "0.9.0", model: "Mac15,3", serial4: nil), credentials: Stored(stored),
                        folder: FileManager.default.temporaryDirectory.appendingPathComponent("agents-link-\(UUID().uuidString)"),
                        transport: door, files: DeviceFiles(.plain))
    }

    nonisolated static let contracts = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/agents/door")

    nonisolated static func contract(_ name: String) -> [String: Any] {
        guard let data = try? Data(contentsOf: contracts.appendingPathComponent(name + ".json")),
              let file = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            fatalError("no contract file \(name).json")
        }
        return file
    }

    nonisolated static let guideDoor = ["GET /v1/agents/guides": "", "GET /v1/agents/address": "address-fix-mac",
                                        "POST /v1/agents/address": "address-on", "POST /v1/agents/keys": "keys-grok-bot",
                                        "GET /v1/agents/signins/" + (first["id"] as! String): "signin-connected"]

    nonisolated static func guideContract(_ name: String) -> [String: Any] {
        contract("../guide-door/" + name)
    }

    nonisolated(unsafe) static let guidesPage: Any = {
        let url = contracts.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("pages/agentGuides.mac.json")
        return try! JSONSerialization.jsonObject(with: Data(contentsOf: url))
    }()

    nonisolated static let end: Int64 = 4_102_444_800_000

    nonisolated(unsafe) static let ask: [String: Any] = waitingAsk(1).merging([
        "id": "q-0000aa01", "name": "Instinct", "head": "Instinct asks for all of WhatsApp for 1 hour.", "until_ms": end,
        "reason": "Person 1 moved\nSaturday's dinner in a chat. I need the new time.",
    ]) { $1 }
    nonisolated(unsafe) static let chatAsk: [String: Any] = waitingAsk(0).merging(["id": "q-0000aa02", "until_ms": end]) { $1 }
    nonisolated(unsafe) static let screenAsk: [String: Any] = (contract("ask-open")["answer"] as! [String: Any]).merging([
        "id": "q-0000aa03", "name": "Claude", "head": "Claude asks for your work Gmail for 1 hour.", "until_ms": end,
        "screen": "Whatever was on your screen, so close to everything.",
    ]) { $1 }

    nonisolated static func waitingAsk(_ index: Int) -> [String: Any] {
        ((contract("waiting")["answer"] as! [String: Any])["asks"] as! [[String: Any]])[index]
    }

    nonisolated(unsafe) static let claude: [String: Any] = ["id": "p-0000aa01", "name": "Claude"]
    nonisolated(unsafe) static let first: [String: Any] = waitingSignIn.merging(["id": "-Rq7xQ2bAAAAAAAAAAAAAA", "choices": [42, 17, 88],
                                                                                 "until_ms": end, "number": 42]) { $1 }
    nonisolated(unsafe) static let second: [String: Any] = waitingSignIn.merging(["id": "Zx0y1W2vAAAAAAAAAAAAAA", "name": "Some App", "head": "Some App wants to read your Lifestream",
                                                                                  "notice": "Some App wants to read your Lifestream. Pick the number it shows.",
                                                                                  "app": NSNull(), "checked": false, "host": NSNull(), "choices": [23, 61, 35],
                                                                                  "at_ms": (waitingSignIn["at_ms"] as! NSNumber).int64Value + 1_000,
                                                                                  "until_ms": end, "number": 61]) { $1 }
    nonisolated static let guidePage = "view=agents&dialog=agents:connect/guide:claude"
    nonisolated static var signInPage: String { "view=agents&dialog=signin:" + (second["id"] as! String) }
    nonisolated(unsafe) static let waitingSignIn = ((contract("waiting-sign-in")["answer"] as! [String: Any])["requests"] as! [[String: Any]])[0]
    nonisolated static var signInAccess: HomeLink.Access {
        try! JSONDecoder().decode(HomeLink.Access.self, from: JSONSerialization.data(withJSONObject: waitingSignIn["access"]!))
    }
    nonisolated static var sentence: String { waitingSignIn["sentence"] as! String }

    final class Posted {
        var posts: [UNNotificationRequest] = []
        var withdrawn = 0
        var standing = false
        var asksWithdrawn: [String] = []

        func withdraw(_ identifiers: [String]) {
            for identifier in identifiers {
                if identifier == AgentRequests.notification {
                    withdrawn += 1
                    standing = false
                } else {
                    asksWithdrawn.append(identifier)
                }
            }
        }
    }

    final class Hold: @unchecked Sendable {
        private let lock = NSLock()
        private var armed: Bool
        private var held: [CheckedContinuation<Void, Never>] = []
        private var count = 0

        init(armed: Bool = true) { self.armed = armed }

        var arrived: Int { lock.withLock { count } }

        func arm() { lock.withLock { armed = true } }

        func pass() async {
            await withCheckedContinuation { (going: CheckedContinuation<Void, Never>) in
                lock.lock()
                guard armed else {
                    lock.unlock()
                    return going.resume()
                }
                count += 1
                held.append(going)
                lock.unlock()
            }
        }

        func open() {
            let going = lock.withLock {
                armed = false
                defer { held = [] }
                return held
            }
            going.forEach { $0.resume() }
        }
    }

    private func requests(over door: Door, posted: Posted, now: @escaping () -> Date = Date.init,
                          reads: Hold = Hold(armed: false), permit: @escaping @MainActor () async -> Bool = { true },
                          delivery: Hold = Hold(armed: false)) -> AgentRequests {
        AgentRequests(door: door.door(reads: reads), permit: permit, deliver: {
            await delivery.pass()
            posted.posts.append($0)
            if $0.identifier == AgentRequests.notification { posted.standing = true }
        }, withdraw: { posted.withdraw($0) }, now: now)
    }

    private func host(over home: ScriptedHome, waiting: AgentRequests) -> MacHost {
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { socket })
        return MacHost(needs: NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper)),
                       lines: StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true)),
                       socket: { socket }, readGrants: { [:] }, readFolder: { nil }, ask: .untouched, agentRequests: waiting)
    }

    private func asked(_ home: ScriptedHome, from: Int = 0) -> [String] {
        home.requests.dropFirst(from).compactMap { request in
            guard request["verb"] as? String == "agents" else { return nil }
            return (["agents"] + (request["args"] as? [String] ?? [])).joined(separator: " ")
        }
    }

    private func page(_ host: MacHost) throws -> [String: Any] {
        let text = try HostBridge.scriptLiteral(host.state)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    func testTwoRequestsPostOneNotificationAndNoneWaitingTakesItBack() async throws {
        let door = Door()
        let posted = Posted()
        var now = Date()
        let waiting = requests(over: door, posted: posted, now: { now })

        door.requests = [Self.first, Self.second]
        await waiting.look()
        XCTAssertEqual(waiting.waiting.map(\.id), [Self.first["id"] as? String, Self.second["id"] as? String])
        try await until("one notification posted") { posted.posts.count == 1 }
        let note = posted.posts[0]
        XCTAssertEqual(note.identifier, AgentRequests.notification)
        XCTAssertEqual(note.content.title, "Lifestream")
        XCTAssertEqual(note.content.body, Self.second["notice"] as? String, "not the home's notice of the newest sign-in waiting")
        XCTAssertEqual(AgentRequests.page(of: note.content), Self.signInPage, "a sign-in of no guide's app opens other than its own dialog")

        await waiting.look()
        door.requests = [Self.second]
        await waiting.look()
        XCTAssertEqual(waiting.waiting.map(\.id), [Self.second["id"] as? String])
        let third = Self.first.merging(["id": "Third0AAAAAAAAAAAAAAAA"]) { $1 }
        door.requests = [Self.second, third]
        await waiting.look()
        try await until("a second notification posted") { posted.posts.count == 2 }
        XCTAssertEqual(Set(posted.posts.map(\.identifier)), [AgentRequests.notification])
        XCTAssertEqual(posted.posts[1].content.body, Self.first["notice"] as? String, "the notice of a sign-in no longer new")
        XCTAssertEqual(AgentRequests.page(of: posted.posts[1].content), Self.guidePage, "a sign-in of a guide's app opens other than its guide")
        XCTAssertEqual(posted.withdrawn, 0)

        waiting.inFront = { true }
        door.requests = [Self.second, third, Self.first]
        await waiting.look()
        XCTAssertEqual(waiting.waiting.count, 3)
        XCTAssertEqual(posted.posts.count, 2, "a notification was posted over the window in front")

        door.down = true
        await waiting.look()
        XCTAssertEqual(waiting.waiting.count, 3, "a home restarting a moment emptied the cards")
        now = Date(timeIntervalSince1970: 4_102_444_800)
        await waiting.look()
        XCTAssertEqual(waiting.waiting.count, 0)
        XCTAssertEqual(posted.withdrawn, 1, "the notification stood once none waited")
    }

    func testACardIsDrawnItsPickSentAndItGoesWithTheList() async throws {
        let state = Home()
        let home = try ScriptedHome(state.answer)
        defer { home.stop() }
        let door = Door()
        let posted = Posted()
        let waiting = requests(over: door, posted: posted)
        let host = host(over: home, waiting: waiting)

        door.requests = [Self.first, Self.second]
        await waiting.look()
        let drawn = try XCTUnwrap(try page(host)["agent_requests"] as? [[String: Any]])
        XCTAssertEqual(drawn.count, 2)
        XCTAssertEqual(drawn[0]["id"] as? String, Self.first["id"] as? String)
        XCTAssertEqual(drawn[0]["name"] as? String, "Claude")
        XCTAssertEqual(drawn[0]["checked"] as? Bool, true)
        XCTAssertEqual(drawn[0]["host"] as? String, "claude.ai")
        XCTAssertEqual(drawn[0]["choices"] as? [Int], [42, 17, 88])
        XCTAssertEqual(drawn[0]["until_ms"] as? Int64, 4_102_444_800_000)
        XCTAssertTrue(drawn[1]["host"] is NSNull, "an app on this computer's host not written as null")
        XCTAssertNil(drawn[0]["number"], "the page's number reached the Mac")
        XCTAssertEqual(drawn[0]["sentence"] as? String, Self.sentence)
        XCTAssertEqual(drawn[0]["access"] as? NSDictionary, Self.first["access"] as? NSDictionary, "the sign-in's access lost on the way")
        XCTAssertEqual(try page(host)["agent_asks"] as? NSArray, [], "requests drawn while none waits, or the list left out")

        let before = home.requests.count
        let approved = try await host.perform(.agentAnswer(.number(Self.first["id"] as! String, 42)))
        XCTAssertNil(approved)
        XCTAssertEqual(door.answers.count, 1)
        XCTAssertEqual(door.answers[0]["id"] as? String, Self.first["id"] as? String)
        XCTAssertEqual(door.answers[0]["answer"] as? Int, 42)
        XCTAssertEqual(Set(door.answers[0].keys), ["id", "answer"])
        XCTAssertEqual(asked(home, from: before), [])
        XCTAssertEqual(host.state.agentRequests.map(\.id), (Self.second["id"] as? String).map { [$0] }, "the card stood after its pick")

        let wrong = try await host.reply(.agentAnswer(.number(Self.second["id"] as! String, 23)))
        XCTAssertEqual(wrong as NSDictionary, ["answer": Self.contract("answer-sign-in-wrong")["answer"]!] as NSDictionary,
                       "the reply is not the door's")
        XCTAssertEqual(host.state.agentRequests, [])

        let third = Self.first.merging(["id": "Third0AAAAAAAAAAAAAAAA"]) { $1 }
        door.requests = [third]
        await waiting.look()
        XCTAssertEqual(host.state.agentRequests.count, 1)
        door.requests = []
        do {
            _ = try await host.perform(.agentAnswer(.deny(third["id"] as! String)))
            XCTFail("a pick on a request gone was taken")
        } catch {
            XCTAssertEqual((error as? HostRefusal)?.words, Self.message("answer-unknown"), "not the door's words")
        }
        XCTAssertEqual(host.state.agentRequests, [])

        door.requests = [Self.second]
        await waiting.look()
        XCTAssertEqual(host.state.agentRequests.count, 1)
        door.requests = []
        await waiting.look()
        XCTAssertEqual(try page(host)["agent_requests"] as? NSArray, [], "the card stood once the home's list dropped it")
    }

    func testDisconnectAndUnlistAskTheHomeTheirVerbAloneAndTheWindowHoldsNoAgents() async throws {
        let home = try ScriptedHome(Home().answer)
        defer { home.stop() }
        let host = host(over: home, waiting: requests(over: Door(), posted: Posted()))
        XCTAssertNil(try page(host)["agents"], "the window's state carries agents the page reads from the door")

        var from = home.requests.count
        _ = try await host.reply(.agentDisconnect(id: "p-0000ab01"))
        XCTAssertEqual(asked(home, from: from), ["agents disconnect -- p-0000ab01"])

        from = home.requests.count
        _ = try await host.reply(.agentUnlist(id: "p-0000ab01"))
        XCTAssertEqual(asked(home, from: from), ["agents unlist -- p-0000ab01"])
        do {
            _ = try await host.perform(.agentUnlist(id: "p-0000aa01"))
            XCTFail("a connected agent left the list")
        } catch {
            XCTAssertEqual((error as? HostRefusal)?.words, "Disconnect Claude first.", "not the home's words")
        }
        XCTAssertNil(try page(host)["agents"])
    }

    func testTheGuidesReadAndWriteThroughTheMacsOwnPassAndTheirAnswersReachThePageAsTheHomeSaidThem() async throws {
        let home = try ScriptedHome(Home().answer)
        defer { home.stop() }
        let door = Door()
        let host = host(over: home, waiting: requests(over: door, posted: Posted()))
        let first = Self.first["id"] as! String
        func act(_ body: [String: Any]) throws -> HostAct { try HostAct.read(["type": "act"].merging(body) { $1 }).get() }
        func said(_ value: Any?) throws -> NSDictionary { try XCTUnwrap((try JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: value as Any))) as? NSDictionary) }

        let guides = try await host.reply(try act(["act": "agent-guides"]))
        XCTAssertEqual(try said(guides["answer"]), try said(Self.guidesPage), "not the home's page, whole")
        let read = try await host.reply(try act(["act": "agent-address"]))
        XCTAssertEqual(try said(read["answer"]), try said(Self.guideContract("address-fix-mac")["answer"]))
        let on = try await host.reply(try act(["act": "agent-address", "on": kCFBooleanTrue as Any]))
        XCTAssertEqual(try said(on["answer"]), try said(Self.guideContract("address-on")["answer"]))
        let key = Self.guideContract("keys-grok-bot")
        let made = try await host.reply(try act(["act": "agent-key"].merging(key["request"] as! [String: Any]) { $1 }))
        XCTAssertEqual(try said(made["answer"]), try said(key["answer"]))
        let signIn = try await host.reply(try act(["act": "agent-signin", "id": first]))
        XCTAssertEqual((try said(signIn["answer"]))["state"] as? String, "approved")

        XCTAssertEqual(door.guided.map(\.route), ["GET /v1/agents/guides", "GET /v1/agents/address", "POST /v1/agents/address",
                                                 "POST /v1/agents/keys", "GET /v1/agents/signins/" + first])
        XCTAssertEqual(Set(door.guided.map(\.pass)), ["Bearer fake-pass-000000000000"], "not the Mac's own pass")
        XCTAssertEqual(door.guided[2].body as NSDictionary?, ["on": true])
        XCTAssertEqual(door.guided[3].body as NSDictionary?, key["request"] as? NSDictionary)

        XCTAssertEqual(HostAct.read(["type": "act", "act": "agent-address", "reader": "p-00000001"]), .failure(.badRequest(nil)))
        XCTAssertEqual(HostAct.read(["type": "act", "act": "agent-address", "on": kCFBooleanFalse as Any]), .failure(.badRequest(nil)))
        XCTAssertEqual(HostAct.read(["type": "act", "act": "agent-key", "app": "terminal", "access": [String: Any]()]), .failure(.badRequest(nil)))
        XCTAssertEqual(HostAct.read(["type": "act", "act": "agent-guides", "open": true]), .failure(.badRequest(nil)))
    }

    func testTheGuidesOwnNoActOnTheMacButOpeningMessages() {
        func act(_ body: [String: Any]) -> Result<HostAct, HostRefusal> { HostAct.read(["type": "act"].merging(body) { $1 }) }
        XCTAssertEqual(act(["act": "agents-look", "open": kCFBooleanTrue as Any]), .failure(.update(nil)))
        XCTAssertEqual(act(["act": "open", "what": "app", "app": "Tailscale"]), .success(.open(.app(.tailscale))))
        XCTAssertEqual(act(["act": "open", "what": "app", "app": "Messages"]), .success(.open(.app(.messages))))
        for odd: Any in ["Terminal", "tailscale", "messages", "/Applications/Tailscale.app", "/System/Applications/Messages.app", 1] {
            XCTAssertEqual(act(["act": "open", "what": "app", "app": odd]), .failure(.unreadable(nil)), "\(odd)")
        }
        XCTAssertEqual(act(["act": "open", "what": "app"]), .failure(.unreadable(nil)))
    }

    func testANotificationOpensTheGuideOfItsAppOrElseItsOwnSignIn() async throws {
        let door = Door()
        let posted = Posted()
        let waiting = requests(over: door, posted: posted)

        door.requests = [Self.first]
        await waiting.look()
        try await until("the guide's sign-in notified") { posted.posts.count == 1 }
        let guide = posted.posts[0].content
        XCTAssertEqual(guide.title, "Lifestream")
        XCTAssertEqual(guide.body, Self.first["notice"] as? String)
        let toGuide = DashboardAddress().root(hash: try XCTUnwrap(AgentRequests.page(of: guide)))
        XCTAssertEqual(DashboardAddress.view(of: toGuide), "agents")
        XCTAssertEqual(DashboardAddress.dialog(of: toGuide), "agents:connect/guide:claude", "not Connect an agent pushed to Claude's guide")

        door.requests = [Self.first, Self.second]
        await waiting.look()
        try await until("the other sign-in notified") { posted.posts.count == 2 }
        let own = posted.posts[1].content
        XCTAssertEqual(own.body, Self.second["notice"] as? String)
        let toSignIn = DashboardAddress().root(hash: try XCTUnwrap(AgentRequests.page(of: own)))
        XCTAssertEqual(DashboardAddress.view(of: toSignIn), "agents")
        XCTAssertEqual(DashboardAddress.dialog(of: toSignIn), "signin:" + (Self.second["id"] as! String), "a sign-in of no app opens other than its own dialog")

        door.asks = [Self.ask]
        await waiting.look()
        try await until("the ask notified") { posted.posts.count == 3 }
        XCTAssertNil(AgentRequests.page(of: posted.posts[2].content), "an ask's notification names a page")
    }

    func testAReadInFlightAcrossAnAnswerNeverBringsItsCardBack() async throws {
        let state = Home()
        let home = try ScriptedHome(state.answer)
        defer { home.stop() }
        let door = Door()
        let posted = Posted()
        let reads = Hold(armed: false)
        let waiting = requests(over: door, posted: posted, reads: reads)
        let host = host(over: home, waiting: waiting)
        let second = Self.second["id"] as! String

        door.requests = [Self.first, Self.second]
        await waiting.look()
        try await until("the two notified once") { posted.posts.count == 1 }

        reads.arm()
        let stale = Task { await waiting.look() }
        try await until("a read in flight") { reads.arrived == 1 }
        let approved = try await host.perform(.agentAnswer(.number(Self.first["id"] as! String, 42)))
        XCTAssertNil(approved)
        XCTAssertEqual(waiting.waiting.map(\.id), [second])
        reads.open()
        await stale.value
        XCTAssertEqual(waiting.waiting.map(\.id), [second], "a read older than the answer brought its card back")
        XCTAssertEqual(host.state.agentRequests.map(\.id), [second])

        XCTAssertEqual(door.answers.map { $0["answer"] as? Int }, [42])

        door.requests = [Self.first, Self.second]
        await waiting.look()
        XCTAssertEqual(waiting.waiting.map(\.id), [second], "a request answered here came back")
        door.requests = [Self.second]
        await waiting.look()
        XCTAssertEqual(posted.posts.count, 1, "a request answered here was notified again")

        door.refusing = true
        do {
            _ = try await host.perform(.agentAnswer(.deny(Self.second["id"] as! String)))
            XCTFail("a pick that reached no home was taken")
        } catch {}
        XCTAssertEqual(host.state.agentRequests.map(\.id), [second], "the card went with no answer")
    }

    func testTheNotificationWaitsOnPermissionAndPostsOnlyWhileItsRequestWaits() async throws {
        let door = Door()
        let posted = Posted()
        var now = Date()
        let permission = Hold()
        var asked = 0, answered = 0
        let delivery = Hold(armed: false)
        let waiting = requests(over: door, posted: posted, now: { now }, permit: {
            asked += 1
            await permission.pass()
            answered += 1
            return true
        }, delivery: delivery)

        door.requests = [Self.first]
        await waiting.look()
        try await until("macOS asked") { permission.arrived == 1 }
        door.requests = [Self.first, Self.second]
        await waiting.look()
        XCTAssertEqual(asked, 1, "a second ask ran beside the first")
        door.down = true
        now = Date(timeIntervalSince1970: 4_102_444_800)
        await waiting.look()
        XCTAssertEqual(posted.withdrawn, 1)
        permission.open()
        try await until("macOS answered") { answered == 1 }
        XCTAssertEqual(posted.posts.count, 0, "a notification posted for requests that had ended")

        door.down = false
        now = Date()
        let here = requests(over: door, posted: posted, now: { now }, permit: {
            asked += 1
            await permission.pass()
            answered += 1
            return true
        }, delivery: delivery)
        permission.arm()
        door.requests = [Self.first]
        await here.look()
        try await until("macOS asked again") { permission.arrived == 2 }
        here.answered(Self.first["id"] as! String)
        XCTAssertEqual(posted.withdrawn, 2)
        permission.open()
        try await until("macOS answered again") { answered == 2 }
        XCTAssertEqual(posted.posts.count, 0, "a notification posted for a request answered here")

        permission.arm()
        door.requests = [Self.second]
        await here.look()
        try await until("macOS asked a third time") { permission.arrived == 3 }
        here.inFront = { true }
        permission.open()
        try await until("macOS answered a third time") { answered == 3 }
        XCTAssertEqual(posted.posts.count, 0, "a notification posted over the window in front")
        here.inFront = { false }

        let third = Self.first.merging(["id": "Third0AAAAAAAAAAAAAAAA"]) { $1 }
        door.requests = [Self.second, third]
        await here.look()
        try await until("posted") { posted.posts.count == 1 }
        XCTAssertEqual(posted.posts[0].content.title, "Lifestream")
        XCTAssertEqual(posted.posts[0].content.body, third["notice"] as? String, "not the notice of the sign-in that arrived")

        delivery.arm()
        let fourth = Self.first.merging(["id": "Fourth0AAAAAAAAAAAAAAA"]) { $1 }
        door.requests = [Self.second, third, fourth]
        await here.look()
        try await until("a notification on its way") { delivery.arrived == 1 }
        door.requests = []
        await here.look()
        XCTAssertEqual(posted.withdrawn, 3)
        delivery.open()
        try await until("the late one landed") { posted.posts.count == 2 }
        try await until("and was taken back") { posted.withdrawn == 4 }
    }

    func testANotificationCancelledAsItLandsLeavesALaterOneStanding() async throws {
        let door = Door()
        let posted = Posted()
        let first = Hold(), fifth = Hold()
        var deliveries = 0
        let waiting = AgentRequests(door: door.door(), permit: { true }, deliver: {
            deliveries += 1
            if deliveries == 1 { await first.pass() }
            if deliveries == 3 { await fifth.pass() }
            posted.posts.append($0)
            posted.standing = true
        }, withdraw: { posted.withdraw($0) })

        door.requests = [Self.first]
        await waiting.look()
        try await until("A's post held on its way") { first.arrived == 1 }
        door.requests = []
        await waiting.look()
        XCTAssertEqual(posted.withdrawn, 1)

        door.requests = [Self.second]
        await waiting.look()
        try await until("B posted") { posted.posts.count == 1 }
        XCTAssertTrue(posted.standing)

        first.open()
        try await until("A landed") { posted.posts.count == 2 }
        XCTAssertEqual(posted.withdrawn, 1, "a task cancelled took back the notification a later one posted")
        XCTAssertTrue(posted.standing, "B's notification is gone while its request waits")
        XCTAssertEqual(waiting.waiting.map(\.id), [Self.second["id"] as? String])

        door.requests = []
        await waiting.look()
        XCTAssertEqual(posted.withdrawn, 2)
        XCTAssertFalse(posted.standing)

        door.requests = [Self.first.merging(["id": "Third0AAAAAAAAAAAAAAAA"]) { $1 }]
        await waiting.look()
        try await until("the third post held on its way") { fifth.arrived == 1 }
        door.requests = []
        await waiting.look()
        door.requests = [Self.first.merging(["id": "Fourth0AAAAAAAAAAAAAAA"]) { $1 }]
        await waiting.look()
        try await until("the fourth posted") { posted.posts.count == 3 }
        door.requests = []
        await waiting.look()
        XCTAssertEqual(posted.withdrawn, 4)
        fifth.open()
        try await until("the third landed") { posted.posts.count == 4 }
        XCTAssertEqual(posted.withdrawn, 5, "a task cancelled left its notification standing with none waiting")
        XCTAssertFalse(posted.standing)
        await waiting.look()
        XCTAssertFalse(posted.standing)
    }
    func testARequestIsDrawnNotifiedOnceAndTakenBackAsItLeaves() async throws {
        let door = Door()
        let posted = Posted()
        var now = Date()
        let waiting = requests(over: door, posted: posted, now: { now })
        let state = Home()
        let home = try ScriptedHome(state.answer)
        defer { home.stop() }
        let host = host(over: home, waiting: waiting)

        door.asks = [Self.ask, Self.chatAsk]
        await waiting.look()
        let drawn = try XCTUnwrap(try page(host)["agent_asks"] as? [[String: Any]])
        XCTAssertEqual(drawn.count, 2)
        XCTAssertEqual(try page(host)["agent_requests"] as? NSArray, [], "a sign-in drawn while none waits, or the list left out")
        XCTAssertEqual(drawn[0] as NSDictionary, Self.ask as NSDictionary, "the card is not the ask the door sent, whole")
        XCTAssertEqual(drawn[1] as NSDictionary, Self.chatAsk as NSDictionary, "Chat's ask is not the one the door sent, whole")
        XCTAssertEqual(drawn[0]["head"] as? String, "Instinct asks for all of WhatsApp for 1 hour.")
        XCTAssertEqual(drawn[0]["under"] as? String, Self.ask["under"] as? String)
        XCTAssertTrue(drawn[0]["screen"] is NSNull)
        XCTAssertEqual(drawn[0]["reason"] as? String, Self.ask["reason"] as? String, "the agent's words altered on the way")
        XCTAssertEqual((drawn[0]["choices"] as? [[String: Any]])?.map { $0["words"] as? String }, ["Allow for 1 hour", "Always allow", "Don\u{2019}t allow"])
        XCTAssertEqual(drawn[0]["default"] as? String, "once")
        XCTAssertEqual(drawn[0]["until_ms"] as? Int64, 4_102_444_800_000)
        XCTAssertNotNil(drawn[0]["proposed"] as? [String: Any], "the card lost where Change starts")
        XCTAssertEqual(drawn[1]["by"] as? String, "chat")
        XCTAssertTrue(drawn[1]["reason"] is NSNull)

        try await until("the request notified") { posted.posts.count == 1 }
        let note = posted.posts[0]
        XCTAssertEqual(note.identifier, "agent-ask.q-0000aa01")
        XCTAssertEqual(note.content.title, "Instinct asks for all of WhatsApp for 1 hour")
        XCTAssertEqual(note.content.body, "\u{201C}Person 1 moved Saturday's dinner in a chat. I need the new time.\u{201D}")
        XCTAssertEqual(note.content.categoryIdentifier, "", "a notification with buttons")
        XCTAssertTrue(AgentRequests.opens(note.identifier))
        XCTAssertTrue(AgentRequests.opens(AgentRequests.notification))
        XCTAssertFalse(AgentRequests.opens("need.vault"))

        await waiting.look()
        door.asks = [Self.ask.merging(["head": "Instinct asks for all of WhatsApp for 2 hours."]) { $1 }, Self.chatAsk]
        await waiting.look()
        XCTAssertEqual(host.state.agentAsks.first?.head, "Instinct asks for all of WhatsApp for 2 hours.")
        XCTAssertEqual(posted.posts.count, 1, "two notifications for one ask")
        door.asks = [Self.ask, Self.chatAsk, Self.screenAsk]
        await waiting.look()
        try await until("the second request notified") { posted.posts.count == 2 }
        XCTAssertEqual(posted.posts[1].identifier, "agent-ask.q-0000aa03")
        XCTAssertEqual(posted.posts[1].content.title, "Claude asks for your work Gmail for 1 hour")
        XCTAssertEqual(posted.asksWithdrawn, [])

        door.asks = [Self.chatAsk, Self.screenAsk]
        await waiting.look()
        XCTAssertEqual(host.state.agentAsks.map(\.id), ["q-0000aa02", "q-0000aa03"])
        XCTAssertEqual(posted.asksWithdrawn, ["agent-ask.q-0000aa01"])

        door.down = true
        await waiting.look()
        XCTAssertEqual(host.state.agentAsks.count, 2, "a door restarting a moment emptied the cards")
        now = Date(timeIntervalSince1970: 4_102_444_800)
        await waiting.look()
        XCTAssertEqual(host.state.agentAsks, [])
        XCTAssertEqual(posted.asksWithdrawn, ["agent-ask.q-0000aa01", "agent-ask.q-0000aa03"])
        XCTAssertEqual(posted.withdrawn, 0, "the sign-ins' notification taken back for a request")

        door.down = false
        now = Date()
        waiting.inFront = { true }
        door.asks = [Self.ask.merging(["id": "q-0000aa04"]) { $1 }]
        await waiting.look()
        XCTAssertEqual(host.state.agentAsks.count, 1)
        XCTAssertEqual(posted.posts.count, 2, "a notification posted over the window in front")

        door.asks = []
        await waiting.look()
        XCTAssertEqual(host.state.agentAsks, [], "an ask the home left out, as it leaves out one that ended, drawn as a card")
    }

    func testAListOutOfShapeIsNotTakenAndAnUnpairedMacSendsNothing() async throws {
        let door = Door()
        let waiting = requests(over: door, posted: Posted())
        door.asks = [Self.ask]
        await waiting.look()
        XCTAssertEqual(waiting.asks.count, 1)
        let odd = Self.ask.merging(["id": "q-0000aa09"]) { $1 }
        for each: [String: Any] in [odd.merging(["by": "model"]) { $1 }, odd.merging(["state": "maybe"]) { $1 },
                                    odd.merging(["head": NSNull()]) { $1 }, odd.filter { $0.key != "proposed" },
                                    odd.filter { $0.key != "under" }, odd.merging(["choices": [["answer": "later", "words": "Later"]]]) { $1 }] {
            door.asks = [each]
            await waiting.look()
            XCTAssertEqual(waiting.asks.map(\.id), ["q-0000aa01"], "\(each)")
        }

        let unpaired = AgentRequests(door: .of(Self.link(over: door, paired: false)), permit: { true }, deliver: { _ in }, withdraw: { _ in })
        let before = door.contacts
        await unpaired.look()
        XCTAssertEqual(unpaired.asks.count + unpaired.waiting.count, 0)
        XCTAssertEqual(door.contacts, before, "an unpaired Mac asked a door")
    }

    func testAnAnswerIsTheDoorsAnswerRequestAndTheCardGoes() async throws {
        let state = Home()
        let home = try ScriptedHome(state.answer)
        defer { home.stop() }
        let door = Door()
        let posted = Posted()
        let waiting = requests(over: door, posted: posted)
        let host = host(over: home, waiting: waiting)

        door.requests = [Self.first]
        door.asks = [Self.ask, Self.screenAsk, Self.ask.merging(["id": "q-0000aa07", "version": 4]) { $1 }]
        await waiting.look()
        let approved = try await host.perform(.agentAnswer(.number(Self.first["id"] as! String, 42, access: Self.signInAccess)))
        XCTAssertNil(approved)
        XCTAssertEqual(door.answers.last as NSDictionary?,
                       ["id": Self.first["id"]!, "answer": 42, "access": Self.first["access"]!] as NSDictionary)
        XCTAssertEqual(host.state.agentRequests, [])

        let ask = try XCTUnwrap(host.state.agentAsks.first)
        let allowed = try await host.perform(.agentAnswer(.allow(ask.id, .once, expect: ask.version)))
        XCTAssertNil(allowed)
        XCTAssertEqual(door.answers.last as NSDictionary?, ["id": "q-0000aa01", "answer": "once", "expect": ask.version] as NSDictionary,
                       "an allow sent without its expect")
        XCTAssertEqual(host.state.agentAsks.map(\.id), ["q-0000aa03", "q-0000aa07"])

        let edited = try XCTUnwrap(host.state.agentAsks.last)
        _ = try await host.perform(.agentAnswer(.allow(edited.id, .always, expect: 4, access: edited.proposed)))
        XCTAssertEqual(door.answers.last as NSDictionary?,
                       ["id": "q-0000aa07", "answer": "always", "expect": 4, "access": Self.ask["proposed"]!] as NSDictionary)

        _ = try await host.perform(.agentAnswer(.no("q-0000aa03")))
        XCTAssertEqual(door.answers.last as NSDictionary?, ["id": "q-0000aa03", "answer": "no"] as NSDictionary)
        XCTAssertEqual(host.state.agentAsks, [])

        door.asks = [Self.ask.merging(["id": "q-0000aa05"]) { $1 }]
        await waiting.look()
        XCTAssertEqual(host.state.agentAsks.map(\.id), ["q-0000aa05"])
        door.asks = []
        do {
            _ = try await host.perform(.agentAnswer(.allow("q-0000aa05", .always, expect: 1)))
            XCTFail("an answer on an ask gone was taken")
        } catch {
            XCTAssertEqual((error as? HostRefusal)?.words, Self.message("answer-unknown"))
        }
        XCTAssertEqual(host.state.agentAsks, [])

        door.asks = [Self.ask.merging(["id": "q-0000aa08", "version": 6]) { $1 }]
        await waiting.look()
        do {
            _ = try await host.perform(.agentAnswer(.allow("q-0000aa08", .once, expect: 5)))
            XCTFail("an allow from another version was taken")
        } catch {
            XCTAssertEqual((error as? HostRefusal)?.words, Self.message("answer-stale"))
        }
        XCTAssertEqual(host.state.agentAsks.map(\.id), ["q-0000aa08"])
        let stale = try await host.reply(.agentAnswer(.allow("q-0000aa08", .once, expect: 5)))
        XCTAssertEqual(stale as NSDictionary, ["refused": Self.contract("answer-stale")["answer"]!] as NSDictionary,
                       "the act's reply is not the door's refusal, unchanged")

        door.asks = [Self.ask.merging(["id": "q-0000aa06"]) { $1 }]
        await waiting.look()
        door.refusing = true
        do {
            _ = try await host.perform(.agentAnswer(.allow("q-0000aa06", .once, expect: 1)))
            XCTFail("an answer that reached no door was taken")
        } catch {
            XCTAssertEqual((error as? HostRefusal)?.said, .notSent)
        }
        XCTAssertEqual(host.state.agentAsks.map(\.id), ["q-0000aa06"], "the card went with no answer")
        let unanswered = try await host.reply(.agentAnswer(.allow("q-0000aa06", .once, expect: 1)))
        XCTAssertEqual(unanswered as NSDictionary,
                       ["refused": ["code": "OUTCOME_UNKNOWN", "message": ReachWords.notSent]] as NSDictionary)
        XCTAssertEqual(posted.asksWithdrawn.filter { $0 == "agent-ask.q-0000aa06" }, [])
    }

    func testAnAccessIsSetThroughTheDoorFromTheVersionEdited() async throws {
        let state = Home()
        let home = try ScriptedHome(state.answer)
        defer { home.stop() }
        let door = Door()
        let host = host(over: home, waiting: requests(over: door, posted: Posted()))

        let before = home.requests.count
        let reply = try await host.reply(.agentAccess(id: "p-0000ab07", access: Self.signInAccess, expect: 1))
        XCTAssertEqual(reply as NSDictionary, ["answer": Self.contract("access-widened")["answer"]!] as NSDictionary,
                       "the act's reply is not the door's draft, unchanged")
        XCTAssertEqual(door.sets.count, 1)
        XCTAssertEqual(door.sets[0].agent, "p-0000ab07")
        XCTAssertEqual(door.sets[0].body as NSDictionary, ["access": Self.first["access"]!, "expect": 1] as NSDictionary)
        XCTAssertEqual(asked(home, from: before), [])

        door.version("p-0000ab07", 5)
        let stale = try await host.reply(.agentAccess(id: "p-0000ab07", access: Self.signInAccess, expect: 2))
        XCTAssertEqual(stale as NSDictionary, ["refused": Self.contract("access-stale")["answer"]!] as NSDictionary,
                       "the act's reply is not the door's refusal, unchanged")
        XCTAssertEqual(door.sets.count, 2)
    }

    nonisolated static func message(_ name: String) -> String? {
        (contract(name)["answer"] as? [String: Any])?["message"] as? String
    }

    final class Replay: HomeTransport, @unchecked Sendable {
        let status: Int
        let answer: Any
        private let lock = NSLock()
        private var _sent: [Data] = []
        var sent: [Data] { lock.withLock { _sent } }

        init(status: Int, answer: Any) {
            self.status = status
            self.answer = answer
        }

        func perform(_ request: HomeRequest) async throws -> HomeResponse {
            if case .json(let data) = request.body { lock.withLock { _sent.append(data) } }
            return try Door.json(status, answer)
        }
    }

    func testTheDoorsContractFilesPassTheHostWhole() async throws {
        let state = Home()
        let home = try ScriptedHome(state.answer)
        defer { home.stop() }
        let pinned = Date(timeIntervalSince1970: 1_794_646_800)
        var made: [String: [String: Any]] = [:]
        let names = try FileManager.default.contentsOfDirectory(atPath: Self.contracts.path).filter { $0.hasSuffix(".json") }.sorted()
        for name in names {
            let file = Self.contract(String(name.dropLast(5)))
            let from = "agents/door/" + name
            let status = try XCTUnwrap(file["status"] as? Int)
            switch file["route"] as? String {
            case "GET /v1/agents/waiting":
                let answer = try XCTUnwrap(file["answer"] as? [String: Any])
                let door = Door()
                door.requests = try XCTUnwrap(answer["requests"] as? [[String: Any]])
                door.asks = try XCTUnwrap(answer["asks"] as? [[String: Any]])
                let waiting = requests(over: door, posted: Posted(), now: { pinned })
                let host = host(over: home, waiting: waiting)
                await waiting.look()
                let page = try page(host).filter { $0.key == "agent_requests" || $0.key == "agent_asks" }
                XCTAssertEqual(page["agent_requests"] as? NSArray, answer["requests"] as? NSArray, "\(name): a sign-in dropped, altered or left out")
                XCTAssertEqual(page["agent_asks"] as? NSArray, answer["asks"] as? NSArray, "\(name): an ask dropped, altered or left out")
                made[name] = ["from": from, "state": page]
            case let route? where route == "POST /v1/agents/answer" || route == "POST /v1/agents/<id>/access":
                guard let request = file["request"] as? [String: Any] else { continue }
                let answering = route == "POST /v1/agents/answer"
                let act: [String: Any] = ["type": "act", "act": answering ? "agent-answer" : "agent-access"]
                    .merging(answering ? request : request.merging(["id": "p-00000001"]) { $1 }) { $1 }
                let replay = Replay(status: status, answer: file["answer"] as Any)
                let host = host(over: home, waiting: AgentRequests(door: .of(Self.link(over: replay)), permit: { true }, deliver: { _ in },
                                                                   withdraw: { _ in }))
                let reply: [String: Any]
                switch HostAct.read(act) {
                case .failure(let refusal):
                    XCTAssertEqual(status, 422, "\(name): the host refused a body the door takes")
                    reply = ["refused": ["code": refusal.code as Any, "message": refusal.words]]
                    XCTAssertEqual(refusal.code, (file["answer"] as? [String: Any])?["code"] as? String, "\(name): not the door's code")
                case .success(let read):
                    XCTAssertTrue(status != 422 || !answering, "\(name): the host took an answer the door refuses")
                    reply = try await host.reply(read)
                    let sent = try XCTUnwrap(replay.sent.first, "\(name): nothing reached the door")
                    XCTAssertEqual(try JSONSerialization.jsonObject(with: sent) as? NSDictionary, request as NSDictionary,
                                   "\(name): the door was sent another body than the page's")
                    if status != 200 {
                        XCTAssertEqual(reply as NSDictionary, ["refused": try XCTUnwrap(file["answer"])] as NSDictionary,
                                       "\(name): the act's reply is not the door's refusal, its code and words unchanged")
                    } else {
                        XCTAssertEqual(reply as NSDictionary, ["answer": try XCTUnwrap(file["answer"])] as NSDictionary,
                                       "\(name): the act's reply is not the door's answer, unchanged")
                    }
                }
                made[name] = ["from": from, "act": act,
                              "sent": try replay.sent.first.map { try JSONSerialization.jsonObject(with: $0) } ?? NSNull(), "reply": reply]
            default:
                continue
            }
        }
        let routed = names.filter { name in
            ["GET /v1/agents/waiting", "POST /v1/agents/answer", "POST /v1/agents/<id>/access"].contains(Self.contract(String(name.dropLast(5)))["route"] as? String)
        }
        XCTAssertEqual(made.keys.sorted(), routed, "a contract file of the host's routes went unread")

        let out = Self.contracts.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("agents-host")
        let files = try made.mapValues { try JSONSerialization.data(withJSONObject: $0, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) + Data("\n".utf8) }
        let held = Set((try? FileManager.default.contentsOfDirectory(atPath: out.path)) ?? []).filter { $0.hasSuffix(".json") }
        if ProcessInfo.processInfo.environment["LIFESTREAM_FIXTURES"] == "write" {
            try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
            for gone in held.subtracting(files.keys) { try FileManager.default.removeItem(at: out.appendingPathComponent(gone)) }
            for (name, data) in files { try data.write(to: out.appendingPathComponent(name)) }
            return
        }
        XCTAssertEqual(held, Set(files.keys), "the host's contract files are not the ones the door's make: LIFESTREAM_FIXTURES=write")
        func read(_ data: Data?) -> HomeLink.JSON? { data.flatMap { try? JSONDecoder().decode(HomeLink.JSON.self, from: $0) } }
        for (name, data) in files.sorted(by: { $0.key < $1.key }) {
            XCTAssertEqual(read(try? Data(contentsOf: out.appendingPathComponent(name))), read(data), "\(name) differs: LIFESTREAM_FIXTURES=write")
        }
    }
}
