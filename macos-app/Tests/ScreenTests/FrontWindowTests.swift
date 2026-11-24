import CoreGraphics
import DeviceFiles
import Evidence
import Foundation
import BrowserPages
import Spool
import XCTest
@testable import Screen

final class FrontWindowTests: XCTestCase {
    static let editor = CaptureApplication(bundleID: "com.example.editor", name: "Example Editor", pid: 4242)
    static let palette = CaptureApplication(bundleID: "com.example.palette", name: "Example Palette", pid: 4343)
    static let display = CaptureRect(x: 0, y: 0, width: 1440, height: 900)
    static let second = CaptureRect(x: 1440, y: 0, width: 1280, height: 800)
    static let document = CGRect(x: 100, y: 80, width: 900, height: 700)
    static let at = Date(timeIntervalSince1970: 1_790_848_157.303_890_9)


    @MainActor
    func testIdenticalWindowsNameTheFocusedOneAndTheWalkReadsItByItsID() async throws {
        let facts = FakeSystemFacts(front: Self.editor, focused: [4242: .window(103)])
        let inventory = Self.inventory([Self.row(101, Self.editor, Self.document, title: "Synthetic one"),
                                        Self.row(102, Self.editor, Self.document, title: "Synthetic two"),
                                        Self.row(103, Self.editor, Self.document, title: "Synthetic three")])
        let scope = try await Self.frame(inventory, facts: facts)
        XCTAssertEqual(scope.observation.windows.map(\.windowID), [101, 102, 103], "the list order is the window server's")
        XCTAssertEqual(scope.observation.frontWindow, CaptureFrontWindow(windowID: 103), "not the first listed")
        XCTAssertEqual(scope.front, 103)

        let ax = [(UInt32(102), Self.document), (UInt32(103), Self.document), (UInt32(101), Self.document)]
        XCTAssertEqual(Self.resolve(scope, ax), .identified(windowIndex: 2, accessibilityIndex: 1))
        XCTAssertEqual(Self.resolve(scope, ax, knowingFront: false), .ambiguous(windowIndex: 0))
    }


    @MainActor
    func testAnAppWithNoFocusedWindowSaysSoAndTheWalkKeepsItsGeometry() async throws {
        let facts = FakeSystemFacts(front: Self.editor, focused: [4242: .unstated(.noFocusedWindow)])
        let inventory = Self.inventory([Self.row(101, Self.editor, Self.document)])
        let scope = try await Self.frame(inventory, facts: facts)
        XCTAssertEqual(scope.observation.frontWindow, CaptureFrontWindow(cause: .noFocusedWindow))
        XCTAssertNil(scope.front)
        XCTAssertEqual(Self.resolve(scope, [(101, Self.document)]), .matched(windowIndex: 0, accessibilityIndex: 0))
    }


    @MainActor
    func testAFullScreenWindowIsNamedNotTheStripAboveIt() async throws {
        let strip = CGRect(x: 0, y: 0, width: 1440, height: 52)
        let full = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let facts = FakeSystemFacts(front: Self.editor, focused: [4242: .window(201)])
        let inventory = Self.inventory([Self.row(202, Self.editor, strip), Self.row(201, Self.editor, full)])
        let scope = try await Self.frame(inventory, facts: facts)
        XCTAssertEqual(scope.observation.frontWindow, CaptureFrontWindow(windowID: 201))
        XCTAssertEqual(Self.resolve(scope, [(202, strip), (201, full)]), .identified(windowIndex: 1, accessibilityIndex: 1))
    }


