import Evidence
import DeviceFiles
import Foundation
import HomeLink
import Passwords
import Recorder
import Screen
import Shipping
import XCTest
@testable import Lifestream

@MainActor final class ScreenSettingsTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("screen-settings-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: folder)
    }

    private final class StandIn: ScreenRecording {
        var modes: RecordingModes
        var captureInterval: Double = 2
        var modesSet: ((RecordingModes) throws -> Void)?
        var calls: [String] = []
        init(_ modes: RecordingModes) { self.modes = modes }
        func take(interval: Double, idlePauseAfter: Double?, ocr: OCRMode) { captureInterval = interval }
        func setModes(_ next: RecordingModes) throws {
            guard next != modes else { return }
            calls.append("modes")
            modes = next
        }
        func set(_ mode: RecordingMode, for id: String) throws {
            try modes.set(mode, for: id)
            try modesSet?(modes)
        }
    }

    private var file: URL { folder.appendingPathComponent(MacSettings.fileName) }

    private final class Taking: HomeTransport, @unchecked Sendable {
        let settings: [String: Any]
        private let turns = NSLock()
        private var turn = 0
        init(gives settings: [String: Any]) { self.settings = settings }
        func perform(_ request: HomeRequest) async throws -> HomeResponse {
            switch request.url.path {
            case "/v1/settings": return HomeResponse(status: 200, body: Data("{}".utf8))
            case "/v1/exchange":
                let n = turns.withLock { turn += 1; return turn }
                let answer: [String: Any] = ["home": ["id": "h-00000001", "version": "0.2.0", "floors": ["mac": "0.1.0"]],
                                             "pass": "p-00000001", "unit": "macbook-pro-0001", "sources": [:], "owner": [String](),
                                             "needs": [Any](), "calls": [Any](), "settings": settings, "turn": ["run": "000000000005e771", "n": n]]
                return HomeResponse(status: 200, body: try JSONSerialization.data(withJSONObject: answer))
            default: return HomeResponse(status: 404, body: Data("{}".utf8))
            }
        }
    }

    private final class Stored: Credentials, @unchecked Sendable {
        private var data: Data?
        init(_ data: Data?) { self.data = data }
        func read() throws -> Data? { data }
        func write(_ data: Data) throws { self.data = data }
        func delete() throws { data = nil }
    }

    private func taking(apps: HomeLink.JSON) throws -> HomeLink {
        let stored = try JSONSerialization.data(withJSONObject: ["name": "http://127.0.0.1:4680", "pass": "fake-pass-000000000000",
                                                                 "paired": true, "unit": "macbook-pro-0001"])
        return HomeLink(device: .init(kind: .mac, version: "0.9.0", model: "Mac15,3", serial4: nil), credentials: Stored(stored),
                        folder: folder.appendingPathComponent("link"),
                        transport: Taking(gives: ["screen": ["apps": try JSONSerialization.jsonObject(with: JSONEncoder().encode(apps),
                                                                                                      options: .fragmentsAllowed)]]), files: DeviceFiles(.plain))
    }

    func testAtLaunchTheHomesListRunsWithWhatTheModesCommandQueuedAndTheCopyIsNoChange() async throws {
        let launch = ScreenSettings.defaults(try Options([]), modes: .defaults)
        let before = MacSettings(file: file, defaults: launch, files: DeviceFiles(.plain))
        try before.seed("screen", "apps", local: AppsField.of(.defaults))
        let removedDefault = try XCTUnwrap(RecordingModes.defaultExcluded.sorted().first)
        var homes = RecordingModes.defaults
        try homes.set(.record, for: removedDefault)
        _ = try await before.exchange(through: try taking(apps: AppsField.of(homes)))
        XCTAssertEqual(before.queue.changes, [])
        XCTAssertEqual(before.value("screen", "apps"), AppsField.of(homes))

        let command = MacSettings(file: file, defaults: launch, files: DeviceFiles(.plain))
        var commanded = try XCTUnwrap(AppsField.modes(try XCTUnwrap(command.value("screen", "apps")), current: .defaults))
        try commanded.set(.exclude, for: "com.example.notes-fake")
        try command.set("screen", "apps", to: AppsField.of(commanded))

        let recorder = StandIn(.defaults)
        let settings = MacSettings(file: file, defaults: launch, files: DeviceFiles(.plain))
        ScreenSettings.join(settings, recorder, knock: {})
        XCTAssertEqual(recorder.modes.mode(of: "com.example.notes-fake"), .exclude, "a Never set while closed did not run")
        XCTAssertEqual(recorder.modes.mode(of: removedDefault), .record, "the copy was read as a change: a removed default came back")
        XCTAssertEqual(settings.queue.changes, [.init(connector: "screen", member: "apps", value: AppsField.of(commanded), was: AppsField.of(homes))],
                       "the Never set while closed is not owed to the home, or the launch queued its copy")
    }

    func testTheModesCommandsBareListingWritesNothingAndItsChangeIsQueuedOverTheMacsOwnList() async throws {
        let store = folder.appendingPathComponent("capture")
        try FileManager.default.createDirectory(at: store, withIntermediateDirectories: true)
        let written = { [file] in [file, file.deletingLastPathComponent().appendingPathComponent(MacSettings.queueName),
                                   store.appendingPathComponent("app-modes.json")].filter { FileManager.default.fileExists(atPath: $0.path) } }
        _ = try await ModeCommands.modes(try Options(["modes", "--store", store.path]), settings: file, files: DeviceFiles(.plain))
        XCTAssertEqual(written(), [], "a bare listing wrote the settings, the queue or the recorder's copy")

        _ = try await ModeCommands.modes(try Options(["modes", "--store", store.path, "--exclude", "com.example.notes-fake"]), settings: file, files: DeviceFiles(.plain))
        let settings = MacSettings(file: file, defaults: ScreenSettings.defaults(try Options([]), modes: .defaults), files: DeviceFiles(.plain))
        XCTAssertEqual(settings.queue.changes.map(\.member), ["apps"], "the Mac's own list and the change over it are one item owed")
        XCTAssertEqual(settings.queue.changes.first?.was, .array([]), "over the first contact's empty list")
        let queued = try XCTUnwrap(settings.queue.changes.first.flatMap { AppsField.modes($0.value, current: .defaults) })
        XCTAssertEqual(queued.mode(of: "com.example.notes-fake"), .exclude)
    }

    func testAModeFromTheDialogRunsBeforeTheActAnswersAndOneSetHereIsQueuedOnce() async throws {
        let recorder = StandIn(.defaults)
        let settings = MacSettings(file: FileManager.default.temporaryDirectory.appendingPathComponent("mac-settings-\(UUID().uuidString)/settings.json"), defaults: ScreenSettings.defaults(try Options([]), modes: .defaults), files: DeviceFiles(.plain))
        var knocks = 0
        ScreenSettings.join(settings, recorder, knock: { knocks += 1 })
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        let host = MacHost(needs: NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper)),
                           lines: StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true)),
                           socket: { nil },
                           readGrants: { [:] }, readFolder: { nil }, ask: .untouched, settings: settings)

        var never = RecordingModes.defaults
        try never.set(.exclude, for: "com.example.chat-fake")
        _ = try await host.perform(.setting(connector: "screen", member: "apps", value: AppsField.of(never)))
        XCTAssertEqual(recorder.modes.mode(of: "com.example.chat-fake"), .exclude, "the act answered before the recorder took the Never")

        let calls = recorder.calls.count
        try recorder.set(.exclude, for: "com.example.notes-fake")
        XCTAssertEqual(knocks, 1)
        XCTAssertEqual(recorder.calls.count, calls, "a mode the recorder set was applied to it again")
        XCTAssertEqual(settings.value("screen", "apps"), AppsField.of(recorder.modes))
        XCTAssertEqual(settings.queue.changes.count, 1, "one change of the list is one item owed")
    }
}
