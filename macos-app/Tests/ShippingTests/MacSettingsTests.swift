import Evidence
import DeviceFiles
import Foundation
import HomeLink
import XCTest
@testable import Shipping

final class MacSettingsTests: XCTestCase {
    private typealias JSON = HomeLink.JSON
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("mac-settings-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: folder)
    }

    private var file: URL { folder.appendingPathComponent(MacSettings.fileName) }

    private static let launch: MacSettings.Values = ["screen": ["refresh": .string("2s"), "ocr": .string("exact"),
                                                                "apps": AppsField.of(.defaults)]]

    private static func apps(_ items: [(String, String)]) -> JSON {
        .array(items.map { target, mode in
            let (kind, id) = target.hasPrefix("site:") ? ("site", String(target.dropFirst(5))) : ("app", String(target.dropFirst(4)))
            return .object([kind: .string(id), "mode": .string(mode)])
        })
    }

    private final class Home: @unchecked Sendable {
        private let lock = NSLock()
        private var _answer: @Sendable (MacSettings.Change) -> SettingOutcome
        let fake: FakeHome
        var link: HomeLink!
        var answer: @Sendable (MacSettings.Change) -> SettingOutcome {
            get { lock.withLock { _answer } }
            set { lock.withLock { _answer = newValue } }
        }

        init(_ answer: @escaping @Sendable (MacSettings.Change) -> SettingOutcome) {
            _answer = answer
            fake = FakeHome(sources: [], clock: { Date(timeIntervalSince1970: 1_790_000_000) })
            fake.settingAnswer = { [unowned self] body in
                switch self.answer(Self.change(body)) {
                case .taken: return (200, ["connector": body["connector"] ?? "", "member": body["member"] ?? ""])
                case .changed(let home): return (409, ["code": "CHANGED", "message": "changed elsewhere", "value": Self.object(home)])
                case .refused: return (422, ["code": "SETTING_VALUE", "message": "out of bounds"])
                case .saving: return (503, ["code": "OUTCOME_UNKNOWN", "message": "Lifestream is still working on this.", "again": true, "began": true])
                case .unknown(let words): return (503, ["code": "OUTCOME_UNKNOWN", "message": words, "again": false])
                case .unreachable: return (404, ["code": "ROUTE", "message": "no such route"])
                }
            }
        }

        static func home(_ folder: URL, _ answer: @escaping @Sendable (MacSettings.Change) -> SettingOutcome) async throws -> Home {
            let home = Home(answer)
            home.link = try await ShippingFixture.link(home.fake, folder: folder.appendingPathComponent("link-\(UUID().uuidString)"))
            return home
        }

        var sent: [MacSettings.Change] { fake.settingsSent.map(Self.change) }

        func gives(_ settings: MacSettings.Values) {
            let data = (try? JSONEncoder().encode(settings)) ?? Data("{}".utf8)
            fake.settings = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }

        var stated: [MacSettings.Values] {
            fake.requests.filter { $0.url.path == "/v1/exchange" }.compactMap { request in
                guard case .json(let body) = request.body,
                      let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                      let settings = object["settings"],
                      let data = try? JSONSerialization.data(withJSONObject: settings) else { return nil }
                return try? JSONDecoder().decode(MacSettings.Values.self, from: data)
            }
        }

        private static func change(_ body: [String: Any]) -> MacSettings.Change {
            MacSettings.Change(connector: body["connector"] as? String ?? "", member: body["member"] as? String ?? "",
                               value: json(body["value"]) ?? .null, was: json(body["was"]))
        }

        private static func json(_ any: Any?) -> HomeLink.JSON? {
            guard let any, !(any is NSNull), let data = try? JSONSerialization.data(withJSONObject: [any]) else { return nil }
            return (try? JSONDecoder().decode([HomeLink.JSON].self, from: data))?.first
        }

