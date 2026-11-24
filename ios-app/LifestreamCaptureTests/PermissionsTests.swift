import Cockpit
import Foundation
import XCTest
@testable import Lifestream
@testable import LifestreamCaptureCore

@MainActor
final class PermissionsTests: XCTestCase {
    override func setUp() async throws { forget() }
    override func tearDown() async throws { forget() }

    private func forget() {
        AppRuntime.shared.firstRun.again()
        UserDefaults.standard.removeObject(forKey: UITestGrants.key)
    }

    func testTheGrantsFollowEachAnswerAndTheDiaryKeepsThemInTheOrderTold() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(root: root)
        let teller = Teller(diary: MachineDiary(store: store))
        let model = PermissionsModel(
            runtime: .shared,
            script: ["location": "while-using", "photos": "limited", "contacts": "off", "health": "on", "screen-time": "absent"],
            told: { teller.tell($0) })

        model.tell()
        XCTAssertTrue(teller.told.isEmpty, "nothing is told before the first read lands")
        await model.refresh()
        let notAsked = ["location": "not-asked", "motion": "not-asked", "health": "not-asked", "photos": "not-asked",
                        "contacts": "not-asked", "notifications": "not-asked"]
        XCTAssertEqual(model.grants, notAsked, "Screen Time, not in this build, is not stated")
        XCTAssertEqual(teller.told, [notAsked])

        await model.ask("location") {}
        XCTAssertEqual(teller.changes("location"), ["not-asked", "asking", "limited"], "asking while iOS asks, then While Using")

        AppRuntime.shared.firstRun.leave(PhoneSource.motion.rawValue)
        model.tell()
        XCTAssertEqual(teller.told.last?["motion"], "not-now", "a screen pressed past is told at once")

        for id in ["photos", "contacts", "health"] { await model.ask(id) {} }
        XCTAssertEqual(teller.changes("health"), ["not-asked", "asking", "on"], "Health's read returned samples: on")
        XCTAssertEqual(model.grants, ["location": "limited", "motion": "not-now", "health": "on", "photos": "limited",
                                      "contacts": "off", "notifications": "not-asked"],
                       "a grant with no screen stays not asked")

