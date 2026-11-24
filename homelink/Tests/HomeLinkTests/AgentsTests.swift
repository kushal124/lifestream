import Foundation
import XCTest
@testable import HomeLink

final class AgentsTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)
    private let home = "https://lifestream.example.ts.net"

    static let agents = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures/agents")
    static let fixtures = agents.appendingPathComponent("door")
    static let guides = agents.appendingPathComponent("guide-door")

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func paired(_ script: [ScriptedTransport.Step]) async throws -> (HomeLink, ScriptedTransport, String) {
        let credentials = MemoryCredentials()
        let pairing = ScriptedTransport([.reply(200, Fixture.paired())])
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: pairing)
            .pair(code: "12345678", name: home, account: Fixture.account)
        let pass = try XCTUnwrap(Fixture.object(pairing.requests[0])["pass"] as? String)
        let transport = ScriptedTransport(script)
        return (HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport), transport, pass)
    }

    struct Case {
        let name: String
        let method: String
        let path: String
        let request: Any?
        let status: Int
        let answer: Any
    }

    static func cases(in folder: URL = fixtures) throws -> [Case] {
        try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .map { file in
                let written = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
                let route = try XCTUnwrap(written["route"] as? String).split(separator: " ", maxSplits: 1).map(String.init)
                let request = written["request"].flatMap { $0 is NSNull ? nil : $0 }
                return Case(name: file.lastPathComponent, method: route[0], path: route[1], request: request,
                            status: try XCTUnwrap(written["status"] as? Int), answer: try XCTUnwrap(written["answer"]))
            }
    }

    static func canonical(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed]),
               as: UTF8.self)
    }

    static func encoded<Value: Encodable>(_ value: Value) throws -> String {
        String(decoding: try HomeLink.wire(value), as: UTF8.self)
    }

    static func decoded<Value: Decodable>(_ type: Value.Type, _ value: Any) throws -> Value {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]))
    }

    private static let reader = "p-00000001"
    private static let ask = "rq-0000000000000001"
    private static let signIn = "c2lnbi1pbi0wMDAwMDAwMQ"
    private static let cursor = "eyJjYWxsIjo4fQ"
    private static let read = "call-0000000000000001"
    private static let kind = "messages"

    private func call(_ link: HomeLink, _ kase: Case, _ request: Any?) async throws -> String? {
        switch (kase.method, kase.path) {
        case ("GET", "/v1/agents"): return try Self.encoded(await link.agents())
        case ("GET", "/v1/agents/waiting"):
            let page = try await link.page(HomeLink.PageKey(HomeLink.Pages.AgentsWaiting.route), etag: nil)
            return try Self.encoded(JSONDecoder().decode(HomeLink.AgentsWaiting.self, from: XCTUnwrap(page).value))
        case ("GET", "/v1/agents/<id>"): return try Self.encoded(await link.agent(Self.reader))
        case ("GET", "/v1/agents/<id>/history"): return try Self.encoded(await link.agentHistory(Self.reader))
        case ("GET", "/v1/agents/<id>/history?before="): return try Self.encoded(await link.agentHistory(Self.reader, before: Self.cursor))
        case ("GET", "/v1/agents/<id>/history?kind="): return try Self.encoded(await link.agentHistory(Self.reader, kind: Self.kind))
        case ("GET", "/v1/agents/<id>/reads/<call>"): return try Self.encoded(await link.agentRead(Self.reader, call: Self.read))
        case ("GET", "/v1/agents/<id>/reads/<call>/things"): return try Self.encoded(await link.agentThings(Self.reader, call: Self.read))
        case ("GET", "/v1/agents/asks/<id>"): return try Self.encoded(await link.agentAsk(Self.ask))
        case ("GET", "/v1/agents/signins/<id>"): return try Self.encoded(await link.signIn(Self.signIn))
        case ("POST", "/v1/agents/edit"): return try Self.encoded(await link.editAccess(Self.decoded(HomeLink.EditRequest.self, XCTUnwrap(request))))
        case ("POST", "/v1/agents/<id>/access"):
            let write = try Self.decoded(HomeLink.AccessWrite.self, XCTUnwrap(request))
            return try Self.encoded(await link.setAccess(Self.reader, write.access, expect: write.expect))
        case ("POST", "/v1/agents/<id>/propose"):
            let write = try Self.decoded(HomeLink.AccessWrite.self, XCTUnwrap(request))
            return try Self.encoded(await link.propose(Self.reader, write.access, expect: write.expect))
        case ("POST", "/v1/agents/answer"): return try Self.encoded(await link.answer(Self.decoded(HomeLink.AnswerRequest.self, XCTUnwrap(request))))
        case ("POST", "/v1/agents/<id>/disconnect"): return try Self.encoded(await link.disconnect(Self.reader))
        case ("POST", "/v1/agents/<id>/unlist"): return try Self.encoded(await link.unlist(Self.reader))
        case ("GET", "/v1/agents/address"): return try Self.encoded(await link.address())
        case ("POST", "/v1/agents/address"):
            let write = try Self.decoded(HomeLink.AddressWrite.self, XCTUnwrap(request))
            return try Self.encoded(await link.turnAddressOn(reader: write.reader))
        case ("POST", "/v1/agents/keys"):
            let asked = try Self.decoded(HomeLink.KeyRequest.self, XCTUnwrap(request))
            return try Self.encoded(await link.makeKey(asked.app, name: asked.name, access: asked.access))
        default: throw Unsent(name: kase.name)
        }
    }

    struct Unsent: Error { let name: String }

    private static func path(_ kase: Case) -> String {
        let id = kase.path.hasPrefix("/v1/agents/asks/") ? ask : kase.path.hasPrefix("/v1/agents/signins/") ? signIn : reader
        return kase.path.replacingOccurrences(of: "<id>", with: id).replacingOccurrences(of: "<call>", with: read)
            .replacingOccurrences(of: "?before=", with: "?before=" + cursor).replacingOccurrences(of: "?kind=", with: "?kind=" + kind)
    }

    static func unwritable(_ cases: [Case]) -> [Case] {
        cases.filter { kase in
            guard let request = kase.request else { return false }
            switch kase.path {
            case "/v1/agents/edit": return (try? Self.decoded(HomeLink.EditRequest.self, request)) == nil
            case "/v1/agents/answer": return (try? Self.decoded(HomeLink.AnswerRequest.self, request)) == nil
            case "/v1/agents/<id>/disconnect", "/v1/agents/<id>/unlist": return (try? Self.decoded(HomeLink.Empty.self, request)) == nil
            case "/v1/agents/address": return (try? Self.decoded(HomeLink.AddressWrite.self, request)) == nil
            case "/v1/agents/keys": return (try? Self.decoded(HomeLink.KeyRequest.self, request)) == nil
            default: return (try? Self.decoded(HomeLink.AccessWrite.self, request)) == nil
            }
        }
    }

    func testEveryContractFileIsSentAsTheDoorParsesItAndReadBackEqual() async throws {
        let cases = try Self.cases()
        XCTAssertGreaterThanOrEqual(cases.count, 58, "the door's test writes every route, body and refusal")
        XCTAssertEqual(Self.unwritable(cases).map(\.name), [], "every body the door parses reads as its request shape")
        try await sendsAndReadsBack(cases)
    }

    func testEveryGuideFileIsSentAsTheDoorParsesItAndReadBackEqual() async throws {
        let cases = try Self.cases(in: Self.guides)
        XCTAssertGreaterThanOrEqual(cases.count, 17, "the home's test writes the address, each key, the key's draft and their refusals")
        let unwritable = Self.unwritable(cases).map(\.name)
        XCTAssertEqual(unwritable, ["address-bad.json"], "the one body no app writes is the one the door refuses for its shape")
        try await sendsAndReadsBack(cases.filter { !unwritable.contains($0.name) })
    }

    private func sendsAndReadsBack(_ cases: [Case]) async throws {
        for kase in cases {
            let request = kase.request ?? (kase.method == "POST" ? cases.first { $0.path == kase.path && $0.status == 200 }?.request : nil)
            let (link, transport, pass) = try await paired([.reply(kase.status, try Self.canonical(kase.answer))])
            var answered: String?
            var failure: LinkFailure?
            do { answered = try await call(link, kase, request) } catch let failed as LinkFailure { failure = failed }

            let sent = try XCTUnwrap(transport.requests.first, kase.name)
            XCTAssertEqual(sent.method, kase.method, kase.name)
            XCTAssertEqual(sent.url.absoluteString, home + Self.path(kase), kase.name)
            XCTAssertEqual(sent.headers["Authorization"], "Bearer \(pass)", kase.name)
            XCTAssertEqual(sent.headers["Lifestream-Device"], "phone/1.4.0", kase.name)
            if let request {
                guard case .json(let body) = sent.body else { XCTFail("\(kase.name): a JSON body"); continue }
                XCTAssertEqual(sent.headers["Content-Type"], "application/json", kase.name)
                XCTAssertEqual(String(decoding: body, as: UTF8.self), try Self.canonical(request), "\(kase.name): the body byte for byte")
            } else {
                XCTAssertEqual(sent.body, .empty, kase.name)
            }

            let said = try XCTUnwrap(kase.answer as? [String: Any], kase.name)
            switch kase.status {
            case 200:
                XCTAssertNil(failure, kase.name)
                XCTAssertEqual(answered, try Self.canonical(kase.answer), "\(kase.name): every member read and written back")
            default:
                XCTAssertNil(answered, kase.name)
                XCTAssertEqual(failure, .refused(status: kase.status, code: try XCTUnwrap(said["code"] as? String),
                                                 message: try XCTUnwrap(said["message"] as? String)), kase.name)
            }
        }
    }

    func testAnAnswerMissingAnyMemberFailsToRead() throws {
        let types: [String: (Any) throws -> Void] = [
            "GET /v1/agents": { _ = try Self.decoded(HomeLink.AgentList.self, $0) },
            "GET /v1/agents/waiting": { _ = try Self.decoded(HomeLink.AgentsWaiting.self, $0) },
            "GET /v1/agents/<id>": { _ = try Self.decoded(HomeLink.AgentRead.self, $0) },
            "GET /v1/agents/<id>/history": { _ = try Self.decoded(HomeLink.HistoryPage.self, $0) },
            "GET /v1/agents/<id>/history?before=": { _ = try Self.decoded(HomeLink.HistoryPage.self, $0) },
            "GET /v1/agents/<id>/history?kind=": { _ = try Self.decoded(HomeLink.HistoryPage.self, $0) },
            "GET /v1/agents/<id>/reads/<call>": { _ = try Self.decoded(HomeLink.ReadPage.self, $0) },
            "GET /v1/agents/<id>/reads/<call>/things": { _ = try Self.decoded(HomeLink.ThingsPage.self, $0) },
            "GET /v1/agents/asks/<id>": { _ = try Self.decoded(HomeLink.AgentAsk.self, $0) },
            "GET /v1/agents/signins/<id>": { _ = try Self.decoded(HomeLink.SignInRead.self, $0) },
            "POST /v1/agents/edit": { _ = try Self.decoded(HomeLink.AccessDraft.self, $0) },
            "POST /v1/agents/<id>/access": { _ = try Self.decoded(HomeLink.AccessDraft.self, $0) },
            "POST /v1/agents/<id>/propose": { _ = try Self.decoded(HomeLink.AccessChange.self, $0) },
            "POST /v1/agents/answer": { _ = try Self.decoded(HomeLink.AnswerReply.self, $0) },
            "POST /v1/agents/<id>/disconnect": { _ = try Self.decoded(HomeLink.AgentRead.self, $0) },
            "POST /v1/agents/<id>/unlist": { _ = try Self.decoded(HomeLink.AgentList.self, $0) },
        ]
        var tried = Set<String>()
        for kase in try Self.cases() where kase.status == 200 {
            let read = try XCTUnwrap(types[kase.method + " " + kase.path], kase.name)
            try read(kase.answer)
            for (path, without) in Self.withoutEachMember(kase.answer) where tried.insert(kase.method + kase.path + path).inserted {
                XCTAssertThrowsError(try read(without), "\(kase.name): an answer without \(path) reads")
            }
        }
        XCTAssertGreaterThan(tried.count, 150, "every member of every shape was left out once")
    }

    func testAGuideAnswerMissingAnyMemberFailsToRead() throws {
        let types: [String: (Any) throws -> Void] = [
            "GET /v1/agents": { _ = try Self.decoded(HomeLink.AgentList.self, $0) },
            "GET /v1/agents/address": { _ = try Self.decoded(HomeLink.AgentAddress.self, $0) },
            "POST /v1/agents/address": { _ = try Self.decoded(HomeLink.AgentAddress.self, $0) },
            "POST /v1/agents/keys": { _ = try Self.decoded(HomeLink.MadeKey.self, $0) },
            "POST /v1/agents/edit": { _ = try Self.decoded(HomeLink.AccessDraft.self, $0) },
            "POST /v1/agents/answer": { _ = try Self.decoded(HomeLink.AnswerReply.self, $0) },
            "GET /v1/agents/signins/<id>": { _ = try Self.decoded(HomeLink.SignInRead.self, $0) },
        ]
        var tried = Set<String>()
        for kase in try Self.cases(in: Self.guides) where kase.status == 200 {
            let read = try XCTUnwrap(types[kase.method + " " + kase.path], kase.name)
            try read(kase.answer)
            for (path, without) in Self.withoutEachMember(kase.answer) where tried.insert(kase.name + path).inserted {
                XCTAssertThrowsError(try read(without), "\(kase.name): an answer without \(path) reads")
            }
        }
        XCTAssertGreaterThan(tried.count, 40, "every member of the address, a key, its draft and a sign-in's connection was left out once")
    }

    func testAnAddressIsOnWithItsLineOffWithItsUrlOrAFixWithNoUrl() throws {
        let on = try Self.decoded(HomeLink.AgentAddress.self, XCTUnwrap(Self.guide("address-on")["answer"]))
        XCTAssertEqual(on.url, "https://macbook-pro-0001.tail0000.ts.net/mcp")
        guard case .on(_, let line) = on else { return XCTFail("an address on") }
        XCTAssertFalse(line.isEmpty, "the home says what being on means")
        let off = try Self.decoded(HomeLink.AgentAddress.self, XCTUnwrap(Self.guide("address-off")["answer"]))
        XCTAssertEqual(off, .off(url: "https://macbook-pro-0001.tail0000.ts.net/mcp"), "the address shows before the copy")
        let turnOn = try Self.decoded(HomeLink.AgentAddress.self, XCTUnwrap(Self.guide("address-fix-turn-on")["answer"]))
        guard case .fix(_, let act?) = turnOn else { return XCTFail("a fix with an act") }
        XCTAssertEqual(act.to, .turnOn)
        XCTAssertNil(act.url, "turn-on opens the web page the POST answers")
        let phone = try Self.decoded(HomeLink.AgentAddress.self, XCTUnwrap(Self.guide("address-fix-phone")["answer"]))
        guard case .fix(_, nil) = phone else { return XCTFail("the phone's fix is words only") }
        XCTAssertThrowsError(try Self.decoded(HomeLink.AgentAddress.self, ["state": "fix", "url": "https://example.com/mcp", "words": "x", "act": NSNull()]),
                             "a fix has no address to copy")
        XCTAssertThrowsError(try Self.decoded(HomeLink.AgentAddress.self, ["state": "on", "url": NSNull(), "line": "x"]), "an address on has its url")
        XCTAssertThrowsError(try Self.decoded(HomeLink.AgentAddress.self, ["state": "maybe", "url": NSNull()]))
    }

    func testAKeyNamesItsAppOnlyForAnotherAgentAndTheInternetCopyNamesItsReader() throws {
        let access = try Self.decoded(HomeLink.Access.self, ["allow": []])
        XCTAssertEqual(try Self.encoded(HomeLink.KeyRequest(app: .instinct, name: nil, access: access)), #"{"access":{"allow":[]},"app":"instinct"}"#)
        XCTAssertEqual(try Self.encoded(HomeLink.KeyRequest(app: .another, name: "Example tool", access: access)),
                       #"{"access":{"allow":[]},"app":"another","name":"Example tool"}"#)
        XCTAssertEqual(try Self.encoded(HomeLink.AddressWrite(reader: nil)), #"{"on":true}"#)
        XCTAssertEqual(try Self.encoded(HomeLink.AddressWrite(reader: "p-0000cccc")), #"{"on":true,"reader":"p-0000cccc"}"#)
        XCTAssertThrowsError(try Self.decoded(HomeLink.AddressWrite.self, ["on": false]), "an app never turns the address off")
        XCTAssertEqual(try Self.encoded(HomeLink.EditTarget.key(.grokBot)), #"{"key":"grok-bot"}"#)
        XCTAssertThrowsError(try Self.decoded(HomeLink.EditTarget.self, ["key": "claude"]), "a key is made only for a key app")
    }

    static func guide(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: guides.appendingPathComponent(name + ".json"))) as? [String: Any])
    }

    static func withoutEachMember(_ value: Any, at path: String = "") -> [(String, Any)] {
        if let array = value as? [Any] {
            return array.enumerated().flatMap { index, element in
                withoutEachMember(element, at: path + ".*").map { inner, without -> (String, Any) in
                    var copy = array
                    copy[index] = without
                    return (inner, copy)
                }
            }
        }
        guard let object = value as? [String: Any], object["allow"] == nil else { return [] }
        return object.keys.sorted().flatMap { key -> [(String, Any)] in
            var dropped = object
            dropped[key] = nil
            let inner = withoutEachMember(object[key]!, at: path + "." + key).map { innerPath, without -> (String, Any) in
                var copy = object
                copy[key] = without
                return (innerPath, copy)
            }
            return (Self.optional(key, in: path) ? [] : [(path + "." + key, dropped)]) + inner
        }
    }

    static func optional(_ key: String, in path: String) -> Bool { key == "bold" || (key == "focus" && path.hasSuffix(".opens")) }

    func testARunIsBoldOnlyWhenItSaysSo() throws {
        let runs = try JSONDecoder().decode(HomeLink.Bolded.self, from: Data(#"[{"text":"Orbit sees "},{"bold":true,"text":"Health"}]"#.utf8))
        XCTAssertEqual(runs, [.init("Orbit sees "), .init("Health", bold: true)])
        XCTAssertEqual(try Self.encoded(runs), #"[{"text":"Orbit sees "},{"bold":true,"text":"Health"}]"#, "a plain run names no bold")
        XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.Bolded.self, from: Data(#"[{"text":"Health","bold":false}]"#.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.Bolded.self, from: Data(#"[{"bold":true}]"#.utf8)))
    }

    func testAnAccessIsKeptAndSentBackWholeAndAnythingButAnObjectIsNone() throws {
        let written = #"{"allow":[{"area":"later","reach":{"all":true,"but":[]},"until_ms":1794650400000,"window":{"past_ms":0.5}}],"x":null}"#
        let access = try JSONDecoder().decode(HomeLink.Access.self, from: Data(written.utf8))
        XCTAssertEqual(try Self.encoded(access), written, "a member no release knows goes back too")
        XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.Access.self, from: Data("null".utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.Access.self, from: Data(#"["all"]"#.utf8)))
    }

    func testTheTimePageAndHidingAreTheHomesOptions() throws {
        let view = try Self.draft("edit-window.json").view
        XCTAssertEqual(view.times.map(\.choice), [.all, .past, .past, .past, .past, .past, .since])
        XCTAssertEqual(view.times.first?.words, "All time")
        XCTAssertEqual(view.times.last?.words, "Since a date\u{2026}")
        XCTAssertNil(view.times.last?.window, "Since… names no window: the person picks the day")
        XCTAssertEqual(view.times[1], .init(choice: .past, window: .past(ms: 31_536_000_000), words: "Past year"))
        let hiding = try XCTUnwrap(view.hide)
        XCTAssertEqual(hiding.choices.map(\.level), [.none, .names, .all, .custom])
        XCTAssertEqual(hiding.choices.first { $0.selected }?.words, hiding.words, "the choice in force is the one the Hides row names")
        XCTAssertTrue(hiding.choices.filter { $0.level != .custom }.allSatisfy { $0.line != nil }, "each choice says what it hides")
        XCTAssertNil(hiding.choices.first { $0.level == .custom }?.line, "Choose\u{2026} opens the hides page and says nothing more")
        for kase in try Self.cases() where kase.status == 200 && kase.path == "/v1/agents/edit" {
            let drawn = try Self.decoded(HomeLink.AccessDraft.self, kase.answer).view
            XCTAssertFalse(drawn.times.isEmpty, kase.name)
            XCTAssertFalse(drawn.hide?.choices.isEmpty ?? true, kase.name)
        }
        var odd = try XCTUnwrap(try Self.cases().first { $0.name == "edit-window.json" }?.answer as? [String: Any])
        var drawn = try XCTUnwrap(odd["view"] as? [String: Any])
        var times = try XCTUnwrap(drawn["times"] as? [[String: Any]])
        times[0]["choice"] = "ever"
        drawn["times"] = times
        odd["view"] = drawn
        XCTAssertThrowsError(try Self.decoded(HomeLink.AccessDraft.self, odd))
    }

    func testTheHomeCountsReadsAndSaysWhatANarrowingSavedOrAWideningWaitsFor() throws {
        let cases = try Self.cases()
        let reader = try Self.decoded(HomeLink.AgentRead.self, try XCTUnwrap(cases.first { $0.name == "reader-reads.json" }?.answer))
        XCTAssertEqual(reader.reads.line, "Read 10:40 \u{00B7} 55 reads today")
        XCTAssertEqual(reader.reads.short, "Read 10:40 \u{00B7} 55 today")
        XCTAssertEqual([reader.reads.today, reader.reads.total, reader.reads.days.count], [55, 55, 7])
        XCTAssertEqual([reader.figure.today, reader.figure.days.count], [55, 7], "the figure counts today's reads over the week")
        XCTAssertEqual(reader.figure.said.filter(\.bold).map(\.text), ["email", "Health"], "the sentence's bold parts, as the home marked them")
        XCTAssertEqual(reader.view.categories.first?.reads, .init(n: 7, words: "7 reads in 30 days"), "each kind's reads of the past 30 days")
        XCTAssertEqual(reader.view.reads, "Everything but Health and Money", "the Reads row is the home's words")
        XCTAssertEqual(reader.recent.lines.map(\.words), ["Read your day, 13 Nov", "Searched for \u{201C}dinner 54\u{201D}"],
                       "the last two reads, picked by the home")
        XCTAssertEqual(reader.recent.all, "See all 55 reads")
        let quiet = try Self.decoded(HomeLink.AgentRead.self, try XCTUnwrap(cases.first { $0.name == "reader-agent.json" }?.answer))
        XCTAssertEqual(quiet.recent, .init(lines: [], all: nil), "no reads, nothing to see all of")

        let narrowed = try XCTUnwrap(try Self.draft("edit-narrowed.json").narrowed)
        XCTAssertEqual(narrowed.words, [.init("Saved. Editor no longer sees your "), .init("messages", bold: true), .init(".")])
        XCTAssertEqual(narrowed.undo.expect, try Self.draft("edit-narrowed.json").expect, "Undo saves over the version the narrowing made")
        XCTAssertNil(try Self.draft("edit-narrowed.json").view.widening, "a narrowing is saved, nothing waits")

        let widening = try Self.draft("edit-widening.json")
        XCTAssertNil(widening.narrowed, "a widening saves nothing")
        XCTAssertEqual(widening.view.widening, [.init("Editor would also see "), .init("Health", bold: true), .init(". Nothing changes until you allow it.")])
    }

    func testTheDoorsWordsOfHowEachEndedAndAnAccessNeverAbsent() throws {
        let cases = try Self.cases()
        func answer(_ name: String) throws -> Any { try XCTUnwrap(cases.first { $0.name == name }?.answer, name) }

        let none = try Self.decoded(HomeLink.AgentRead.self, try answer("reader-no-access.json"))
        XCTAssertEqual(none.version, 0)
        XCTAssertEqual(try Self.encoded(none.access), #"{"allow":[],"hide":"names","items":[],"not":[],"only":[],"shown":[],"window":null}"#,
                       "a reader with no access reads the empty access")
        var absent = try XCTUnwrap(try answer("reader-no-access.json") as? [String: Any])
        absent["access"] = NSNull()
        XCTAssertThrowsError(try Self.decoded(HomeLink.AgentRead.self, absent), "an access read as absent")

        let erased = try Self.decoded(HomeLink.AgentAsk.self, try answer("ask-erased.json"))
        XCTAssertEqual(erased.default, .no)
        XCTAssertEqual(erased.stacked.map(\.answer), [.no], "its one choice, No, is its default")

        let later = try XCTUnwrap(cases.first { $0.name == "access-later-refused.json" })
        XCTAssertEqual(later.status, 422)
        XCTAssertEqual(try XCTUnwrap(later.answer as? [String: Any])["code"] as? String, "BAD_REQUEST",
                       "an access that names a person is refused in the parser's words")

        let chat = try Self.decoded(HomeLink.AgentRead.self, try answer("reader-chat.json"))
        XCTAssertNil(chat.view.hide, "Chat hides nothing of its own: its view has no Hiding")

        let signIns = cases.filter { $0.name.hasPrefix("answer-sign-in") && $0.status == 200 }
        XCTAssertEqual(signIns.count, 4, "a sign-in answered, refused, wrong, and answered again")
        for kase in signIns {
            XCTAssertNotNil(try Self.decoded(HomeLink.AnswerReply.self, kase.answer).outcome, "\(kase.name): a sign-in's answer says how it ended")
        }
    }

    func testHistoryIsTheAgentsWordsWithFoldsAndChangesAsLinesOfTheirOwn() throws {
        let cases = try Self.cases()
        let page = try Self.decoded(HomeLink.HistoryPage.self, try XCTUnwrap(cases.first { $0.name == "history.json" }?.answer))
        let session = try XCTUnwrap(page.sessions.first)
        XCTAssertEqual(session.reads, "26 reads")
        XCTAssertEqual(page.sessions.map(\.day), Array(repeating: .init(day: "2026-11-14", words: "Today", reads: "55 reads"), count: 2),
                       "each session on the day of its last read, in the home's words")
        guard case .read(let first) = session.lines.first else { return XCTFail("a read opens the session") }
        XCTAssertEqual([first.words, first.line, first.icon], ["Read your day, 13 Nov", "Nothing found", "days"], "the read in the home's words, what came back, its icon")
        let reads = page.sessions.flatMap(\.lines).compactMap { line -> HomeLink.HistoryRead? in if case .read(let read) = line { read } else { nil } }
        let kept = try XCTUnwrap(reads.first { $0.kept != nil })
        XCTAssertEqual([kept.line, kept.kept], ["1 email", "names kept from it"], "what came back and what was kept from it")
        XCTAssertTrue(kept.opens, "a read opens to its page")
        let folds = session.lines.compactMap { line -> HomeLink.HistoryFold? in if case .fold(let fold) = line { fold } else { nil } }
        XCTAssertEqual(folds.map(\.n), folds.map(\.lines.count), "a fold holds the reads it counts")
        XCTAssertEqual([folds.first?.words, folds.first?.line], ["2 more reads", "Searched for 1 \u{00B7} Read your day 1"])
        XCTAssertTrue(session.lines.contains(.change(.init(atMs: 1_794_652_440_000, icon: "needs-you", words: "Asked to see Health for 1 hour",
                                                           line: "\u{201C}Your sleep this week.\u{201D}", ask: nil, tone: .plain))))
        var odd = try XCTUnwrap(try XCTUnwrap(cases.first { $0.name == "history.json" }?.answer as? [String: Any]))
        var sessions = try XCTUnwrap(odd["sessions"] as? [[String: Any]])
        var lines = try XCTUnwrap(sessions[0]["lines"] as? [[String: Any]])
        lines[0]["kind"] = "outcome"
        sessions[0]["lines"] = lines
        odd["sessions"] = sessions
        XCTAssertThrowsError(try Self.decoded(HomeLink.HistoryPage.self, odd), "a line of no known kind")
    }

    private static func page(_ name: String) throws -> HomeLink.HistoryPage {
        try decoded(HomeLink.HistoryPage.self, try XCTUnwrap(try cases().first { $0.name == name }?.answer, name))
    }

    private static func reads(_ page: HomeLink.HistoryPage) -> [HomeLink.HistoryRead] {
        page.sessions.flatMap(\.lines).flatMap { line -> [HomeLink.HistoryRead] in
            switch line {
            case .read(let read): [read]
            case .fold(let fold): fold.lines
            case .change: []
            }
        }
    }

    func testHistorysFigureAndChipsComeWithTheFirstPageAlone() throws {
        let first = try Self.page("history.json")
        XCTAssertEqual(first.chips.map(\.name), ["Mail", "Messages"])
        XCTAssertEqual(first.chips.map(\.n), [14, 7], "a chip counts today's reads that saw the kind, never the things")
        XCTAssertEqual(first.figure?.today, 55)
        XCTAssertNil(first.kind, "no filter in force")
        let earlier = try Self.page("history-earlier.json")
        XCTAssertEqual(earlier.chips, [], "a later page names none")
        XCTAssertNil(earlier.figure)
        let joined = first.joined(earlier)
        XCTAssertEqual(joined.chips, first.chips, "the first page's chips stand once Earlier is joined")
        XCTAssertEqual(joined.figure, first.figure)
        let none = try Self.page("history-no-calls.json")
        XCTAssertEqual(none.chips, [], "an agent that read nothing has no chip")
        XCTAssertEqual(none.empty?.title, "Instinct hasn\u{2019}t read anything yet")
        XCTAssertNil(none.figure)
        let kind = try Self.page("history-kind.json")
        XCTAssertEqual(kind.kind, "messages", "the filter in force")
        XCTAssertFalse(Self.reads(kind).isEmpty)
    }

    func testOneReadJoinsItsPagesRepeatsFoldAndAWaitingAskOpensTheAsk() throws {
        let pages = Self.reads(try Self.page("history-pages.json"))
        XCTAssertEqual(pages.map(\.more), [3], "a search and its three later pages, one row")
        XCTAssertEqual(pages.first?.words, "Searched for \u{201C}running shoes\u{201D}")
        let repeats = try Self.page("history-repeats.json").sessions.flatMap(\.lines)
        guard case .fold(let hourly)? = repeats.first else { return XCTFail("the repeats fold") }
        XCTAssertEqual([hourly.icon, hourly.words], ["sync", "Read your day, every hour"])
        XCTAssertEqual(hourly.lines.count, 4)
        let refused = try XCTUnwrap(Self.reads(try Self.page("history-refused.json")).first { $0.tone == .refused })
        XCTAssertEqual(refused.line, "Stopped: Orbit can\u{2019}t see Money")
        let waiting = try Self.page("history-waiting.json").sessions.flatMap(\.lines).compactMap { line -> HomeLink.HistoryChange? in
            if case .change(let change) = line { change } else { nil }
        }
        let ask = try XCTUnwrap(waiting.first { $0.tone == .waiting })
        XCTAssertEqual(ask.ask, Self.ask, "the waiting row opens the open ask")
    }

    func testAReadsPageCountsItsPagesAndItsThingsAreThePersonsAlone() throws {
        let cases = try Self.cases()
        func answer(_ name: String) throws -> Any { try XCTUnwrap(cases.first { $0.name == name }?.answer, name) }
        let joined = try Self.decoded(HomeLink.ReadPage.self, try answer("read-joined.json"))
        XCTAssertEqual([joined.figure?.n, joined.show?.n], [4, 4], "counted across every page joined into it")
        XCTAssertEqual(joined.kept?.rows.map(\.type), ["names", "phone"])
        XCTAssertEqual(joined.why?.filter(\.bold).map(\.text), ["everything but Health and Money"])
        XCTAssertNil(joined.refused)
        let read = try Self.decoded(HomeLink.ReadPage.self, try answer("read.json"))
        XCTAssertFalse(read.why?.map(\.text).joined().contains("24 hours") ?? true, "why: the access in force when it read")
        let refused = try Self.decoded(HomeLink.ReadPage.self, try answer("read-refused.json"))
        XCTAssertEqual(refused.refused, "Stopped: Orbit can\u{2019}t see Money")
        XCTAssertNil(refused.figure)
        XCTAssertNil(refused.show)
        let things = try Self.decoded(HomeLink.ThingsPage.self, try answer("things.json"))
        XCTAssertEqual(things.groups.flatMap(\.things).count, 4)
        XCTAssertNil(things.gone)
        let gone = try Self.decoded(HomeLink.ThingsPage.self, try answer("things-gone.json"))
        XCTAssertEqual(gone.groups.flatMap(\.things).count, 2)
        XCTAssertEqual(gone.gone, "1 of them is no longer in Lifestream.")
        for (name, status, code) in [("things-chat.json", 403, "PERSON_ONLY"), ("read-unknown.json", 404, "READ_UNKNOWN")] {
            let kase = try XCTUnwrap(cases.first { $0.name == name })
            XCTAssertEqual(kase.status, status, name)
            XCTAssertEqual((kase.answer as? [String: Any])?["code"] as? String, code, name)
        }
    }

    func testASessionAcrossPagesIsFoldedOnceAndEarlierContinuesItsFold() throws {
        let cases = try Self.cases()
        let first = try Self.decoded(HomeLink.HistoryPage.self, try XCTUnwrap(cases.first { $0.name == "history.json" }?.answer))
        let earlier = try Self.decoded(HomeLink.HistoryPage.self, try XCTUnwrap(cases.first { $0.name == "history-earlier.json" }?.answer))
        func folds(_ session: HomeLink.HistoryPage.Session) -> [HomeLink.HistoryFold] {
            session.lines.compactMap { if case .fold(let fold) = $0 { fold } else { nil } }
        }
        let split = try XCTUnwrap(first.sessions.last)
        let goesOn = try XCTUnwrap(earlier.sessions.first)
        XCTAssertEqual(goesOn.key, split.key, "Earlier starts in the session the first page ended in")
        XCTAssertEqual(folds(goesOn).first?.continues, true)
        XCTAssertEqual(folds(split).map(\.continues), [false])

        let joined = first.joined(earlier)
        XCTAssertEqual(joined.sessions.map(\.key), first.sessions.map(\.key) + earlier.sessions.dropFirst().map(\.key))
        let session = try XCTUnwrap(joined.sessions.first { $0.key == split.key })
        let fold = try XCTUnwrap(folds(session).last)
        XCTAssertEqual(folds(session).count, folds(split).count, "one fold for the session, never one per page")
        XCTAssertEqual(fold.n, fold.lines.count, "the fold holds every read it counts, both pages'")
        XCTAssertEqual(fold.words, folds(goesOn).first?.words, "the whole session's tally, as the home said it")
        XCTAssertEqual(fold.atMs, folds(split).first?.atMs, "the fold starts where the session's run started")
        XCTAssertNil(joined.next)
    }

    func testASignInReadByItsIdSaysHowItEndedOnAnotherDevice() throws {
        let cases = try Self.cases()
        func read(_ name: String) throws -> HomeLink.SignInRead {
            try Self.decoded(HomeLink.SignInRead.self, try XCTUnwrap(cases.first { $0.name == name }?.answer, name))
        }
        let waiting = try read("signin-waiting.json")
        XCTAssertEqual(waiting.state, .waiting)
        XCTAssertNil(waiting.outcome, "still waiting: nothing ended")
        let answered = try read("signin-answered.json")
        XCTAssertEqual(answered.state, .approved)
        XCTAssertEqual(answered.outcome, HomeLink.Phrase([.words("Allowed on iPhone,"), .time(.clock(1_794_646_800_000))]),
                       "where it was answered in the home's words, and when as a time the device words")
        XCTAssertEqual(try XCTUnwrap(cases.first { $0.name == "signin-over.json" }).status, 200, "a sign-in the home no longer holds is read, never refused")
        let over = try read("signin-over.json")
        XCTAssertEqual(over.state, .gone, "a sign-in the home no longer holds is over by the home's clock")
        XCTAssertNil(over.outcome, "no device answered it")
        XCTAssertNil(over.reader)
        XCTAssertNil(over.connected)
    }

    func testANarrowingWhileAWideningWaitsIsSavedAndTheWideningStaysADraftOnTop() throws {
        let draft = try Self.draft("edit-narrowed-widening-waits.json")
        let narrowed = try XCTUnwrap(draft.narrowed, "the narrowing is saved at once")
        XCTAssertEqual(narrowed.words, [.init("Saved. Pager no longer sees your "), .init("email", bold: true), .init(".")])
        XCTAssertNotNil(draft.view.widening, "the widening still waits for Allow")
        let kept = try XCTUnwrap(draft.narrowedTo, "what Cancel goes back to")
        XCTAssertEqual(kept.expect, draft.expect, "the version the narrowing made: Allow saves only the widening over it")
        XCTAssertEqual(kept.narrowed, draft.narrowed, "Cancel keeps the narrowing's Undo")
        XCTAssertNil(kept.view.widening, "nothing waits on the saved access")
        XCTAssertNotEqual(kept.access, draft.access, "the widening is not saved")
        XCTAssertNil(try Self.draft("edit-widening.json").narrowedTo, "a widening alone saves nothing")
        let plain = try Self.draft("edit-narrowed.json")
        XCTAssertEqual(plain.narrowedTo?.access, plain.access, "a narrowing alone: the saved access is the draft")
    }

    func testANarrowingsUndoStaysUntilTheSavedVersionMoves() throws {
        let split = try Self.draft("edit-narrowed-widening-waits.json")
        let narrowed = try XCTUnwrap(split.narrowed)
        var editor = AccessEditing(target: .reader(Self.reader), drawn: split)
        let wider = try XCTUnwrap(editor.tap(.mode(.but)))
        var widening = split
        widening.narrowed = nil
        widening.saved = nil
        editor.land(wider.id, widening)
        XCTAssertEqual(editor.draft?.narrowed, narrowed, "a later tap at the same version leaves the narrowing and its Undo")
        let allow = try XCTUnwrap(editor.save())
        var allowed = widening
        allowed.expect = try XCTUnwrap(split.expect) + 1
        editor.land(allow.id, allowed)
        XCTAssertNil(editor.draft?.narrowed, "a save moved the version: that Undo no longer works")
    }

    func testDisconnectKeepsTheAgentAndItsHistoryAndTheListSaysWhichAreGone() throws {
        let cases = try Self.cases()
        func answer(_ name: String) throws -> Any { try XCTUnwrap(cases.first { $0.name == name }?.answer, name) }
        let connected = try Self.decoded(HomeLink.AgentRead.self, try answer("reader-agent.json"))
        XCTAssertEqual(connected.state, .connected)
        XCTAssertNil(connected.disconnected)
        let words = try XCTUnwrap(connected.disconnect, "a connected agent carries what Disconnect stops and keeps")
        XCTAssertEqual(words.stops.map(\.name), ["Its reads", "Its key"])
        XCTAssertEqual(words.stops.last?.line, "The key made 14 Nov stops working", "the key's own date")
        XCTAssertEqual(words.stays.first?.name, "Its history here")
        XCTAssertEqual(words.confirm, "Disconnect Hermes")
        XCTAssertNil(try Self.decoded(HomeLink.AgentRead.self, try answer("reader-chat.json")).disconnect, "Chat is never disconnected")

        let gone = try Self.decoded(HomeLink.AgentRead.self, try answer("disconnect.json"))
        XCTAssertEqual(gone.state, .disconnected)
        XCTAssertEqual(gone.disconnected, "Disconnected 14 Nov")
        XCTAssertNil(gone.disconnect)
        let list = try Self.decoded(HomeLink.AgentList.self, try answer("list-disconnected.json"))
        XCTAssertEqual(list.readers.filter { $0.state == .disconnected }.map(\.summary), ["Disconnected 14 Nov \u{00B7} its history stays"])
        let unlisted = try Self.decoded(HomeLink.AgentList.self, try answer("unlist.json"))
        XCTAssertFalse(unlisted.readers.contains { $0.state == .disconnected }, "unlisted, it leaves the list")
        let still = try XCTUnwrap(cases.first { $0.name == "unlist-connected.json" })
        XCTAssertEqual(still.status, 409)
        XCTAssertEqual((still.answer as? [String: Any])?["message"] as? String, "Disconnect Pager first.")
    }

    func testTheModeIsOneFieldAndOnlyTheseNarrowsWhileEverythingButWaits() throws {
        let only = try Self.draft("edit-mode-only.json")
        XCTAssertEqual(only.view.mode, .only)
        XCTAssertEqual(only.view.modes.map(\.words), ["Everything but", "Only these"])
        XCTAssertNotNil(only.narrowed, "to Only these narrows: saved, with an Undo")
        let but = try Self.draft("edit-mode-but.json")
        XCTAssertEqual(but.view.mode, .but)
        XCTAssertNil(but.narrowed)
        XCTAssertNotNil(but.view.widening, "to Everything but widens: it waits for Allow")
        XCTAssertEqual(try Self.encoded(HomeLink.Edit.mode(.only)), #"{"mode":"only"}"#)
    }

    func testAWriteBeforeTheHomeKeepsAccessIsRefusedInTheDoorsWords() throws {
        var editor = AccessEditing(target: .reader(Self.reader), access: try Self.access("edit-draw.json"), expect: 1)
        let draw = try XCTUnwrap(editor.draw())
        editor.land(draw.id, try Self.draft("edit-draw.json"))
        let save = try XCTUnwrap(editor.save())
        let words = "Update Lifestream on your Mac to connect agents."
        editor.fail(save.id, LinkFailure.refused(status: 409, code: "ACCESS_NOT_STARTED", message: words))
        XCTAssertEqual(editor.trouble, .refused(words), "said as its words, never as the access changed since")
        for name in ["access-not-started.json", "propose-not-started.json"] {
            let said = try XCTUnwrap(try Self.cases().first { $0.name == name }?.answer as? [String: Any], name)
            XCTAssertEqual(said["code"] as? String, "ACCESS_NOT_STARTED", name)
            XCTAssertEqual(said["message"] as? String, words, name)
        }
    }

    func testAnUnpairedDeviceAsksNothing() async throws {
        let transport = ScriptedTransport([.reply(200, #"{"requests":[],"asks":[]}"#)])
        let link = HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder, transport: transport)
        do { _ = try await link.page(HomeLink.PageKey(HomeLink.Pages.AgentsWaiting.route), etag: nil); XCTFail("unpaired") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unpaired)
        }
        do { _ = try await link.answer(.deny("c2lnbi1pbi0wMDAwMDAwMQ")); XCTFail("unpaired") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unpaired)
        }
        XCTAssertTrue(transport.requests.isEmpty, "nothing leaves an unpaired device")
    }

    func testAnIdThatIsNoSegmentIsRefusedBeforeAnythingIsSent() async throws {
        let (link, transport, _) = try await paired([.reply(200, "{}")])
        do { _ = try await link.agent("../waiting"); XCTFail("a path, not an id") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unusableID)
        }
        XCTAssertTrue(transport.requests.isEmpty)
    }


    private static func draft(_ name: String) throws -> HomeLink.AccessDraft {
        let kase = try XCTUnwrap(try cases().first { $0.name == name })
        return try decoded(HomeLink.AccessDraft.self, kase.answer)
    }

    private static func access(_ name: String) throws -> HomeLink.Access {
        try draft(name).access
    }

    func testATapWaitsForTheDraftTheHomeDrewAndOneIsInFlightAtATime() throws {
        let start = try Self.access("edit-draw.json")
        var editor = AccessEditing(target: .reader(Self.reader), access: start, expect: 1)
        XCTAssertNil(editor.tap(.hide(.custom)), "no tap before the home drew a draft")
        let draw = try XCTUnwrap(editor.draw())
        guard case .edit(let drawn) = draw.request else { return XCTFail("a draft drawn") }
        XCTAssertEqual(drawn, .init(target: .reader(Self.reader), access: start, expect: 1, edit: nil))
        XCTAssertNil(editor.draw(), "drawn once")
        XCTAssertTrue(editor.land(draw.id, try Self.draft("edit-draw.json")))

        let first = try XCTUnwrap(editor.tap(.window(.past(ms: 2_592_000_000))))
        XCTAssertNil(editor.tap(.hide(.custom)), "a second tap while the first is on its way is not sent")
        XCTAssertNil(editor.save(), "nor a save")
        let landed = try Self.draft("edit-window.json")
        XCTAssertTrue(editor.land(first.id, landed))
        let second = try XCTUnwrap(editor.tap(.hide(.custom)))
        guard case .edit(let tapped) = second.request else { return XCTFail("a tap") }
        XCTAssertEqual(tapped.access, landed.access, "the next tap starts from the draft the home answered")
        XCTAssertEqual(tapped.expect, landed.expect)
    }

    func testAReplyForAnEditorClosedOrReplacedChangesNothing() throws {
        let start = try Self.access("edit-draw.json")
        var closed = AccessEditing(target: .reader(Self.reader), access: start, expect: 1)
        let late = try XCTUnwrap(closed.draw())
        var open = AccessEditing(target: .reader(Self.reader), access: start, expect: 1)
        let drawing = try XCTUnwrap(open.draw())
        XCTAssertFalse(open.land(late.id, try Self.draft("edit-type-on.json")), "the closed editor's reply")
        XCTAssertNil(open.draft)
        XCTAssertEqual(open.sending, drawing, "the open editor still waits on its own")
        open.fail(late.id, LinkFailure.noAnswer(sent: false))
        XCTAssertNil(open.trouble, "nor does its failure")
    }

    func testAFailureKeepsTheLastAnsweredDraftAndSaysWhy() throws {
        var editor = AccessEditing(target: .request(Self.ask), access: try Self.access("edit-ask.json"), expect: 1)
        let draw = try XCTUnwrap(editor.draw())
        let drawn = try Self.draft("edit-ask.json")
        editor.land(draw.id, drawn)

        let lost = try XCTUnwrap(editor.tap(.type("health", on: true)))
        editor.fail(lost.id, LinkFailure.noAnswer(sent: false))
        XCTAssertEqual(editor.trouble, .unreachable)
        XCTAssertEqual(editor.draft, drawn, "the home unreached: the last answered draft stands")

        let stale = try XCTUnwrap(editor.tap(.type("health", on: true)), "tapped again")
        XCTAssertNil(editor.trouble)
        editor.fail(stale.id, LinkFailure.refused(status: 409, code: "ACCESS_CHANGED", message: "This access changed since it was drawn: read it again."))
        XCTAssertEqual(editor.trouble, .changed("This access changed since it was drawn: read it again."),
                       "a 409 is the access written since, never the home unreached")
        XCTAssertEqual(editor.draft?.expect, drawn.expect, "no version copied onto the old draft")

        let words = "Chat hides nothing of its own: each conversation keeps the level picked on its composer."
        let refused = try XCTUnwrap(editor.tap(.hide(.all)))
        editor.fail(refused.id, LinkFailure.refused(status: 422, code: "BAD_REQUEST", message: words))
        XCTAssertEqual(editor.trouble, .refused(words))
    }

    func testSettingsSavesOnlyTheAnsweredDraftWithItsVersion() throws {
        var editor = AccessEditing(target: .reader(Self.reader), access: try Self.access("edit-draw.json"), expect: 1)
        XCTAssertNil(editor.save(), "nothing drawn, nothing saved")
        let draw = try XCTUnwrap(editor.draw())
        editor.land(draw.id, try Self.draft("edit-draw.json"))
        let tap = try XCTUnwrap(editor.tap(.hide(.custom)))
        XCTAssertNil(editor.save(), "a tap the home has not answered is never saved")
        let tapped = try Self.draft("edit-hide.json")
        editor.land(tap.id, tapped)
        let save = try XCTUnwrap(editor.save())
        XCTAssertEqual(save.request, .save(reader: Self.reader, tapped.access, expect: try XCTUnwrap(tapped.expect)))

        var signIn = AccessEditing(target: .request("c2lnbi1pbi0wMDAwMDAwMQ"), access: try Self.access("edit-sign-in.json"), expect: nil)
        let drawnSignIn = try XCTUnwrap(signIn.draw())
        signIn.land(drawnSignIn.id, try Self.draft("edit-sign-in.json"))
        XCTAssertNil(signIn.save(), "a sign-in's draft goes with its number, never saved here")
    }

    func testAnEditorsRequestGoesToItsRoute() async throws {
        let drawn = try Self.canonical(try XCTUnwrap(try Self.cases().first { $0.name == "edit-draw.json" }).answer)
        let (link, transport, _) = try await paired([.reply(200, drawn), .reply(200, drawn)])
        var editor = AccessEditing(target: .reader(Self.reader), access: try Self.access("edit-draw.json"), expect: 1)
        let draw = try XCTUnwrap(editor.draw())
        editor.land(draw.id, try await link.send(draw))
        let save = try XCTUnwrap(editor.save())
        _ = try await link.send(save)
        XCTAssertEqual(transport.requests.map { $0.method + " " + $0.url.path }, ["POST /v1/agents/edit", "POST /v1/agents/\(Self.reader)/access"])
    }
}