        private static func object(_ value: HomeLink.JSON) -> Any {
            let data = (try? JSONEncoder().encode([value])) ?? Data("[null]".utf8)
            return ((try? JSONSerialization.jsonObject(with: data)) as? [Any])?.first ?? NSNull()
        }
    }

    func testBeforeAnyAnswerItRunsAtItsDefaultsAndEachAnswerIsTheWholeOfWhatTheHomeGives() async {
        let settings = MacSettings(file: DomainFixtures.settingsFile, defaults: Self.launch, files: DeviceFiles(.plain))
        XCTAssertEqual(settings.value("imessage", "refresh"), .string("5m"))
        XCTAssertEqual(settings.value("screen", "refresh"), .string("2s"))
        XCTAssertNil(settings.value("screen", "idle_pause"), "a launch with no idle timeout runs with none")
        XCTAssertEqual(settings.statement(), [:], "stated before the home gave anything")
        XCTAssertTrue(settings.local("screen", "ocr"), "Screen's own before any answer")
        XCTAssertFalse(settings.local("imessage", "refresh"), "a reader's before the home gave it")

        XCTAssertNil(settings.start(of: "imessage"), "a start before the home gave one")
        await settings.take(["whoop": ["refresh": .string("1h")]])
        await settings.take(["imessage": ["refresh": .string("10m"), "start_ms": .number(1_779_235_200_000)],
                             "machine": ["refresh": .string("5m"), "start_ms": .null],
                             "screen": ["refresh": .string("5s"), "ocr": .string("always"), "apps": .array([])]])
        XCTAssertEqual(settings.value("whoop", "refresh"), .string("5m"), "a connector the last answer no longer names kept the one before's")
        XCTAssertEqual(settings.statement(), ["imessage": ["refresh": .string("10m")],
                                              "machine": ["refresh": .string("5m")],
                                              "screen": ["refresh": .string("5s"), "ocr": .string("always"), "apps": .array([])]],
                       "a member not given (idle_pause) or not applied (start_ms) was stated")
        XCTAssertEqual(settings.start(of: "imessage"), Date(timeIntervalSince1970: 1_779_235_200), "the start is the UTC midnight the home gave")
        XCTAssertNil(settings.start(of: "machine"), "a start of all, null, read as a day")
        XCTAssertNil(settings.start(of: "screen"), "a start for a connector the home gave none")
        XCTAssertFalse(settings.local("screen", "idle_pause"), "a member the home does not give was set here")
    }