        await teller.written?.value
        let lines = try await store.entries(domain: .machine).map(\.payload)
        XCTAssertEqual(lines, [
            Self.line("state", Dictionary(uniqueKeysWithValues: notAsked.map { ("access_\($0.key)", $0.value) })),
            Self.line("access", ["grant": "location", "state": "limited"]),
            Self.line("access", ["grant": "motion", "state": "not-now"]),
            Self.line("access", ["grant": "photos", "state": "limited"]),
            Self.line("access", ["grant": "contacts", "state": "off"]),
            Self.line("access", ["grant": "health", "state": "on"]),
        ], "the diary's lines in the order told, asking never among them")
    }

    func testEachGrantIsSaidInTheHomesWordForItsStateAndOneNotCarriedNowhere() async throws {
        var asking: [String: String] = [:]
        var model: PermissionsModel?
        model = PermissionsModel(
            runtime: .shared,
            script: ["location": "while-using", "motion": "off", "health": "asked", "photos": "limited", "contacts": "limited",
                     "screen-time": "absent"],
            told: { grants in
                for (id, state) in grants where state == "asking" { asking[id] = model?.mark(of: id)?.word }
            })
        let permissions = try XCTUnwrap(model)
        await permissions.refresh()
        let word = { (id: String) in permissions.mark(of: id)?.word }
        XCTAssertEqual(word("photos"), "Not asked", "a screen never shown")
        AppRuntime.shared.firstRun.leave(PhoneSource.motion.rawValue)
        XCTAssertEqual(word("motion"), "Not now", "a screen pressed past")
        XCTAssertNil(word("screen-time"), "not in this build: said nowhere")
        XCTAssertFalse(PhoneSource.firstRun(permissions.rows).contains(.screenTime), "and no screen of the first run, nor a row of Done")

        for id in ["location", "motion", "health", "photos", "contacts"] { await permissions.ask(id) {} }
        XCTAssertEqual(asking, ["location": "Asking", "motion": "Asking", "health": "Asking", "photos": "Asking", "contacts": "Asking"],
                       "each ask open is Asking")
        XCTAssertEqual(word("location"), "While Using only")
        XCTAssertEqual(word("motion"), "Off")
        XCTAssertEqual(word("health"), "Asked", "Health, which never says what it allowed")
        XCTAssertEqual(word("photos"), "Selected photos", "a part allowed is said by its part")
        XCTAssertEqual(word("contacts"), "Some contacts")
        XCTAssertEqual(permissions.mark(of: "location")?.kind, .caution, "allowed in part needs the person")
        XCTAssertNil(permissions.mark(of: "health")?.kind, "asked: the word alone")

        UITestGrants.answer("photos", "on")
        await permissions.refresh()
        XCTAssertEqual(word("photos"), "On")
    }

    func testTheMarksSayTheStepOpenAndEachScreenPressedPast() async throws {
        UITestGrants.answer("location", "always")
        let permissions = PermissionsModel(runtime: .shared, script: ["screen-time": "absent"], told: nil)
        await permissions.refresh()
        let run = FirstRunModel(permissions: permissions, record: AppRuntime.shared.firstRun, paired: { false })
        XCTAssertEqual(run.streams, [.location, .motion, .health, .photos, .contacts], "no Screen Time where the build has none")
        run.begin()
        XCTAssertEqual(run.screen, .welcome)
        run.pass()
        XCTAssertEqual(run.screen, .pair)
        XCTAssertEqual(StepMarks.spoken(run.marks), "Step 1 of 6")
        run.pass()
        XCTAssertEqual(run.screen, .stream(.motion), "Location, a plain yes, passed by itself")
        XCTAssertEqual(StepMarks.spoken(run.marks), "Step 3 of 6, 1 skipped", "Pair later a ring, Location's yes done")
        run.pass()
        XCTAssertEqual(StepMarks.spoken(run.marks), "Step 4 of 6, 2 skipped", "Not now a ring")
        for _ in 0..<5 where run.screen != .done { run.pass() }
        XCTAssertEqual(run.screen, .done)
        XCTAssertEqual(StepMarks.spoken(run.marks), "6 steps, 5 skipped", "Done: how the run went")
    }

    func testTheFirstRunKeptInPreferencesMovesIntoTheStoreAndABackupsIsDropped() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = "first-run-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
            UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
        }
        let past: Set<String> = ["welcome", "pair", "location"]
        func plant() {
            defaults.set(Array(past), forKey: "first-run.past")
            defaults.set(true, forKey: "first-run.continued")
            defaults.set(true, forKey: "permissions.asked-always")
        }
        let kept = { FirstRunRecord.legacyKeys.filter { defaults.object(forKey: $0) != nil } }

        plant()
        do {
            let restored = FirstRunRecord(store: try CaptureStore(root: root), defaults: defaults)
            XCTAssertEqual(restored.facts, CaptureStore.FirstRun(), "a phone restored from a backup runs its first run")
            XCTAssertEqual(kept(), [], "the backup's preferences are dropped")
        }

        plant()
        do {
            let upgraded = FirstRunRecord(store: try CaptureStore(root: root), defaults: defaults)
            XCTAssertTrue(upgraded.facts.started, "it launches past the first run")
            XCTAssertEqual(kept(), FirstRunRecord.legacyKeys, "the preferences stay until the store holds the facts")
            await upgraded.writing?.value
            XCTAssertEqual(kept(), [], "the store holds them: the preferences go")
        }

        let relaunched = FirstRunRecord(store: try CaptureStore(root: root), defaults: defaults)
        XCTAssertEqual(relaunched.facts, CaptureStore.FirstRun(past: past, started: true, askedAlways: true),
                       "the store keeps them across a relaunch")
    }

    func testTheFirstRunSaysBeforeTheAskAndWhatEachAnswerThatIsNotAPlainYesCosts() {
        XCTAssertEqual(FirstRunWords.before(.location), "iOS asks twice. Choose Allow While Using, then Change to Always Allow.")
        XCTAssertEqual(FirstRunWords.before(.health), "iOS shows a list. Turn on whatever you're happy for Lifestream to read.")
        XCTAssertEqual(FirstRunWords.before(.contacts), "iOS closes Lifestream if you change this later in Settings. It opens back here.")
        XCTAssertNil(FirstRunWords.before(.motion), "one plain question: no note")
        XCTAssertNil(FirstRunWords.before(.photos), "one plain question: no note")

        XCTAssertEqual(FirstRunWords.partial(.location, count: nil), "Only while Lifestream is open. Your days will miss the way between places.",
                       "While Using")
        XCTAssertEqual(FirstRunWords.partial(.photos, count: 3), "Only the 3\u{00A0}photos and videos you chose. Your days will miss the rest.",
                       "limited Photos, counted")
        XCTAssertEqual(FirstRunWords.partial(.photos, count: 1), "Only the 1\u{00A0}photo or video you chose. Your days will miss the rest.")
        XCTAssertEqual(FirstRunWords.partial(.photos, count: nil), "Only the photos and videos you chose. Your days will miss the rest.",
                       "limited Photos before the count is read")
        XCTAssertEqual(FirstRunWords.partial(.contacts, count: 2), "Only the 2\u{00A0}contacts you chose. Your days will name no one else.")
        XCTAssertEqual(FirstRunWords.partial(.health, count: nil), "New kinds of Health data wait for you to allow them. The rest is read.")

        XCTAssertEqual(FirstRunWords.off(.motion), "Off. Your days will miss how you moved.", "denied Motion")
        XCTAssertEqual(FirstRunWords.off(.location), "Off. Your days will have no places or journeys.")
        XCTAssertEqual(FirstRunWords.off(.contacts), "Off. Your days will name no one.")
        XCTAssertEqual(FirstRunWords.asked, "Asked. Health decides what Lifestream reads; change it in the Health app, under Sharing.",
                       "Health asked, nothing read back")
    }

    func testTheFirstRunOffersEachAnswerItsOwnWayToChangeIt() {
        func change(_ source: PhoneSource, _ state: PermissionsModel.State, closesApp: Bool = false) -> FirstRunChange? {
            FirstRunChange.of(source, state, closesApp: closesApp)
        }
        XCTAssertEqual(change(.location, .partly), FirstRunChange(label: "Allow Always in Settings", act: .settings, closes: false), "While Using")
        XCTAssertEqual(change(.motion, .denied, closesApp: true), FirstRunChange(label: "Turn on in Settings", act: .settings, closes: true),
                       "denied Motion, which iOS closes the app for")
        XCTAssertEqual(change(.location, .denied), FirstRunChange(label: "Turn on in Settings", act: .settings, closes: false))
        XCTAssertEqual(change(.health, .asked), FirstRunChange(label: "Open Health", act: .openHealth, closes: false), "asked Health")
        XCTAssertEqual(change(.health, .denied, closesApp: true), FirstRunChange(label: "Open Health", act: .openHealth, closes: false),
                       "Health is changed in Health, never in Settings")
        XCTAssertEqual(change(.health, .partly), FirstRunChange(label: "Allow new Health data", act: .askHealth, closes: false))
        XCTAssertEqual(change(.photos, .partly, closesApp: true), FirstRunChange(label: "Choose more photos", act: .choosePhotos, closes: false),
                       "limited Photos: chosen in place")
        XCTAssertEqual(change(.contacts, .partly, closesApp: true), FirstRunChange(label: "Add contacts in Settings", act: .settings, closes: true))
        for state: PermissionsModel.State in [.granted, .undetermined] {
            for source: PhoneSource in [.location, .motion, .photos, .contacts] {
                XCTAssertNil(change(source, state), "\(source) \(state): nothing to change")
            }
        }
    }

    private static func line(_ event: String, _ detail: [String: String]) -> JSONValue {
        .object(["event": .string(event), "detail": .object(detail.mapValues(JSONValue.string))])
    }
}

@MainActor
private final class Teller {
    let diary: MachineDiary
    private(set) var told: [[String: String]] = []
    private(set) var written: Task<Void, Never>?

    init(diary: MachineDiary) { self.diary = diary }

    func tell(_ grants: [String: String]) {
        told.append(grants)
        written = diary.record(grants)
    }

    func changes(_ grant: String) -> [String] {
        told.compactMap { $0[grant] }.reduce(into: []) { states, state in
            if states.last != state { states.append(state) }
        }
    }
}