    @MainActor
    func testAnotherAppsWindowOnTopIsNeverNamed() async throws {
        let facts = FakeSystemFacts(front: Self.editor, focused: [4242: .window(101), 4343: .window(301)])
        let inventory = Self.inventory([Self.row(301, Self.palette, CGRect(x: 200, y: 200, width: 300, height: 200), layer: 3),
                                        Self.row(302, Self.palette, Self.document),
                                        Self.row(101, Self.editor, Self.document)])
        let scope = try await Self.frame(inventory, facts: facts)
        XCTAssertEqual(scope.observation.windows.first?.windowID, 301, "the palette is listed first")
        XCTAssertEqual(scope.observation.frontWindow, CaptureFrontWindow(windowID: 101))
        XCTAssertEqual(Self.resolve(scope, [(101, Self.document)]), .identified(windowIndex: 0, accessibilityIndex: 0))
        let stray = FrontWindowReading.window(302).stated(in: scope.observation.windows, application: Self.editor.pid)
        XCTAssertEqual(stray, CaptureFrontWindow(cause: .notListed))
    }


    @MainActor
    func testAFocusedWindowThisFrameDoesNotListIsNotNamed() async throws {
        let elsewhere = CGRect(x: 1600, y: 80, width: 900, height: 600)
        let facts = FakeSystemFacts(front: Self.editor, focused: [4242: .window(102)])
        let inventory = Self.inventory([Self.row(101, Self.editor, Self.document), Self.row(102, Self.editor, elsewhere)])
        let first = try await Self.frame(inventory, facts: facts)
        XCTAssertEqual(first.observation.frontWindow, CaptureFrontWindow(cause: .notListed), "it is on the other display")
        XCTAssertNil(first.front)
        XCTAssertEqual(Self.resolve(first, [(101, Self.document), (102, elsewhere)]), .matched(windowIndex: 0, accessibilityIndex: 0))
        let other = try await Self.frame(inventory, facts: facts, display: Self.second, displayID: 2)
        XCTAssertEqual(other.observation.frontWindow, CaptureFrontWindow(windowID: 102), "the display that shows it names it")

        let browser = CaptureApplication(bundleID: "com.google.Chrome", name: "Example Browser", pid: 4444)
        let shown = CGRect(x: 100, y: 80, width: 900, height: 700), hidden = CGRect(x: 300, y: 120, width: 800, height: 600)
        let rows = [Self.row(401, browser, shown), Self.row(402, browser, hidden)]
        var plan = SitePlan()
        let modes = RecordingModes()
        plan.add(pid: browser.pid, bundleID: "com.google.Chrome", cgWindows: Self.inventory(rows).selection, windows: [
            BrowserWindow(bounds: CaptureRect(shown), kind: .standard, page: .site(Site(rule: "news.example")!)),
            BrowserWindow(bounds: CaptureRect(hidden), kind: .standard, page: .privateWindow),
        ], modes: modes)
        let withheld = FakeSystemFacts(front: browser, focused: [4444: .window(402)])
        let scope = try await Self.frame(Self.inventory(rows), facts: withheld, plan: plan)
        XCTAssertEqual(scope.observation.windows.map(\.windowID), [401])
        XCTAssertEqual(scope.observation.frontWindow, CaptureFrontWindow(cause: .notListed))
    }