    func testAChangeRunsAtOnceSurvivesARestartAndReachesTheHomeWithWas() async throws {
        let given: MacSettings.Values = ["imessage": ["refresh": .string("5m")], "screen": ["refresh": .string("2s"), "ocr": .string("exact")]]
        let settings = MacSettings(file: file, defaults: Self.launch, files: DeviceFiles(.plain))
        await settings.take(given)
        let changes = Collected<String>()
        settings.changed = { changes.append($0) }

        XCTAssertTrue(try settings.set("screen", "refresh", to: .string("5s")))
        XCTAssertFalse(try settings.set("screen", "ocr", to: .string("sometimes")), "a value this Mac cannot run at")
        XCTAssertFalse(try settings.set("imessage", "refresh", to: .number(5)))
        XCTAssertTrue(try settings.set("imessage", "refresh", to: .string("1m")))
        XCTAssertTrue(try settings.set("imessage", "refresh", to: .string("5m")), "back to the home's value")
        XCTAssertEqual(settings.value("screen", "refresh"), .string("5s"), "not run at once")
        XCTAssertEqual(settings.queue.changes, [.init(connector: "screen", member: "refresh", value: .string("5s"), was: .string("2s"))],
                       "a change back to the home's value is owed")
        XCTAssertEqual(changes.all, [], "a change made here was applied twice: its caller applies it")
        await settings.apply()
        XCTAssertEqual(changes.all, ["screen"])

        await settings.take(["imessage": ["refresh": .string("5m")], "screen": ["refresh": .string("2s"), "ocr": .string("always")]])
        XCTAssertEqual(changes.all, ["screen", "screen"], "the home's change was not applied, or one that changed nothing was")
        await settings.take(given)
        XCTAssertEqual(changes.all.count, 3)

        let away = try await Home.home(folder) { _ in .unreachable }
        away.gives(given)
        _ = try await settings.exchange(through: away.link)
        XCTAssertEqual(away.stated.last?["screen"]?["refresh"], .string("5s"), "the exchange stated the home's value, not what runs")
        let restarted = MacSettings(file: file, defaults: Self.launch, files: DeviceFiles(.plain))
        XCTAssertEqual(restarted.value("screen", "refresh"), .string("5s"), "the change was lost at the restart")
        XCTAssertEqual(restarted.queue.changes.count, 1, "a home out of reach dropped the change")

        let home = try await Home.home(folder) { _ in .taken(nil) }
        home.gives(["imessage": ["refresh": .string("5m")], "screen": ["refresh": .string("5s"), "ocr": .string("exact")]])
        _ = try await restarted.exchange(through: home.link)
        XCTAssertEqual(home.sent, [.init(connector: "screen", member: "refresh", value: .string("5s"), was: .string("2s"))])
        XCTAssertEqual(restarted.queue.changes, [])
        XCTAssertEqual(restarted.value("screen", "refresh"), .string("5s"))
        XCTAssertEqual(MacSettings(file: file, files: DeviceFiles(.plain)).queue.changes, [], "a change taken was kept")
    }

    func testAChangeTheQueueCannotKeepThrowsAndNothingRuns() async throws {
        try FileManager.default.createDirectory(at: folder.appendingPathComponent(MacSettings.queueName), withIntermediateDirectories: true)
        let settings = MacSettings(file: file, defaults: Self.launch, files: DeviceFiles(.plain))
        await settings.take(["screen": ["refresh": .string("2s")]])
        XCTAssertThrowsError(try settings.set("screen", "refresh", to: .string("5s")))
        XCTAssertEqual(settings.value("screen", "refresh"), .string("2s"), "a change the queue did not keep runs")
        XCTAssertEqual(settings.queue.changes, [])
        XCTAssertThrowsError(try settings.seed("screen", "apps", local: Self.apps([("app:com.example.notes-fake", "exclude")])))
    }

    func testTheHomesOutcomesBecomeTheHomesValuesHereBeforeTheExchangeStates() async throws {
        let settings = MacSettings(file: DomainFixtures.settingsFile, defaults: Self.launch, files: DeviceFiles(.plain))
        await settings.take(["imessage": ["refresh": .string("5m"), "pace": .string("1h")], "screen": ["ocr": .string("exact")]])
        let changes = Collected<String>()
        settings.changed = { changes.append($0) }
        try settings.set("imessage", "refresh", to: .string("10m"))
        try settings.set("imessage", "pace", to: .string("2h"))
        try settings.set("screen", "ocr", to: .string("always"))
        await settings.apply()
        XCTAssertEqual(changes.all, ["imessage", "screen"])
        let home = try await Home.home(folder) { change in
            switch change.member {
            case "refresh": return .changed(.string("15m"))
            case "pace": return .refused
            default: return .taken(nil)
            }
        }
        home.gives(["imessage": ["refresh": .string("15m"), "pace": .string("1h")], "screen": ["ocr": .string("always")]])
        _ = try await settings.exchange(through: home.link)
        XCTAssertEqual(home.sent.map(\.member), ["refresh", "pace", "ocr"], "not in the order made")
        XCTAssertEqual(home.stated, [["imessage": ["refresh": .string("15m"), "pace": .string("1h")], "screen": ["ocr": .string("always")]]],
                       "what the home answered of a change was not its value here when the exchange stated")
        XCTAssertEqual(settings.queue.changes, [], "a CHANGED or a refusal was kept")
        XCTAssertEqual(settings.value("imessage", "refresh"), .string("15m"), "CHANGED kept this Mac's value")
        XCTAssertEqual(settings.value("imessage", "pace"), .string("1h"), "a refused value runs")
        XCTAssertEqual(settings.value("screen", "ocr"), .string("always"), "a value taken did not become the home's")
        XCTAssertEqual(changes.all, ["imessage", "screen", "imessage", "imessage"],
                       "what the home changed back (the refresh, then the pace) was not applied, or one it took was applied again")
    }

