import Foundation
import XCTest
@testable import HomeLink

final class ProcessingTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)
    private let home = "https://lifestream.example.ts.net"

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


    private static let part: [String: Any] = [
        "rows": [
            ["member": "llm.photos", "shape": "running", "line": "46,740 photos left · about 3 days · about $89", "privacy": NSNull(), "later": 1],
            ["member": "llm.voice", "shape": "needs", "line": "Connect a model that takes audio", "privacy": NSNull()],
            ["member": "llm.chats", "shape": "off", "line": NSNull(), "privacy": NSNull()],
            ["member": "llm.range", "shape": NSNull(), "line": NSNull(), "privacy": NSNull()],
        ],
    ]

    private static let members: [[String: Any]] = [
        ["key": "llm.photos", "kind": "choice", "label": "Photo descriptions", "about": NSNull(),
         "value": "runner:runner-macbook-pro-0001/qwen3.5-4b", "words": "Qwen 3.5 · MacBook Pro", "from": "person",
         "default": NSNull(), "panel": NSNull(), "control": NSNull(), "where": NSNull(),
         "steps": [["value": "off", "words": "Off", "note": NSNull()],
                   ["value": "default", "words": "Default", "note": "Gemini 3.8 Flash"],
                   ["value": "runner:runner-macbook-pro-0001/qwen3.5-4b", "words": "Qwen 3.5 · MacBook Pro", "note": "Stays on MacBook Pro"],
                   ["value": "openrouter:google/gemini-3.8-flash", "words": "Gemini 3.8 Flash", "note": "Sent to OpenRouter"],
                   ["value": "claude:claude-haiku-5-5", "words": "Claude Haiku 5.5", "note": "Sent to Anthropic"]]],
        ["key": "llm.voice", "kind": "choice", "label": "Voice note transcripts", "about": NSNull(), "value": "default",
         "words": "No model yet", "from": "declaration", "default": NSNull(), "panel": NSNull(), "control": NSNull(), "where": NSNull(),
         "steps": [["value": "off", "words": "Off", "note": NSNull()], ["value": "default", "words": "Default", "note": "No model yet"]]],
        ["key": "llm.chats", "kind": "choice", "label": "Chat summaries", "about": NSNull(), "value": "off", "words": "Off",
         "from": "person", "default": NSNull(), "panel": NSNull(), "control": NSNull(), "where": NSNull(),
         "steps": [["value": "off", "words": "Off", "note": NSNull()], ["value": "default", "words": "Default", "note": "GPT-6 Luna"]]],
        ["key": "llm.range", "kind": "choice", "label": "Range", "about": NSNull(), "value": NSNull(),
         "words": "Back to 11 Oct 2026", "from": "unset", "default": NSNull(), "panel": NSNull(), "control": NSNull(), "where": NSNull(),
         "steps": [["value": "2026-11-10", "words": "New only", "note": "0 photos"],
                   ["value": "2026-10-11", "words": "Last 30 days", "note": "2,452 photos · about $7"],
                   ["value": "all", "words": "All time", "note": "46,740 photos · about $89"]]],
    ]

    private func report() throws -> (bytes: Data, index: Int) {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: ReportTests.fixture)) as? [String: Any])
        var connectors = try XCTUnwrap(object["connectors"] as? [[String: Any]])
        let index = try XCTUnwrap(connectors.firstIndex { $0["id"] as? String == "whatsapp" })
        for at in connectors.indices {
            connectors[at]["processing"] = NSNull()
            connectors[at]["backfill_about"] = NSNull()
        }
        connectors[index]["processing"] = Self.part
        connectors[index]["backfill_about"] = "Reads your chats from before you connected, a batch at a time."
        let own = (connectors[index]["members"] as? [[String: Any]] ?? []).filter { !(($0["key"] as? String)?.hasPrefix("llm.") ?? false) }
        connectors[index]["members"] = own + Self.members
        object["connectors"] = connectors
        return (try JSONSerialization.data(withJSONObject: object), index)
    }

    func testAStreamsPartReadsItsWorksInOrderBesideTheirMembers() throws {
        let (bytes, index) = try report()
        let report = try JSONDecoder().decode(HomeLink.StreamsReport.self, from: bytes)
        let whatsapp = report.connectors[index]
        let part = try XCTUnwrap(whatsapp.processing)
        XCTAssertEqual(part.rows.map(\.member), ["llm.photos", "llm.voice", "llm.chats", "llm.range"], "the home's order, the range last")
        XCTAssertEqual(part.rows.map(\.shape), [.running, .needs, .off, nil])
        XCTAssertEqual(part.rows.map(\.line), ["46,740 photos left · about 3 days · about $89", "Connect a model that takes audio", nil, nil],
                       "a count, a time and a cost; the home's words for what is needed; none while off, nor on the range")
        XCTAssertEqual(whatsapp.backfillAbout, "Reads your chats from before you connected, a batch at a time.")

        let named = Set(part.rows.map(\.member))
        let members = whatsapp.members.filter { named.contains($0.key) }
        XCTAssertEqual(members.map(\.key), ["llm.photos", "llm.voice", "llm.chats", "llm.range"])
        XCTAssertTrue(members.allSatisfy { $0.panel == nil }, "no panel the phone draws")
        XCTAssertEqual(members[0].words, "Qwen 3.5 · MacBook Pro")
        XCTAssertEqual(members[0].steps?.map(\.note), [nil, "Gemini 3.8 Flash", "Stays on MacBook Pro", "Sent to OpenRouter", "Sent to Anthropic"])
        XCTAssertEqual(members[3].steps?.map(\.note), ["0 photos", "2,452 photos · about $7", "46,740 photos · about $89"],
                       "what each step of the range would read, and cost")

        XCTAssertTrue(report.connectors.enumerated().allSatisfy { $0.offset == index || ($0.element.processing == nil && $0.element.backfillAbout == nil) })
        var drift: [String] = []
        Strict.walk(report, try JSONSerialization.jsonObject(with: bytes), at: "report", drift: &drift)
        XCTAssertEqual(drift, ["report.connectors[\(index)].processing.rows[0].later: unknown"],
                       "every member of the part read under its own name, and only the one the home adds later left out")
    }

    func testTheHomesReportReadsTheDeclaringStreamsPartsAndNoneOnEveryOtherStream() throws {
        let fixture = try JSONDecoder().decode(HomeLink.StreamsReport.self, from: Data(contentsOf: ReportTests.fixture))
        let declaring = fixture.connectors.filter { $0.processing != nil }
        XCTAssertEqual(declaring.map(\.id), ["whatsapp", "screen", "google-photos"], "WhatsApp, Screen and Google Photos declare works, in the page's order; every other stream's part is null")
        let whatsapp = try XCTUnwrap(declaring.first { $0.id == "whatsapp" })
        let part = try XCTUnwrap(whatsapp.processing)
        XCTAssertEqual(part.rows.map(\.member), ["llm.photos", "llm.voice", "llm.range"], "the declaration's order, the range last")
        XCTAssertEqual(part.rows.last?.shape, nil, "the range's row has no shape")
        let named = Set(part.rows.map(\.member))
        XCTAssertEqual(whatsapp.members.filter { named.contains($0.key) }.map(\.panel), [nil, nil, nil], "its members, on no panel")
        let (bytes, _) = try report()
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        object["connectors"] = (object["connectors"] as? [[String: Any]] ?? []).map { $0.merging(["processing": NSNull()]) { $1 } }
        let nulled = try JSONDecoder().decode(HomeLink.StreamsReport.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertTrue(nulled.connectors.allSatisfy { $0.processing == nil }, "null, as a connector that declares no work")
    }

    func testARowOfAShapeNotKnownIsNoRowTheHomeWrites() {
        let row = #"{"member":"llm.photos","shape":"paused","line":"Paused"}"#
        XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.Connector.Processing.Row.self, from: Data(row.utf8)))
    }


    private static let older = #"{"by":null,"at_ms":null,"state":"off","line":"Older than this stream's range","ask":{"family":"photos","item":"photo:abab","prompt":"caption"},"choose":[{"value":"runner:runner-macbook-pro-0001/qwen3.5-4b","words":"Qwen 3.5","note":"Stays on MacBook Pro"}]}"#
    private static let voice = #"{"by":null,"at_ms":null,"state":"off","line":"Older than this stream's range","ask":{"family":"voice","item":"voice:voice-2026-10-14","prompt":"transcript"},"choose":[{"value":"openrouter:google/gemini-3.8-flash","words":"Gemini 3.8 Flash","note":"Sent to OpenRouter"}]}"#
    private static let done = #"{"by":"Qwen 3.5","at_ms":1792000000000,"state":"done","line":"Qwen 3.5 · 13 Oct","ask":{"family":"photos","item":"photo:abab","prompt":"caption"},"choose":[{"value":"openrouter:google/gemini-3.8-flash","words":"Gemini 3.8 Flash","note":"Sent to OpenRouter"},{"value":"codex:gpt-6-luna","words":"GPT-6 Luna · ChatGPT plan","note":"Sent to OpenAI"}],"later":1}"#

    func testWhatAModelMadeOfAPhotoReadsBesideItsCaption() async throws {
        var library = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Answers.libraryPhoto.utf8)) as? [String: Any])
        var photo = try XCTUnwrap(library["photo"] as? [String: Any])
        photo["described"] = try JSONSerialization.jsonObject(with: Data(Self.done.utf8))
        library["photo"] = photo
        var none = photo
        none["caption"] = NSNull()
        none["described"] = try JSONSerialization.jsonObject(with: Data(Self.older.utf8))
        let (link, _, _) = try await paired([
            .reply(200, String(decoding: try JSONSerialization.data(withJSONObject: library), as: UTF8.self)),
            .reply(200, String(decoding: try JSONSerialization.data(withJSONObject: ["photo": none]), as: UTF8.self)),
            .reply(200, Answers.chatImage),
        ])
        let hash = "sha256:" + String(repeating: "ab", count: 32)

        let described = try await link.photo(hash)
        XCTAssertEqual(described.caption, "Two friends on a terrace at sunset.", "the caption stays as it is")
        let made = try XCTUnwrap(described.described)
        XCTAssertEqual(made.by, "Qwen 3.5")
        XCTAssertEqual(made.atMs, 1_792_000_000_000)
        XCTAssertEqual(made.state, .done)
        XCTAssertEqual(made.line, "Qwen 3.5 · 13 Oct", "answered: the home's line, drawn as it is")
        XCTAssertEqual(made.ask, .init(family: "photos", item: "photo:abab", prompt: "caption"))
        XCTAssertEqual(made.choose.map(\.value), ["openrouter:google/gemini-3.8-flash", "codex:gpt-6-luna"])
        XCTAssertEqual(made.choose.map(\.note), ["Sent to OpenRouter", "Sent to OpenAI"])

        let unanswered = try await link.photo(hash)
        XCTAssertNil(unanswered.caption)
        let older = try XCTUnwrap(unanswered.described)
        XCTAssertEqual([older.by, older.line], [nil, "Older than this stream's range"])
        XCTAssertNil(older.atMs)
        XCTAssertEqual(older.state, .off)
        XCTAssertEqual(older.choose, [.init(value: "runner:runner-macbook-pro-0001/qwen3.5-4b", words: "Qwen 3.5",
                                              note: "Stays on MacBook Pro")], "the one step Describe now takes")

        let image = try await link.photo("sha256:" + String(repeating: "cd", count: 32))
        XCTAssertNil(image.described, "a read with none: nothing asked of it")
    }

    func testAVoiceNotesTranscriptReadsOnItsRecordAndOnItsConversationsPartByItsBlob() async throws {
        let made = try JSONSerialization.jsonObject(with: Data(Self.voice.utf8))
        var recording = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Answers.record.utf8)) as? [String: Any])
        recording["kind"] = "voice"
        recording["transcribed"] = made
        let note = "sha256:" + String(repeating: "ef", count: 32)
        let conversation: [String: Any] = [
            "position": "0:9", "chat": "+15550000001", "day": "2026-10-14", "zone": "UTC", "day_start_hour": 4,
            "window": ["start_ms": 1_792_022_400_000, "end_ms": 1_792_108_800_000], "title": "Person A", "atoms": [Any](),
            "messages": [["id": "m157"], ["id": "m158", "parts": [["blob": "sha256:" + String(repeating: "ab", count: 32)]]],
                         ["id": "m159", "parts": [["blob": note, "transcribed": made, "later": 1]]]],
        ]
        let (link, _, _) = try await paired([
            .reply(200, String(decoding: try JSONSerialization.data(withJSONObject: recording), as: UTF8.self)),
            .reply(200, Answers.record),
            .reply(200, String(decoding: try JSONSerialization.data(withJSONObject: conversation), as: UTF8.self)),
        ])

        let voice = try await link.record(source: "voice:local:phone-aa01", kind: "voice", key: "voice-2026-10-14")
        XCTAssertEqual(voice.transcribed?.state, .off)
        XCTAssertEqual(voice.transcribed?.line, "Older than this stream's range")
        XCTAssertEqual(voice.transcribed?.ask, .init(family: "voice", item: "voice:voice-2026-10-14", prompt: "transcript"))
        XCTAssertEqual(voice.transcribed?.choose.count, 1, "the one step Transcribe now takes")
        let message = try await link.record(source: "whatsapp:15550000000:phone-aa01", kind: "msg", key: "m157")
        XCTAssertNil(message.transcribed, "a record that is no recording carries none")

        let chat = try await link.conversation(chat: "+15550000001", day: "2026-10-14")
        XCTAssertEqual(chat.messages.map(\.parts.count), [0, 1, 1], "a message of words alone has no parts")
        XCTAssertEqual(Array(chat.transcripts.keys), [note], "a picture's part carries none; a voice note's, by its blob")
        XCTAssertEqual(chat.transcripts[note], voice.transcribed)
    }

    func testEveryItemsMadeAsTheHomeWritesItReadsWholeAndExactly() throws {
        let url = ReportTests.fixture.deletingLastPathComponent().appendingPathComponent("made.json")
        let bytes = try Data(contentsOf: url)
        let items = try JSONDecoder().decode([String: HomeLink.Made].self, from: bytes)
        let written = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(Set(items.keys), Set(written.keys))
        XCTAssertEqual(items["done"]?.state, .done)
        XCTAssertEqual(items["queued"]?.choose.count, 1, "an item with no answer: the one step its route would take")
        XCTAssertNil(items["none"]?.ask, "nothing asked of it")
        var drift: [String] = []
        for key in written.keys.sorted() { Strict.walk(items[key]!, written[key]!, at: key, drift: &drift) }
        XCTAssertEqual(drift, [], "every member of every item read under its own name, each value as written")
    }

    func testAnAnsweredMadeWithTwoStepsAndOneWithNoneDecodeAsWritten() throws {
        let made = try JSONDecoder().decode(HomeLink.Made.self, from: Data(Self.done.utf8))
        XCTAssertEqual(made.choose.map(\.words), ["Gemini 3.8 Flash", "GPT-6 Luna · ChatGPT plan"])
        let needs = try JSONDecoder().decode(HomeLink.Made.self, from: Data(
            #"{"by":null,"at_ms":null,"state":"needs","line":"Connect a model that takes audio","ask":null,"choose":[]}"#.utf8))
        XCTAssertEqual(needs.state, .needs)
        XCTAssertNil(needs.ask, "nothing asked of it")
        XCTAssertTrue(needs.choose.isEmpty, "no model ready: nothing to choose")
        XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.Made.self, from: Data(
            #"{"by":null,"at_ms":null,"state":"thinking","line":null,"ask":null,"choose":[]}"#.utf8)), "a state the spec does not write")
    }


    func testAChoiceIsSentOnItsRouteWithThePassAndItsRefusalKeepsTheHomesWords() async throws {
        let (link, transport, pass) = try await paired([
            .reply(200, #"{"chosen":{"family":"photos","item":"photo:abab","prompt":"caption","route":"openrouter:google/gemini-3.8-flash"}}"#),
            .reply(422, #"{"code":"PROCESS_REFUSED","message":"That model isn't connected."}"#),
        ])
        let ask = HomeLink.Made.Ask(family: "photos", item: "photo:abab", prompt: "caption")
        try await link.process(ask, route: "openrouter:google/gemini-3.8-flash")
        let request = transport.requests[0]
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, home + "/v1/process")
        XCTAssertEqual(request.headers["Authorization"], "Bearer \(pass)")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        XCTAssertEqual(try Fixture.object(request) as NSDictionary,
                       ["family": "photos", "item": "photo:abab", "prompt": "caption", "route": "openrouter:google/gemini-3.8-flash"] as NSDictionary)

        do { try await link.process(ask, route: "runner:qwen3.5"); XCTFail("refused") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 422, code: "PROCESS_REFUSED", message: "That model isn't connected."))
            XCTAssertEqual(failure.description, "That model isn't connected.", "the home's words, as the phone shows them")
        }

        let unpaired = ScriptedTransport([.reply(200, #"{"chosen":true}"#)])
        let none = HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder, transport: unpaired)
        do { try await none.process(ask, route: "runner:qwen3.5"); XCTFail("unpaired") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unpaired)
        }
        XCTAssertTrue(unpaired.requests.isEmpty, "nothing leaves an unpaired device")
    }
}