    @MainActor
    func testAnActivityOnlyObservationNamesItsFrontWindowWithoutItsTitle() async throws {
        var modes = RecordingModes()
        try modes.set(.activity, for: "com.example.chat")
        let chat = CaptureApplication(bundleID: "com.example.chat", name: "Example Chat", pid: 4545)
        let facts = FakeSystemFacts(front: chat, focused: [4545: .window(502)])
        let inventory = Self.inventory([Self.row(501, chat, Self.document, title: "Synthetic chat one"),
                                        Self.row(502, chat, Self.document, title: "Synthetic chat two"),
                                        Self.row(101, Self.editor, CGRect(x: 1600, y: 80, width: 900, height: 600))])
        let admission = CaptureAdmission(modes: modes, system: facts)
        let privacy = ScreenCaptureKitAdapter.privacy(admission, modes: modes, plan: .empty) { facts.runningPIDs(bundleIDs: $0) }
        let observation = ScreenCaptureKitAdapter.activityObservation(application: chat, inventory: inventory,
            privacy: privacy, at: Self.at, front: await facts.frontWindowOffMain(pid: chat.pid), lookup: Self.lookup)
        XCTAssertEqual(observation.status, "activity_only")
        XCTAssertEqual(observation.windows.map(\.windowID), [501, 502, 101], "every display")
        XCTAssertEqual(observation.windows.prefix(2).map(\.title), [nil, nil])
        XCTAssertEqual(observation.frontWindow, CaptureFrontWindow(windowID: 502))
        let json = try Self.published(observation, image: nil)
        XCTAssertTrue(json.contains(#""frontWindow":{"windowID":502}"#), json)
        XCTAssertEqual(ObservationBytes.member("frontWindow", of: Data(json.utf8)), Data(#"{"windowID":502}"#.utf8))
    }


    @MainActor
    func testASheetOrAPanelInFocusIsNamedAndTheWalkNeverGuessesPastIt() async throws {
        let sheet = CGRect(x: 250, y: 108, width: 600, height: 300)
        let facts = FakeSystemFacts(front: Self.editor, focused: [4242: .window(602)])
        let inventory = Self.inventory([Self.row(602, Self.editor, sheet), Self.row(601, Self.editor, Self.document)])
        let scope = try await Self.frame(inventory, facts: facts)
        XCTAssertEqual(scope.observation.frontWindow, CaptureFrontWindow(windowID: 602))
        XCTAssertEqual(scope.front, 602)
        XCTAssertEqual(Self.resolve(scope, [(601, Self.document)]), .matched(windowIndex: 1, accessibilityIndex: 0))

        let panel = CGRect(x: 1100, y: 100, width: 280, height: 500)
        let floating = FakeSystemFacts(front: Self.editor, focused: [4242: .window(603)])
        let withPanel = Self.inventory([Self.row(603, Self.editor, panel, layer: 3), Self.row(601, Self.editor, Self.document)])
        let panelScope = try await Self.frame(withPanel, facts: floating)
        XCTAssertEqual(panelScope.observation.frontWindow, CaptureFrontWindow(windowID: 603))
        XCTAssertNil(panelScope.front, "the walk reads document-layer windows only")
        XCTAssertEqual(panelScope.targetWindows.map(\.windowID), [601])
    }


    @MainActor
    func testWhenTheSystemCannotSayTheObservationSaysWhy() async throws {
        let inventory = Self.inventory([Self.row(101, Self.editor, Self.document), Self.row(102, Self.editor, Self.document)])
        for cause in [FrontWindowCause.focusedWindowUnreadable, .windowNumberUnreadable] {
            let scope = try await Self.frame(inventory, facts: FakeSystemFacts(front: Self.editor, focused: [4242: .unstated(cause)]))
            XCTAssertEqual(scope.observation.frontWindow, CaptureFrontWindow(cause: cause))
            XCTAssertNil(scope.front)
            XCTAssertEqual(Self.resolve(scope, [(101, Self.document), (102, Self.document)]), .ambiguous(windowIndex: 0))
        }
        let scope = try await Self.frame(inventory, facts: FakeSystemFacts(front: Self.editor, focused: [4242: .window(102)]))
        XCTAssertEqual(AccessibilityWindowCorrelation.resolve(windows: scope.targetWindows, pid: Self.editor.pid,
            display: Self.display, candidates: [AccessibilityWindowCandidate(bounds: CaptureRect(Self.document), windowID: nil),
                                                AccessibilityWindowCandidate(bounds: CaptureRect(Self.document), windowID: nil)],
            front: scope.front), .ambiguous(windowIndex: 0))
    }


    @MainActor
    func testTheFrontWindowIsPublishedAndStaysInTheReducedObservation() async throws {
        let facts = FakeSystemFacts(front: Self.editor, focused: [4242: .window(103)])
        let inventory = Self.inventory([Self.row(101, Self.editor, Self.document, title: "Synthetic one"),
                                        Self.row(102, Self.editor, Self.document, title: "Synthetic two"),
                                        Self.row(103, Self.editor, Self.document, title: "Synthetic three")])
        let scope = try await Self.frame(inventory, facts: facts)
        let ax = [(UInt32(101), Self.document), (UInt32(102), Self.document), (UInt32(103), Self.document)]
        guard case .identified(let windowIndex, _) = Self.resolve(scope, ax) else { return XCTFail("not identified") }
        let target = scope.targetWindows[windowIndex]

        let text = [TextObservation(text: "SYNTHETIC TEXT", confidence: 0.5,
                                    bounds: CaptureRect(x: 0.25, y: 0.5, width: 0.25, height: 0.125))]
        let adapter = ScreenCaptureKitAdapter(configuration: ScreenCapture.Configuration(), system: facts,
                                              pages: NoBrowserPages(), reader: { _, _ in text })
        let acquired = AcquiredCapture(image: try XCTUnwrap(Self.image()),
            provenance: CaptureAcquisition(backend: "screenshot", receivedAt: Self.at, freshness: "screenshot-request-completed"),
            endedAt: Self.at)
        let enriched = try await adapter.enrich(acquired, observation: scope.observation, accessibility: {
            var snapshot = AccessibilitySnapshot(capturedAt: Self.at, status: "complete-scoped-app-reported",
                nodes: [AccessibilityNode(role: "AXWindow", text: target.title, bounds: target.bounds, depth: 0, title: target.title)],
                capturedUntil: Self.at)
            snapshot.targetWindowID = target.windowID
            snapshot.targetWindowBounds = target.bounds
            snapshot.windowCorrelation = "exact-window-id"
            snapshot.limitReasons = []
            return snapshot
        }, vision: { _, _ in text })
        let json = try Self.published(await enriched.recognized(), image: enriched.image)
        XCTAssertTrue(json.contains("SYNTHETIC TEXT"), "the frame is published with its text")
        XCTAssertTrue(json.contains(#""frontWindow":{"windowID":103}"#), json)
        XCTAssertTrue(json.contains(#""targetWindowID":103"#), json)
        XCTAssertTrue(json.contains(#""windowCorrelation":"exact-window-id""#), json)

        let packet = Data(json.utf8)
        let reduction = try XCTUnwrap(ScreenText.reduce(packet))
        XCTAssertEqual(ObservationBytes.member("frontWindow", of: reduction.reduced), Data(#"{"windowID":103}"#.utf8))
        XCTAssertNil(ObservationBytes.member("windows", of: reduction.reduced))
        XCTAssertEqual(reduction.moved.count, 3, "nodes, ocr and windows move; the front window stays")
        let splices = reduction.moved.enumerated().map { ScreenText.Splice(at: $1.at, before: $1.before, array: $0, after: $1.after) }
        XCTAssertEqual(ScreenText.splice(reduction.reduced, splices) { reduction.moved[$0].array }, packet)
    }


    @MainActor
    static func frame(_ inventory: WindowInventory, facts: FakeSystemFacts, plan: SitePlan = .empty,
                      display: CaptureRect = display, displayID: UInt32 = 1) async throws -> ScreenCaptureKitAdapter.FrameScope {
        let application = try XCTUnwrap(facts.frontmostApplication())
        let modes = RecordingModes()
        let admission = CaptureAdmission(modes: modes, system: facts)
        let privacy = ScreenCaptureKitAdapter.privacy(admission, modes: modes, plan: plan) { facts.runningPIDs(bundleIDs: $0) }
        return ScreenCaptureKitAdapter.frameScope(inventory: inventory, bounds: display, displayID: displayID,
            application: application, privacy: privacy, plan: plan, modes: modes,
            front: await facts.frontWindowOffMain(pid: application.pid),
            selection: CaptureDisplaySelection(policy: "relevant-display", reason: "foreground-window-midpoint", availableCount: 2),
            at: at, lookup: lookup)
    }

    static func resolve(_ scope: ScreenCaptureKitAdapter.FrameScope, _ ax: [(UInt32, CGRect)],
                        knowingFront: Bool = true) -> AccessibilityWindowCorrelation.Resolution {
        let front = knowingFront ? scope.front : nil
        return AccessibilityWindowCorrelation.resolve(windows: scope.targetWindows, pid: pid(of: scope),
            display: scope.bounds, candidates: ax.map { id, rect in
                AccessibilityWindowCandidate(bounds: CaptureRect(rect), subrole: "AXStandardWindow",
                                             windowID: front == nil ? nil : id)
            }, front: front)
    }

    static func pid(of scope: ScreenCaptureKitAdapter.FrameScope) -> Int32 {
        scope.observation.application?.pid ?? editor.pid
    }

    static func published(_ observation: CaptureObservation, image: CaptureImage?) throws -> String {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("front-window-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true))
        try store.append(observation: observation, image: image)
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []
        let packet = try XCTUnwrap(files.first { $0.lastPathComponent == "observation.lsm" })
        return String(decoding: try MetadataCodec.decode(Data(contentsOf: packet)), as: UTF8.self)
    }

    static func lookup(_ pid: Int32) -> CaptureApplication {
        [editor, palette, CaptureApplication(bundleID: "com.example.chat", name: "Example Chat", pid: 4545),
         CaptureApplication(bundleID: "com.google.Chrome", name: "Example Browser", pid: 4444)]
            .first { $0.pid == pid } ?? CaptureApplication(bundleID: nil, name: nil, pid: pid)
    }

    static func row(_ id: UInt32, _ application: CaptureApplication, _ rect: CGRect, layer: Int = 0,
                    title: String? = nil) -> [String: Any] {
        var row: [String: Any] = [
            kCGWindowNumber as String: NSNumber(value: id),
            kCGWindowOwnerPID as String: NSNumber(value: application.pid),
            kCGWindowLayer as String: NSNumber(value: layer),
            kCGWindowAlpha as String: NSNumber(value: 1.0),
            kCGWindowBounds as String: rect.dictionaryRepresentation,
        ]
        row[kCGWindowName as String] = title
        return row
    }

    static func inventory(_ rows: [[String: Any]]) -> WindowInventory { WindowInventory(rows: rows) }

    static func image() -> CGImage? {
        let context = CGContext(data: nil, width: 64, height: 48, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue)
        context?.setFillColor(gray: 0.5, alpha: 1)
        context?.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
        return context?.makeImage()
    }
}

@MainActor
final class FakeSystemFacts: SystemFacts {
    let front: CaptureApplication?
    let focused: [Int32: FrontWindowReading]

    init(front: CaptureApplication?, focused: [Int32: FrontWindowReading]) {
        self.front = front
        self.focused = focused
    }

    var screenRecordingPermitted: Bool { true }
    var sessionPermitsCapture: Bool { true }
    var secureInputEnabled: Bool { false }
    func secureField() -> SecureFieldReading { .none }
    func secureFieldOffMain() async -> SecureFieldReading { .none }
    func frontmostApplication() -> CaptureApplication? { front }
    func frontWindow(pid: Int32) -> FrontWindowReading { focused[pid] ?? .unstated(.focusedWindowUnreadable) }
    func frontWindowOffMain(pid: Int32) async -> FrontWindowReading { frontWindow(pid: pid) }
    func runningPIDs(bundleIDs: Set<String>) -> Set<pid_t> {
        Set([FrontWindowTests.editor, FrontWindowTests.palette, front].compactMap { $0 }
            .filter { $0.bundleID.map(bundleIDs.contains) == true }.map(\.pid))
    }
    func visiblePIDs() -> Set<Int32>? { nil }
}

struct NoBrowserPages: BrowserPageFacts {
    func windows(pid: Int32, bundleID: String) async -> [BrowserWindow] { [] }
}