    func testScreensAppsMergeStricterWinsOnCHANGEDAndTheFirstContactSendsThemAgainstNone() async throws {
        let mine = Self.apps([("app:com.example.notes-fake", "exclude"), ("site:mybank.example.com", "activity")])
        let theirs = Self.apps([("app:com.example.notes-fake", "activity"), ("app:com.example.chat-fake", "exclude"), ("site:mybank.example.com", "exclude")])
        XCTAssertEqual(AppsField.merge(theirs, mine),
                       Self.apps([("app:com.example.chat-fake", "exclude"), ("app:com.example.notes-fake", "exclude"), ("site:mybank.example.com", "exclude")]))
        XCTAssertNotEqual(AppsField.of(.defaults).array?.contains { $0["app"]?.string == RecordingModes.ownApp }, true,
                          "the recorder's own app is in the field")

        let settings = MacSettings(file: file, defaults: Self.launch, files: DeviceFiles(.plain))
        await settings.take(["screen": ["apps": .array([])]])
        try settings.seed("screen", "apps", local: mine)
        XCTAssertEqual(settings.queue.changes, [.init(connector: "screen", member: "apps", value: mine, was: .array([]))],
                       "the first contact did not send this Mac's modes against none")
        let merged = AppsField.merge(theirs, mine)
        let home = try await Home.home(folder) { change in change.was == theirs ? .taken(nil) : .changed(theirs) }
        home.gives(["screen": ["apps": merged]])
        _ = try await settings.exchange(through: home.link)
        XCTAssertEqual(home.sent.map(\.was), [.array([]), theirs], "the merge was sent against other than the home's list")
        XCTAssertEqual(home.sent.last?.value, merged)
        XCTAssertEqual(settings.value("screen", "apps"), merged)
        XCTAssertEqual(settings.queue.changes, [])

        let never = Self.apps([("app:com.example.other-fake", "exclude")])
        try settings.set("screen", "apps", to: never)
        let list = { (n: Int) in Self.apps([("app:com.example.list-\(n)-fake", "exclude")]) }
        let counter = Collected<Int>()
        let busy = try await Home.home(folder) { _ in
            counter.append(1)
            return .changed(list(counter.count))
        }
        busy.gives(["screen": ["apps": list(2)]])
        _ = try await settings.exchange(through: busy.link)
        XCTAssertEqual(busy.sent.count, 2, "a refused list was sent without end, or not merged once")
        let kept = AppsField.merge(list(2), AppsField.merge(list(1), never))
        XCTAssertEqual(settings.queue.changes, [.init(connector: "screen", member: "apps", value: kept, was: list(2))],
                       "a list the home kept refusing was dropped, kept against an older list, or lost a Never the home held")
        XCTAssertEqual(busy.stated.last?["screen"]?["apps"], kept, "the exchange stated other than what runs")
        let running = AppsField.modes(settings.value("screen", "apps")!, current: .defaults)
        XCTAssertEqual(running?.mode(of: "com.example.other-fake"), .exclude, "the Never stopped running")
        XCTAssertEqual(running?.mode(of: "com.example.list-2-fake"), .exclude, "the home's newest Never was undone")
        busy.answer = { _ in .taken(nil) }
        busy.gives(["screen": ["apps": kept]])
        _ = try await settings.exchange(through: busy.link)
        XCTAssertEqual(busy.sent.last, .init(connector: "screen", member: "apps", value: kept, was: list(2)))
        XCTAssertEqual(settings.queue.changes, [])
        XCTAssertEqual(AppsField.modes(settings.value("screen", "apps")!, current: .defaults)?.mode(of: "com.example.other-fake"), .exclude)

        let next = MacSettings(file: file, defaults: Self.launch, files: DeviceFiles(.plain))
        try next.seed("screen", "apps", local: mine)
        XCTAssertEqual(next.queue.changes, [], "the first contact's modes were sent again at a launch")
        XCTAssertEqual(next.value("screen", "apps"), kept, "a launch ran at its own list over the home's")
    }

