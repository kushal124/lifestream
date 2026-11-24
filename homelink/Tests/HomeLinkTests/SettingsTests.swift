import Foundation
import XCTest
@testable import HomeLink

final class SettingsTests: XCTestCase {
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

    private func paired(_ transport: any HomeTransport) async throws -> HomeLink {
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: home, account: Fixture.account)
        return HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport)
    }

    private var queueFile: URL { folder.appendingPathComponent("settings-queue.json") }

    private static let stated: [String: [String: HomeLink.JSON]] = [
        "location": ["precision": .string("battery")],
        "checkin": ["prompts": .bool(true), "bedtime": .string("23:30")],
    ]


    func testAnAnswersSettingsReadByConnectorWithTheirStartAndOneNamingNoneReadsAsNone() async throws {
        let settings = #"{"screen":{"refresh":"2s","ocr":"every","apps":[{"app":"com.example.vault","mode":"exclude"}],"start_ms":1790000000000},"#
            + #""location":{"precision":"battery","start_ms":null},"broken":3}"#
        let transport = ScriptedTransport([.reply(200, Fixture.answer(received: 0, imported: 0, settings: settings)),
                                           .reply(200, Fixture.answer(received: 0, imported: 0))])
        let link = try await paired(transport)
        let fresh = try await link.exchange()
        XCTAssertEqual(fresh.settings["screen"]?["refresh"], .string("2s"))
        XCTAssertEqual(fresh.settings["screen"]?["start_ms"], .number(1_790_000_000_000))
        XCTAssertEqual(fresh.settings["screen"]?["apps"], .array([.object(["app": .string("com.example.vault"), "mode": .string("exclude")])]))
        XCTAssertEqual(fresh.settings["location"]?["start_ms"], .null, "a start of all is null")
        XCTAssertEqual(fresh.settings["location"]?["precision"], .string("battery"))
        XCTAssertNil(fresh.settings["broken"], "a connector whose settings are no object is left out, the rest read")
        XCTAssertEqual(link.saved?.settings["location"]?["precision"], .string("battery"), "the saved answer keeps them")
        let older = try await link.exchange()
        XCTAssertEqual(older.settings, [:], "an answer whose settings name no connector has none")
    }

    func testAnExchangeStatesTheSettingsGivenAndOneGivenNoneStatesNone() async throws {
        let transport = ScriptedTransport([.reply(200, Fixture.answer(received: 0, imported: 0))])
        let link = try await paired(transport)
        _ = try await link.exchange()
        XCTAssertNil(try Fixture.object(transport.requests[0])["settings"], "none given is no member, never an empty object")
        _ = try await link.exchange(settings: Self.stated)
        let first = try XCTUnwrap(Fixture.object(transport.requests[1])["settings"] as? [String: [String: Any]])
        XCTAssertEqual(first["location"]?["precision"] as? String, "battery")
        XCTAssertEqual(first["checkin"]?["prompts"] as? Bool, true)
        XCTAssertEqual(first["checkin"]?["bedtime"] as? String, "23:30")
        _ = try await link.exchange(drained: true)
        XCTAssertNil(try Fixture.object(transport.requests[2])["settings"], "an exchange made for another reason states none: the home keeps the last")
        link.tell(grants: ["location": "on"])
        await fulfillment(of: [transport.reached(4)], timeout: 30)
        XCTAssertNil(try Fixture.object(transport.requests[3])["settings"], "tell's exchange stated an old copy, which may land after a newer one")
        _ = try await link.exchange(settings: ["location": ["precision": .string("precise")]])
        let changed = try XCTUnwrap(Fixture.object(transport.requests[4])["settings"] as? [String: [String: Any]])
        XCTAssertEqual(changed["location"]?["precision"] as? String, "precise")
        XCTAssertNil(changed["checkin"], "the settings given are the whole statement")
    }


    func testAChangeGoesOnItsRouteAndEachAnswerIsItsOutcome() async throws {
        let transport = ScriptedTransport([
            .reply(200, #"{"landed":{"connector":"location","member":"precision","value":"battery"}}"#),
            .reply(409, #"{"code":"CHANGED","message":"another value is set","value":"precise"}"#),
            .reply(403, #"{"code":"PRINCIPAL_SCOPE","message":"no"}"#),
            .reply(422, #"{"code":"SETTING_BAD","message":"out of bounds"}"#),
            .reply(403, #"{"code":"DEVICE_SCOPE","message":"no"}"#),
            .reply(503, #"{"code":"HOME_UNREACHABLE","message":"the door cannot reach its home"}"#),
            .reply(401, #"{"code":"PRINCIPAL_UNKNOWN","message":"no"}"#),
            .reply(409, #"{"code":"NOT_OFFERED","message":"no"}"#),
            .unreachable,
        ])
        let link = try await paired(transport)
        let taken = try await link.setSetting(connector: "location", member: "precision", value: .string("battery"), was: .string("precise"))
        XCTAssertEqual(taken, .taken(.string("battery")), "the value the home says landed")
        let request = transport.requests[0]
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, home + "/v1/settings")
        XCTAssertNotNil(request.headers["Authorization"])
        XCTAssertEqual(request.headers["Lifestream-Device"], "phone/1.4.0")
        let body = try Fixture.object(request)
        XCTAssertEqual(body["connector"] as? String, "location")
        XCTAssertEqual(body["member"] as? String, "precision")
        XCTAssertEqual(body["value"] as? String, "battery")
        XCTAssertEqual(body["was"] as? String, "precise")

        let changed = try await link.setSetting(connector: "gmail", member: "refresh", value: .string("30m"), was: nil)
        XCTAssertEqual(changed, .changed(.string("precise")), "the home's value comes back")
        XCTAssertFalse(try Fixture.object(transport.requests[1]).keys.contains("was"), "a was not known is left out, never null")
        for expected in [SettingOutcome.refused, .refused, .unreachable, .unreachable, .unreachable, .unreachable, .unreachable] {
            let outcome = try await link.setSetting(connector: "checkin", member: "prompts", value: .bool(true), was: .null)
            XCTAssertEqual(outcome, expected)
        }
        XCTAssertTrue(try Fixture.object(transport.requests[2]).keys.contains("was"), "a was the home said is null is sent as null")
    }

    func testAHomeSettingGoesAsOneKeyOnTheSettingsRouteAndEachAnswerIsItsOutcome() async throws {
        let transport = ScriptedTransport([
            .reply(200, "{}"),
            .reply(403, #"{"code":"PRINCIPAL_SCOPE","message":"door.port is set on the Mac Lifestream runs on"}"#),
            .reply(422, #"{"code":"BAD_REQUEST","message":"one setting"}"#),
            .reply(422, #"{"code":"SETTING_REFUSED","message":"out of bounds"}"#),
            .reply(503, #"{"code":"HOME_UNREACHABLE","message":"the door cannot reach its home"}"#),
            .unreachable,
        ])
        let link = try await paired(transport)
        let taken = try await link.setHomeSetting(key: "model.cap", value: .number(8))
        XCTAssertEqual(taken, .taken(.number(8)), "the home answers {} once the value is kept: the value sent landed")
        let request = transport.requests[0]
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, home + "/v1/settings")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        let body = try Fixture.object(request)
        XCTAssertEqual(Array(body.keys), ["model.cap"], "one key and nothing else, so no connector is named")
        XCTAssertEqual(body["model.cap"] as? Int, 8)
        for expected in [SettingOutcome.refused, .refused, .refused, .unreachable, .unreachable] {
            let outcome = try await link.setHomeSetting(key: "door.port", value: .number(4690))
            XCTAssertEqual(outcome, expected)
        }
    }

    func testAnUnpairedDeviceSetsNoHomeSetting() async throws {
        let transport = ScriptedTransport([])
        let link = HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder, transport: transport)
        do {
            _ = try await link.setHomeSetting(key: "model.cap", value: .number(8))
            XCTFail("unpaired")
        } catch LinkFailure.unpaired {}
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testAnOutcomeUnknownIsReachWordsAndTheChangeWaits() async throws {
        let unknown = #"{"code":"OUTCOME_UNKNOWN","message":"Lifestream didn't answer.","again":true,"began":false}"#
        let transport = ScriptedTransport([.reply(503, unknown), .reply(503, unknown)])
        let link = try await paired(transport)
        let queue = SettingsQueue(file: queueFile)
        try queue.enqueue(connector: "location", member: "precision", value: .string("battery"), was: .string("precise"))
        let heard = Heard()
        await queue.drain(through: link, merge: nil, heard: heard.hear)
        XCTAssertEqual(heard.sent.map(\.outcome), [.unknown(ReachWords.unknown)], "the device's words, never an unreachable home")
        XCTAssertEqual(transport.requests.count, 2, "sent once more, as the door allows, and no more")
        XCTAssertEqual(queue.changes.map(\.member), ["precision"], "the change waits for the next exchange")
    }

    func testABegunChangeIsStillSavingAndWaits() async throws {
        let begun = #"{"code":"OUTCOME_UNKNOWN","message":"Lifestream is still working on this.","again":true,"began":true}"#
        let unknown = #"{"code":"OUTCOME_UNKNOWN","message":"Lifestream didn't answer.","again":true,"began":false}"#
        let transport = ScriptedTransport([.reply(503, begun), .reply(503, unknown)])
        let link = try await paired(transport)
        let queue = SettingsQueue(file: queueFile)
        try queue.enqueue(connector: "location", member: "precision", value: .string("battery"), was: .string("precise"))
        let heard = Heard()
        await queue.drain(through: link, merge: nil, heard: heard.hear)
        XCTAssertEqual(heard.sent.map(\.outcome), [.saving], "began on any try is still saving, never didn't say")
        XCTAssertEqual(queue.changes.map(\.member), ["precision"], "the change waits for the next exchange")
    }

    func testAnUnpairedDeviceSendsNoChange() async throws {
        let transport = ScriptedTransport([])
        let link = HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder, transport: transport)
        do {
            _ = try await link.setSetting(connector: "location", member: "precision", value: .string("battery"), was: nil)
            XCTFail("unpaired")
        } catch LinkFailure.unpaired {}
        XCTAssertTrue(transport.requests.isEmpty)
    }


    private final class Heard: @unchecked Sendable {
        private let lock = NSLock()
        private var given: [SettingsQueue.Sent] = []
        var sent: [SettingsQueue.Sent] { lock.withLock { given } }
        var hear: @Sendable (SettingsQueue.Sent) async -> Void {
            { sent in self.lock.withLock { self.given.append(sent) } }
        }
    }

    private static let merge: SettingsQueue.Merge = { change, home in
        change.member == "apps" ? .array((home.array ?? []) + (change.value.array ?? []).filter { !(home.array ?? []).contains($0) }) : nil
    }

    func testTheQueueKeepsOneChangeAMemberOverTheFirstWasOnDiskOrTakesNone() throws {
        let queue = SettingsQueue(file: queueFile)
        try queue.enqueue(connector: "location", member: "precision", value: .string("battery"), was: .string("precise"))
        try queue.enqueue(connector: "checkin", member: "bedtime", value: .string("22:30"), was: .string("23:30"))
        try queue.enqueue(connector: "checkin", member: "bedtime", value: .string("00:00"), was: .string("22:30"))
        XCTAssertEqual(queue.changes, [
            .init(connector: "location", member: "precision", value: .string("battery"), was: .string("precise")),
            .init(connector: "checkin", member: "bedtime", value: .string("00:00"), was: .string("23:30")),
        ], "the second change of a member replaces the first in its place, over the home's value")
        XCTAssertEqual(SettingsQueue(file: queueFile).changes, queue.changes, "kept on disk")
        try queue.enqueue(connector: "location", member: "precision", value: .string("precise"), was: .string("battery"))
        XCTAssertEqual(queue.changes.map(\.member), ["bedtime"], "back at the home's value with nothing in flight: nothing to tell")
        try queue.enqueue(connector: "checkin", member: "prompts", value: .bool(true), was: nil)
        try queue.enqueue(connector: "checkin", member: "prompts", value: .bool(false), was: nil)
        XCTAssertEqual(queue.queued(connector: "checkin", member: "prompts"), .bool(false), "with no home value known, every change is told")
        XCTAssertNil(queue.queued(connector: "location", member: "precision"))
        let running = queue.overlay(["checkin": ["bedtime": .string("23:30"), "prompts": .bool(true)], "location": ["precision": .string("battery")]])
        XCTAssertEqual(running, ["checkin": ["bedtime": .string("00:00"), "prompts": .bool(false)], "location": ["precision": .string("battery")]],
                       "the device runs at what waits, over the answer")

        let blocked = folder.appendingPathComponent("blocked")
        try Data().write(to: blocked)
        let unwritable = SettingsQueue(file: blocked.appendingPathComponent("settings-queue.json"))
        XCTAssertThrowsError(try unwritable.enqueue(connector: "checkin", member: "prompts", value: .bool(true), was: .bool(false)),
                             "a change the file could not keep was taken")
        XCTAssertEqual(unwritable.changes, [], "and runs as if it would outlive the app")
    }

    func testADrainSendsInOrderEachMembersNewestAndStopsAtAnUnreachableHome() async throws {
        let transport = ScriptedTransport([.reply(200, "{}"), .unreachable])
        let link = try await paired(transport)
        let queue = SettingsQueue(file: queueFile)
        try queue.enqueue(connector: "location", member: "precision", value: .string("battery"), was: .string("precise"))
        try queue.enqueue(connector: "checkin", member: "prompts", value: .bool(true), was: .bool(false))
        try queue.enqueue(connector: "checkin", member: "bedtime", value: .string("22:00"), was: .string("23:30"))
        try queue.enqueue(connector: "location", member: "precision", value: .string("coarse"), was: .string("battery"))
        let heard = Heard()
        await queue.drain(through: link, merge: nil, heard: heard.hear)
        XCTAssertEqual(heard.sent.map(\.outcome), [.taken(nil), .unreachable], "the device did not hear each change sent")
        XCTAssertEqual(try Fixture.object(transport.requests[0])["value"] as? String, "coarse", "the member's newest, in the first's place")
        XCTAssertEqual(try Fixture.object(transport.requests[0])["was"] as? String, "precise", "over the first's was")
        XCTAssertEqual(try Fixture.object(transport.requests[1])["member"] as? String, "prompts", "then in the order they were made")
        XCTAssertEqual(try Fixture.object(transport.requests[2])["member"] as? String, "prompts",
                       "a setting no address answered sent once more, the home answering it again as the first time")
        XCTAssertEqual(transport.requests.count, 3, "nothing sent past an unreachable home")
        XCTAssertEqual(queue.changes.map(\.member), ["prompts", "bedtime"], "what was not taken waits")
        XCTAssertEqual(SettingsQueue(file: queueFile).changes.map(\.member), ["prompts", "bedtime"])

        let unpaired = HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder.appendingPathComponent("other"),
                                transport: ScriptedTransport([]))
        let none = Heard()
        await queue.drain(through: unpaired, merge: nil, heard: none.hear)
        XCTAssertEqual(none.sent.map(\.outcome), [.unreachable], "a link that sends nothing stops the drain")
        XCTAssertEqual(queue.changes.map(\.member), ["prompts", "bedtime"], "and keeps every change")
    }

    func testAChangedChangeGivesWayToTheHomesValueAndARefusedOneGoes() async throws {
        let transport = ScriptedTransport([.reply(409, #"{"code":"CHANGED","message":"m","value":"21:00"}"#),
                                           .reply(422, #"{"code":"SETTING_BAD","message":"m"}"#),
                                           .reply(409, #"{"code":"CHANGED","message":"m","value":"precise"}"#)])
        let link = try await paired(transport)
        let queue = SettingsQueue(file: queueFile)
        try queue.enqueue(connector: "checkin", member: "bedtime", value: .string("22:00"), was: .string("23:30"))
        try queue.enqueue(connector: "checkin", member: "prompts", value: .bool(true), was: .bool(false))
        try queue.enqueue(connector: "location", member: "precision", value: .string("battery"), was: .string("precise"))
        let heard = Heard()
        await queue.drain(through: link, merge: { _, _ in nil }, heard: heard.hear)
        XCTAssertEqual(heard.sent.map(\.outcome), [.changed(.string("21:00")), .refused, .changed(.string("precise"))],
                       "the device hears the home's value, and the refusal for its log")
        XCTAssertEqual(queue.changes, [], "with no merge, or none it answers, the home's value stands: none is sent again")
    }

    func testAMergeIsSentOverTheHomesValueOnceAndChangedAgainItWaitsMergedOverTheNewest() async throws {
        let vault: HomeLink.JSON = .object(["app": .string("com.example.vault"), "mode": .string("exclude")])
        let chat: HomeLink.JSON = .object(["app": .string("com.example.chat"), "mode": .string("activity")])
        let notes: HomeLink.JSON = .object(["app": .string("com.example.notes"), "mode": .string("exclude")])
        let transport = ScriptedTransport([.reply(409, #"{"code":"CHANGED","message":"m","value":[{"app":"com.example.chat","mode":"activity"}]}"#),
                                           .reply(200, "{}")])
        let link = try await paired(transport)
        let queue = SettingsQueue(file: queueFile)
        try queue.enqueue(connector: "screen", member: "apps", value: .array([vault]), was: .array([]))
        let heard = Heard()
        await queue.drain(through: link, merge: Self.merge, heard: heard.hear)
        XCTAssertEqual(heard.sent.map(\.outcome), [.changed(.array([chat])), .taken(nil)])
        let resent = try Fixture.object(transport.requests[1])
        XCTAssertEqual((resent["value"] as? [[String: String]])?.map { $0["app"] }, ["com.example.chat", "com.example.vault"], "the merge, sent at once")
        XCTAssertEqual((resent["was"] as? [[String: String]])?.map { $0["app"] }, ["com.example.chat"], "over the home's value")
        XCTAssertEqual(queue.changes, [])

        let twice = ScriptedTransport([.reply(409, #"{"code":"CHANGED","message":"m","value":[{"app":"com.example.chat","mode":"activity"}]}"#),
                                       .reply(409, #"{"code":"CHANGED","message":"m","value":[{"app":"com.example.chat","mode":"activity"},{"app":"com.example.notes","mode":"exclude"}]}"#)])
        let other = try await paired(twice)
        try queue.enqueue(connector: "screen", member: "apps", value: .array([vault]), was: .array([]))
        let again = Heard()
        await queue.drain(through: other, merge: Self.merge, heard: again.hear)
        XCTAssertEqual(again.sent.count, 2, "merged once a drain, never a loop")
        XCTAssertEqual(queue.changes, [.init(connector: "screen", member: "apps", value: .array([chat, notes, vault]), was: .array([chat, notes]))],
                       "changed again, it waited unmerged over the home's newest, so its next send would drop the other device's Never")

        let held = HeldTransport(ScriptedTransport([.reply(409, #"{"code":"CHANGED","message":"m","value":[{"app":"com.example.chat","mode":"activity"}]}"#),
                                                     .reply(200, "{}")]))
        let third = try await paired(held)
        let flying = SettingsQueue(file: folder.appendingPathComponent("flying.json"))
        try flying.enqueue(connector: "screen", member: "apps", value: .array([vault]), was: .array([]))
        let drained = Task { await flying.drain(through: third, merge: Self.merge, heard: { _ in }) }
        await fulfillment(of: [held.asked], timeout: 30)
        try flying.enqueue(connector: "screen", member: "apps", value: .array([vault, notes]), was: .array([]))
        held.answer()
        try await ended("the drain with its change made in flight", drained)
        let newer = try Fixture.object(held.scripted.requests[1])
        XCTAssertEqual((newer["value"] as? [[String: String]])?.map { $0["app"] }, ["com.example.chat", "com.example.vault", "com.example.notes"],
                       "the change made in flight was sent without the home's items")
        XCTAssertEqual(flying.changes, [])
    }

    func testAChangeMadeWhileItsMemberIsInFlightWaitsOverWhatTheHomeTook() async throws {
        let transport = HeldTransport(ScriptedTransport([.reply(200, "{}")]))
        let link = try await paired(transport)
        let queue = SettingsQueue(file: queueFile)
        try queue.enqueue(connector: "checkin", member: "bedtime", value: .string("22:00"), was: .string("23:30"))
        let heard = Heard()
        let drained = Task { await queue.drain(through: link, merge: nil, heard: heard.hear) }
        await fulfillment(of: [transport.asked], timeout: 30)
        try queue.enqueue(connector: "checkin", member: "bedtime", value: .string("21:30"), was: .string("23:30"))
        transport.answer()
        try await ended("the drain of the change in flight", drained)
        XCTAssertEqual(heard.sent.map(\.outcome), [.taken(nil)])
        XCTAssertEqual(queue.changes, [.init(connector: "checkin", member: "bedtime", value: .string("21:30"), was: .string("22:00"))],
                       "the newer change waits, made over the value the home now holds")
    }

    func testAChangeBackMadeInFlightIsKeptOverWhatTheHomeTookAndGoesWhereTheHomeHoldsIt() async throws {
        let taking = HeldTransport(ScriptedTransport([.reply(200, "{}")]))
        let link = try await paired(taking)
        let queue = SettingsQueue(file: queueFile)
        try queue.enqueue(connector: "location", member: "precision", value: .string("battery"), was: .string("precise"))
        let drained = Task { await queue.drain(through: link, merge: nil, heard: { _ in }) }
        await fulfillment(of: [taking.asked], timeout: 30)
        try queue.enqueue(connector: "location", member: "precision", value: .string("precise"), was: .string("precise"))
        XCTAssertEqual(queue.queued(connector: "location", member: "precision"), .string("precise"), "kept while the first flies")
        taking.answer()
        try await ended("the drain the home took", drained)
        XCTAssertEqual(queue.changes, [.init(connector: "location", member: "precision", value: .string("precise"), was: .string("battery"))],
                       "the change back, over the value the home took")

        let refusing = HeldTransport(ScriptedTransport([.reply(422, #"{"code":"SETTING_BAD","message":"m"}"#)]))
        let other = try await paired(refusing)
        let second = SettingsQueue(file: folder.appendingPathComponent("second.json"))
        try second.enqueue(connector: "location", member: "precision", value: .string("battery"), was: .string("precise"))
        let refused = Task { await second.drain(through: other, merge: nil, heard: { _ in }) }
        await fulfillment(of: [refusing.asked], timeout: 30)
        try second.enqueue(connector: "location", member: "precision", value: .string("precise"), was: .string("precise"))
        refusing.answer()
        try await ended("the drain the home refused", refused)
        XCTAssertEqual(second.changes, [], "the home holds what the change back says")

        let changing = HeldTransport(ScriptedTransport([.reply(409, #"{"code":"CHANGED","message":"m","value":"battery"}"#)]))
        let third = try await paired(changing)
        let queued = SettingsQueue(file: folder.appendingPathComponent("third.json"))
        try queued.enqueue(connector: "checkin", member: "bedtime", value: .string("22:00"), was: .string("23:30"))
        let changed = Task { await queued.drain(through: third, merge: nil, heard: { _ in }) }
        await fulfillment(of: [changing.asked], timeout: 30)
        try queued.enqueue(connector: "checkin", member: "bedtime", value: .string("23:30"), was: .string("23:30"))
        changing.answer()
        try await ended("the drain the home changed", changed)
        XCTAssertEqual(queued.changes, [.init(connector: "checkin", member: "bedtime", value: .string("23:30"), was: .string("battery"))])
    }


    private final class Device: @unchecked Sendable {
        private let lock = NSLock()
        private var running: SettingsQueue.Settings
        private var steps: [String] = []
        let queue: SettingsQueue
        let name: String

        init(_ name: String, queue: SettingsQueue, running: SettingsQueue.Settings) {
            self.name = name
            self.queue = queue
            self.running = running
        }

        var noted: [String] { lock.withLock { steps } }

        func stated() -> SettingsQueue.Settings {
            lock.withLock {
                steps.append("\(name) stated")
                return running
            }
        }

        func apply(_ settings: SettingsQueue.Settings) {
            let over = queue.overlay(settings)
            lock.withLock {
                steps.append("\(name) applied \(over["location"]?["precision"]?.string ?? "-")")
                for (connector, members) in running {
                    for member in members.keys { if let value = over[connector]?[member] { running[connector]?[member] = value } }
                }
            }
        }
    }

    private static func answer(precision: String) -> String {
        Fixture.answer(received: 0, imported: 0, settings: #"{"location":{"precision":"\#(precision)"}}"#)
    }

    func testAnExchangeSendsWhatWaitsStatesWhatRunsAppliesTheAnswerAndStatesAgainOnlyWhenItChanged() async throws {
        let transport = ScriptedTransport([.reply(200, "{}"), .reply(200, Self.answer(precision: "battery"))])
        let link = try await paired(transport)
        let queue = SettingsQueue(file: queueFile)
        let device = Device("phone", queue: queue, running: ["location": ["precision": .string("precise")]])
        try queue.enqueue(connector: "checkin", member: "bedtime", value: .string("22:00"), was: .string("23:30"))
        let heard = Heard()
        _ = try await queue.exchange(through: link, heard: heard.hear, stated: { device.stated() }, apply: { device.apply($0) })
        XCTAssertEqual(transport.requests.map(\.url.path), ["/v1/settings", "/v1/exchange", "/v1/exchange"],
                       "what waits goes first, and an answer that changed what runs is stated again at once")
        XCTAssertEqual(heard.sent.map(\.outcome), [.taken(nil)])
        XCTAssertEqual((try Fixture.object(transport.requests[1])["settings"] as? [String: [String: String]])?["location"]?["precision"], "precise")
        XCTAssertEqual((try Fixture.object(transport.requests[2])["settings"] as? [String: [String: String]])?["location"]?["precision"], "battery",
                       "the second exchange stated what ran before the answer")
        XCTAssertEqual(device.noted, ["phone stated", "phone applied battery", "phone stated", "phone applied battery"])

        try queue.enqueue(connector: "checkin", member: "prompts", value: .bool(true), was: .bool(false))
        _ = try await queue.exchange(through: link, drain: false, stated: { device.stated() }, apply: { device.apply($0) })
        XCTAssertEqual(transport.requests.map(\.url.path).dropFirst(3), ["/v1/exchange"], "a knock at a silent home sent what waits first")
        XCTAssertEqual(queue.changes.map(\.member), ["prompts"])
    }

    func testAnExchangeAskedWhileOneRunsWaitsForItSoAnOlderAnswerIsNeverAppliedLast() async throws {
        let held = HeldTransport(ScriptedTransport([.reply(200, Self.answer(precision: "battery")),
                                                     .reply(200, Self.answer(precision: "coarse"))]))
        let link = try await paired(held)
        let queue = SettingsQueue(file: queueFile)
        let device = Device("mac", queue: queue, running: ["location": ["precision": .string("battery")]])
        let run = Task { try await queue.exchange(through: link, stated: { device.stated() }, apply: { device.apply($0) }) }
        await fulfillment(of: [held.asked], timeout: 30)
        let knock = Task { try await queue.exchange(through: link, stated: { device.stated() }, apply: { device.apply($0) }) }
        held.answer()
        _ = try await ended("the running exchange", run)
        _ = try await ended("the knock's exchange", knock)
        XCTAssertEqual(device.noted, ["mac stated", "mac applied battery", "mac stated",
                                      "mac stated", "mac applied coarse", "mac stated", "mac applied coarse"],
                       "the knock's exchange ran inside the run's, or the run's older answer was applied after it")
    }


    func testAStreamIsTurnedOffPausedAndResumedOnItsRouteAndNothingComesBack() async throws {
        let transport = ScriptedTransport([.reply(200, "{}"), .reply(200, "{}"), .reply(200, "{}"), .reply(200, "{}"), .reply(200, "{}"),
                                           .reply(403, #"{"code":"PRINCIPAL_SCOPE","message":"the home's own"}"#),
                                           .reply(503, #"{"code":"NOT_NOW","message":"Your home is starting."}"#, ["Retry-After": "5"])])
        let link = try await paired(transport)
        try await link.change(stream: "gmail", .turnOff)
        try await link.change(stream: "gmail", .pause)
        try await link.change(stream: "gmail", .resume)
        try await link.change(stream: "gmail", .pauseHistory)
        try await link.change(stream: "gmail", .resumeHistory)
        XCTAssertEqual(transport.requests.map(\.method), Array(repeating: "POST", count: 5))
        XCTAssertEqual(transport.requests.map(\.url.absoluteString), Array(repeating: home + "/v1/connectors/gmail", count: 5))
        XCTAssertEqual(try transport.requests.map { try Fixture.object($0) as NSDictionary },
                       [["on": false], ["paused": true], ["paused": false], ["paused": true, "history": true], ["paused": false, "history": true]])
        do {
            try await link.change(stream: "location", .pause)
            XCTFail("refused")
        } catch LinkFailure.refused(let status, let code, _) {
            XCTAssertEqual([String(status), code], ["403", "PRINCIPAL_SCOPE"])
        }
        do {
            try await link.change(stream: "gmail", .pause)
            XCTFail("no home")
        } catch LinkFailure.unavailable(let code, _, _, _) {
            XCTAssertEqual(code, "NOT_NOW")
        }
    }
}
