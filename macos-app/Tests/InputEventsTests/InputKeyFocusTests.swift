import Evidence
import DeviceFiles
import Foundation
import XCTest
@testable import InputEvents

final class InputKeyFocusTests: XCTestCase {
    private var root: URL!
    private let zone = TimeZone(identifier: "Asia/Kolkata")!
    private static let launcher = "com.example.launcher"
    private static let chat = "com.example.chat"
    private static let browser = "com.google.Chrome"
    private static let otherBrowser = "com.brave.Browser"
    private static let cmd: UInt64 = 0x0010_0000
    private static let shift: UInt64 = 0x0002_0000

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("input-focus-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var folder: URL { root.appendingPathComponent(InputEventBatch.directoryName) }

    private func sealedChunk() throws -> InputChunk {
        let lines = try InputEventBatch.sealedBatches(in: folder).flatMap { name in
            try String(contentsOf: folder.appendingPathComponent(name), encoding: .utf8)
                .split(separator: "\n").map { try InputEventCodec.chunk(String($0)) }
        }
        XCTAssertEqual(lines.count, 1, "one minute, one line")
        return try XCTUnwrap(lines.first)
    }

    private func source() -> FakeSource {
        let source = FakeSource()
        source.names[505] = Self.launcher
        source.names[506] = Self.chat
        source.names[502] = Self.browser
        source.names[510] = Self.otherBrowser
        return source
    }

    private func log(_ source: FakeSource, _ reader: FakeReader, modes: RecordingModes) -> InputEventLog {
        let log = InputEventLog(directory: root, files: DeviceFiles(.plain), modes: modes, timeZone: zone, report: { _ in }, source: source,
                                reader: reader, clock: .held)
        addTeardownBlock { log.stop() }
        return log
    }

    private func key(_ type: RawInputEventType, code: Int, characters: String = "", flags: UInt64 = 0,
                     target: Int32 = 501) -> InputBufferItem {
        Synthetic.raw(type, at: Synthetic.opened, target: target, code: code, characters: characters, flags: flags)
    }

    private func type(_ source: FakeSource, code: Int, characters: String = "", flags: UInt64 = 0,
                      target: Int32 = 501) {
        source.push(key(.keyDown, code: code, characters: characters, flags: flags, target: target))
        source.push(key(.keyUp, code: code, target: target))
    }

    private func openPanel(_ source: FakeSource, _ reader: FakeReader, target: Int32 = 501) throws {
        let before = reader.reads.count
        reader.set(Synthetic.element(role: "AXTextArea", title: "Draft"))
        reader.set(owner: target)
        type(source, code: 49, characters: " ", flags: Self.cmd, target: target)
        try until("reader.reads.count == before + 1") { reader.reads.count == before + 1 }
    }

    private struct Written: Equatable {
        var e: InputEventName
        var app: String?
        var key: String?
        var name: String?
        var role: String?
        var hidden = false
        var site: String?
    }

    private func written(_ chunk: InputChunk) -> [Written] {
        chunk.events.compactMap { event in
            switch event.body {
            case .keyDown(let key):
                return Written(e: .keyDown, app: key.app.map { chunk.apps[$0] }, key: key.key, name: key.name,
                               role: key.el?.attributes.role, hidden: key.hidden != nil,
                               site: event.site.map { chunk.sites[$0] })
            case .keyUp(_, let index, _):
                return Written(e: .keyUp, app: index.map { chunk.apps[$0] })
            case .flags:
                return Written(e: .flags)
            case .activate(let index, _):
                return Written(e: .activate, app: chunk.apps[index])
            default:
                return nil
            }
        }
    }

    func testKeysTypedIntoAPanelAreFiledUnderThePanelUntilItCloses() throws {
        let source = source()
        let reader = FakeReader()
        let log = log(source, reader, modes: RecordingModes(exclude: [Synthetic.vault]))
        log.start()
        try openPanel(source, reader)
        reader.set(Synthetic.element(role: "AXTextField", title: "Search"))
        reader.set(owner: 505)
        type(source, code: 1, characters: "s")
        type(source, code: 37, characters: "l")
        type(source, code: 36, characters: "\r")
        try until("reader.reads.count == 2") { reader.reads.count == 2 }
        reader.set(Synthetic.element(role: "AXTextArea", title: "Draft"))
        reader.set(owner: 501)
        source.push(.activate(pid: 501, name: Synthetic.editor, at: Synthetic.opened))
        type(source, code: 7, characters: "x")
        try until("reader.reads.count == 3 && log.status.events == 11") { reader.reads.count == 3 && log.status.events == 11 }
        log.stop()

        XCTAssertEqual(written(try sealedChunk()), [
            Written(e: .keyDown, app: Synthetic.editor, key: " ", name: "space", role: "AXTextArea"),
            Written(e: .keyUp, app: Synthetic.editor),
            Written(e: .keyDown, app: Self.launcher, key: "s", role: "AXTextField"),
            Written(e: .keyUp, app: Self.launcher),
            Written(e: .keyDown, app: Self.launcher, key: "l"),
            Written(e: .keyUp, app: Self.launcher),
            Written(e: .keyDown, app: Self.launcher, name: "return"),
            Written(e: .keyUp, app: Self.launcher),
            Written(e: .activate, app: Synthetic.editor),
            Written(e: .keyDown, app: Synthetic.editor, key: "x", role: "AXTextArea"),
            Written(e: .keyUp, app: Synthetic.editor),
        ])
        XCTAssertEqual(reader.reads,
                       Array(repeating: .focus(pid: 501, app: Synthetic.editor,
                                               modes: RecordingModes(exclude: [Synthetic.vault])), count: 3),
                       "each read starts at the key's target, with the modes that say what may be read")
    }

    func testAnExcludedPanelLeavesNothingNotEvenAModifierOrARelease() throws {
        let source = source()
        let reader = FakeReader()
        let log = log(source, reader, modes: RecordingModes(exclude: [Synthetic.vault]))
        log.start()
        try openPanel(source, reader)
        reader.set(.failed(.noElement))
        reader.set(owner: 503)
        type(source, code: 1, characters: "s")
        source.push(key(.flagsChanged, code: 56, flags: Self.shift))
        source.push(key(.keyDown, code: 0, characters: "A", flags: Self.shift))
        source.push(key(.flagsChanged, code: 56))
        try until("reader.reads.count == 2") { reader.reads.count == 2 }
        source.push(key(.keyDown, code: 53))
        source.push(key(.keyUp, code: 53))
        reader.set(Synthetic.element(role: "AXTextArea", title: "Draft"))
        reader.set(owner: 501)
        source.push(key(.keyDown, code: 7, characters: "x"))
        source.push(key(.keyUp, code: 0))
        source.push(key(.keyUp, code: 7))
        try until("reader.reads.count == 3 && log.status.events == 4") { reader.reads.count == 3 && log.status.events == 4 }
        log.stop()

        let chunk = try sealedChunk()
        XCTAssertEqual(written(chunk), [
            Written(e: .keyDown, app: Synthetic.editor, key: " ", name: "space", role: "AXTextArea"),
            Written(e: .keyUp, app: Synthetic.editor),
            Written(e: .keyDown, app: Synthetic.editor, key: "x", role: "AXTextArea"),
            Written(e: .keyUp, app: Synthetic.editor),
        ], "the vault's keys, modifiers, escape and the late release of A are gone")
        XCTAssertEqual(chunk.apps, [Synthetic.editor])
        XCTAssertEqual(chunk.activity, [])
    }

    func testAnActivityPanelIsCountedAndASecureFieldInAPanelIsHidden() throws {
        let source = source()
        let reader = FakeReader()
        let log = log(source, reader, modes: RecordingModes(activity: [Self.chat], exclude: [Synthetic.vault]))
        log.start()
        try openPanel(source, reader)
        reader.set(.failed(.noElement))
        reader.set(owner: 506)
        type(source, code: 1, characters: "s")
        type(source, code: 37, characters: "l")
        try until("reader.reads.count == 2") { reader.reads.count == 2 }
        source.push(key(.keyDown, code: 49, characters: " ", flags: Self.cmd))
        reader.set(Synthetic.element(role: "AXTextField", subrole: "AXSecureTextField"))
        reader.set(owner: 505)
        type(source, code: 1, characters: "s")
        try until("reader.reads.count == 3 && log.status.events == 4") { reader.reads.count == 3 && log.status.events == 4 }
        log.stop()

        let chunk = try sealedChunk()
        XCTAssertEqual(written(chunk), [
            Written(e: .keyDown, app: Synthetic.editor, key: " ", name: "space", role: "AXTextArea"),
            Written(e: .keyUp, app: Synthetic.editor),
            Written(e: .keyDown, app: Self.launcher, role: "AXTextField", hidden: true),
            Written(e: .keyUp, app: Self.launcher),
        ], "the chat panel's keys are counted, not written")
        XCTAssertEqual(chunk.activity.map { chunk.apps[$0.app] }, [Self.chat])
        XCTAssertEqual(chunk.activity.map(\.keys), [3])
        let hidden = chunk.events.compactMap { event -> InputKeyDown? in
            if case .keyDown(let key) = event.body, key.hidden != nil { return key }
            return nil
        }
        XCTAssertEqual(hidden.map(\.code), [nil], "a hidden key keeps no code")
        XCTAssertTrue(chunk.events.contains { $0.body == .keyUp(code: nil, app: 2, syn: nil) },
                      "and its release none either")
    }

    func testAPanelOverABrowserNeverTakesItsPageAndAnExcludedPageStillDropsIt() throws {
        let source = source()
        let reader = FakeReader()
        var modes = RecordingModes(exclude: [Synthetic.vault])
        try modes.setSite(.exclude, for: "bank.example")
        let log = log(source, reader, modes: modes)
        log.start()
        reader.set(page: .page(.site(Site(rule: "news.example:443")!)))
        source.push(.activate(pid: 502, name: Self.browser, at: Synthetic.opened))
        try until("reader.reads.count == 1") { reader.reads.count == 1 }
        try openPanel(source, reader, target: 502)
        reader.set(Synthetic.element(role: "AXTextField", title: "Search"))
        reader.set(owner: 505)
        type(source, code: 1, characters: "s", target: 502)
        try until("reader.reads.count == 3") { reader.reads.count == 3 }
        source.push(.page(pid: 502, read: .page(.site(Site(rule: "bank.example:443")!)), at: Synthetic.opened))
        type(source, code: 37, characters: "l", target: 502)
        source.push(.page(pid: 502, read: .page(.site(Site(rule: "news.example:443")!)), at: Synthetic.opened))
        source.push(key(.keyDown, code: 49, characters: " ", flags: Self.cmd, target: 502))
        reader.set(owner: 510)
        type(source, code: 2, characters: "d", target: 502)
        try until("reader.reads.count == 4 && log.status.events == 6") { reader.reads.count == 4 && log.status.events == 6 }
        log.stop()

        let chunk = try sealedChunk()
        XCTAssertEqual(written(chunk), [
            Written(e: .activate, app: Self.browser),
            Written(e: .keyDown, app: Self.browser, key: " ", name: "space", role: "AXTextArea", site: "news.example"),
            Written(e: .keyUp, app: Self.browser),
            Written(e: .keyDown, app: Self.launcher, key: "s", role: "AXTextField"),
            Written(e: .keyUp, app: Self.launcher),
            Written(e: .keyDown, app: Self.launcher, key: " ", name: "space"),
        ])
        XCTAssertFalse(chunk.apps.contains(Self.otherBrowser))
        XCTAssertEqual(chunk.sites, ["news.example"])
    }
}