    func testTheFirstContactRunsAtWhatTheHomeHoldsFromItsFirstAnswerOn() async throws {
        let mine = Self.apps([("app:com.example.notes-fake", "exclude")])
        let theirs = Self.apps([("app:com.example.chat-fake", "exclude")])
        let merged = AppsField.merge(theirs, mine)
        let settings = MacSettings(file: file, defaults: Self.launch, files: DeviceFiles(.plain))
        try settings.seed("screen", "apps", local: mine)
        let seen = Collected<JSON?>()
        settings.changed = { connector in if connector == "screen" { seen.append(settings.value("screen", "apps")) } }
        let home = try await Home.home(folder) { change in change.was == theirs ? .taken(nil) : .changed(theirs) }
        home.gives(["screen": ["apps": merged]])
        _ = try await settings.exchange(through: home.link)
        XCTAssertEqual(home.sent.map(\.was), [.array([]), theirs])
        XCTAssertFalse(seen.all.isEmpty, "the home's list never ran")
        for value in seen.all {
            XCTAssertEqual(value.flatMap { AppsField.modes($0, current: .defaults) }?.mode(of: "com.example.chat-fake"), .exclude,
                           "the Mac ran at its built-in list once the home took the merge: what the home holds was dropped")
        }
        XCTAssertEqual(home.stated.first?["screen"]?["apps"], merged, "the exchange stated other than what the home holds")
        XCTAssertEqual(settings.value("screen", "apps"), merged)
    }

    func testOneAppsItemThisMacCannotRecordByIsDroppedAloneAndTheRestRuns() async throws {
        let settings = MacSettings(file: DomainFixtures.settingsFile, defaults: Self.launch, files: DeviceFiles(.plain))
        let good = Self.apps([("app:com.example.notes-fake", "exclude"), ("site:mybank.example.com", "exclude")])
        var items = good.array!
        items.insert(.object(["site": .string("not a site!"), "mode": .string("exclude")]), at: 1)
        items.append(.object(["app": .string("com.example.chat-fake"), "mode": .string("sometimes")]))
        items.append(.object(["app": .string(RecordingModes.ownApp), "mode": .string("exclude")]))
        items.append(.string("no item"))
        XCTAssertTrue(try settings.set("screen", "apps", to: .array(items)), "the whole list was refused for its bad items")
        XCTAssertEqual(settings.value("screen", "apps"), good, "an item this Mac cannot record by was kept")
        XCTAssertFalse(try settings.set("screen", "apps", to: .string("everything")), "a value that is no list was taken")
        let modes = try? XCTUnwrap(AppsField.modes(.array(items), current: .defaults))
        XCTAssertEqual(modes?.mode(of: "com.example.notes-fake"), .exclude, "the home's list with one bad item ran none of it")
    }

    func testWhatTheAnswerHandsIsWhatThisMacAppliesWhateverItsConnector() async throws {
        let settings = MacSettings(file: DomainFixtures.settingsFile, defaults: Self.launch, files: DeviceFiles(.plain))
        XCTAssertEqual(settings.applies("screen"), ["apps", "ocr", "refresh"], "Screen's own, built in, before any answer")
        XCTAssertEqual(settings.applies("example-store"), [], "a connector the home handed nothing of")
        await settings.take(["example-store": ["refresh": .string("10m"), "accounts": .array([.string("person-a@example.com")]),
                                               "start_ms": .number(1_779_235_200_000)],
                             "screen": ["idle_pause": .string("5m")]])
        XCTAssertEqual(settings.applies("example-store"), ["accounts", "refresh"], "a member the answer handed was not applied, or start_ms was")
        XCTAssertEqual(settings.applies("screen"), ["apps", "idle_pause", "ocr", "refresh"])
        XCTAssertTrue(settings.local("example-store", "accounts"))
        XCTAssertFalse(settings.local("example-store", "start_ms"), "the start is read here, never a member set here")
        XCTAssertFalse(settings.local("example-store", "pace"), "a member the home did not hand")
        XCTAssertTrue(try settings.set("example-store", "accounts", to: .array([])), "a handed member's value refused")
        XCTAssertEqual(settings.statement()["example-store"], ["refresh": .string("10m"), "accounts": .array([])],
                       "the statement is not what runs of every member handed")
    }

    func testARefreshIsNeverUnderAMinuteAndDurationsReadAsTheHomeWordsThem() async {
        XCTAssertEqual(MacSettings.seconds("2s"), 2)
        XCTAssertEqual(MacSettings.seconds("5m"), 300)
        XCTAssertEqual(MacSettings.seconds("1h"), 3600)
        XCTAssertEqual(MacSettings.seconds("1d"), 86400)
        for word in ["", "m", "5", "5x", "-1m", "0s", "inf s"] { XCTAssertNil(MacSettings.seconds(word), word) }
        XCTAssertEqual([2, 90, 300, 3600, 86400].map { MacSettings.words($0) }, ["2s", "90s", "5m", "1h", "1d"])
        let settings = MacSettings(file: DomainFixtures.settingsFile, files: DeviceFiles(.plain))
        await settings.take(["safari": ["refresh": .string("10s")], "chrome": ["refresh": .string("30m")]])
        XCTAssertEqual(settings.refresh(of: "safari"), MacSettings.leastRefresh)
        XCTAssertEqual(settings.refresh(of: "chrome"), 1800)
    }

    func testASourcesSettingsAreThoseOfTheConnectorThatDeclaresIt() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-settings-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let imessage = try XCTUnwrap(try StoreFixtures.all()["imessage"])
        let stores = try StoreFixtures.stores(home: root.appendingPathComponent("home", isDirectory: true),
                                              state: root.appendingPathComponent("state", isDirectory: true), declarations: [
                                                  "example-importer": HomeLink.DeclaredStore(app: nil, grants: [], product: "example-notes",
                                                                                             store: imessage.store),
                                                  "imessage": imessage])
        let notes = "example-notes:local:macbook-pro-0001"
        XCTAssertEqual(ShippingDomains.connector(of: notes, stores: stores), "example-importer")
        XCTAssertEqual(ShippingDomains.connector(of: "imessage:person-a@example.com:macbook-pro-0001", stores: stores), "imessage")
        XCTAssertEqual(ShippingDomains.connector(of: "screen:local:macbook-pro-0001", stores: stores), "screen", "a recorder's")
        XCTAssertEqual(ShippingDomains.connector(of: notes, stores: nil), "example-notes", "with no stores, the product")

        let settings = MacSettings(file: DomainFixtures.settingsFile, files: DeviceFiles(.plain))
        await settings.take(["example-importer": ["refresh": .string("2m"), "start_ms": .number(1_779_235_200_000)],
                             "example-notes": ["refresh": .string("1h"), "start_ms": .null]])
        let connector = ShippingDomains.connector(of: notes, stores: stores)
        XCTAssertEqual(settings.refresh(of: connector), 120)
        XCTAssertEqual(settings.start(of: connector), Date(timeIntervalSince1970: 1_779_235_200))
        XCTAssertNil(settings.start(of: "example-notes"), "the product's start, not the declaring connector's")
    }
}
