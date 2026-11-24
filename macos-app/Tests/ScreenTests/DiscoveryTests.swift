import BrowserPages
import CoreGraphics
import Evidence
import Foundation
import XCTest
@testable import Screen

final class DiscoveryTests: XCTestCase {
    struct FakeContent {
        let applications: [(bundle: String, pid: Int32)]
        let windows: Set<UInt32>
    }

    @MainActor
    final class FakeWindowServer {
        var displays: [UInt32: CaptureRect] = [1: CaptureRect(x: 0, y: 0, width: 1440, height: 900)]
        var pixels: [UInt32: [Int]] = [1: [2880, 1800]]
        var owners: [UInt32: Int32] = [:]
        var bundles: [Int32: String] = [:]
        var readable = true
        var fetchFails = false
        private(set) var fetches = 0

        func open(_ id: UInt32, _ pid: Int32, _ bundle: String) {
            owners[id] = pid
            bundles[pid] = bundle
        }

        func quit(_ pid: Int32) {
            owners = owners.filter { $0.value != pid }
        }

        func cache() -> ShareableContentCache<FakeContent> {
            ShareableContentCache(read: { [self] in
                readable ? WindowServerSnapshot(displays: displays, owners: owners, pixels: pixels) : nil
            }, fetch: { [self] in
                fetches += 1
                if fetchFails { throw CapturePipeline.Failure.rejected(.shareableContentUnavailable) }
                return FakeContent(applications: Set(owners.values).sorted().map { (bundles[$0] ?? "", $0) },
                                   windows: Set(owners.keys))
            }, windows: \.windows)
        }
    }

    static let editor: Int32 = 4242, vault: Int32 = 7001, browser: Int32 = 4444
    static let hidden: Set<String> = ["com.example.vault", "org.lifestreamprotocol.screen-capture"]


    @MainActor
    func testUnchangedOwnersReuseAndAHiddenAppThatGainsAWindowIsFilteredAtOnce() async throws {
        let server = FakeWindowServer()
        server.open(101, Self.editor, "com.example.editor")
        server.open(102, Self.editor, "com.example.editor")
        let cache = server.cache()
        _ = try await cache.content(listing: [])
        _ = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 1, "an unchanged window server proves the content")

        server.open(103, Self.editor, "com.example.editor")
        server.owners[101] = nil
        _ = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 1, "a window opened or closed by an owner that keeps one of its windows")

        server.open(701, Self.vault, "com.example.vault")
        let content = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 2, "a new owner")
        let filtered = ScreenCaptureKitAdapter.filtered(content.applications, hidden: Self.hidden, bundle: \.bundle)
        XCTAssertEqual(filtered.map(\.pid), [Self.vault])

        let again = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 2)
        XCTAssertEqual(ScreenCaptureKitAdapter.filtered(again.applications, hidden: Self.hidden, bundle: \.bundle).map(\.pid),
                       [Self.vault])
    }


    @MainActor
    func testAnOwnerHoldingNoneOfItsWindowsFetchesAgain() async throws {
        let server = FakeWindowServer()
        server.open(101, Self.editor, "com.example.editor")
        server.open(201, Self.browser, "com.example.browser")
        let cache = server.cache()
        _ = try await cache.content(listing: [])

        server.quit(Self.editor)
        server.open(105, Self.editor, "com.example.other")
        let content = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 2, "the same owner set, but none of the earlier windows")
        XCTAssertEqual(content.applications.first { $0.pid == Self.editor }?.bundle, "com.example.other")

        server.owners[201] = nil
        server.open(202, Self.browser, "com.example.browser")
        _ = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 3)

        server.quit(Self.browser)
        _ = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 4)
        _ = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 4)
    }


    @MainActor
    func testADisplayChangeFetchesAgain() async throws {
        let server = FakeWindowServer()
        server.open(101, Self.editor, "com.example.editor")
        let cache = server.cache()
        _ = try await cache.content(listing: [])
        server.displays[2] = CaptureRect(x: 1440, y: 0, width: 1280, height: 800)
        _ = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 2, "a display added")
        server.displays[2] = CaptureRect(x: -1280, y: 0, width: 1280, height: 800)
        _ = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 3, "a display moved")
        server.displays[1] = CaptureRect(x: 0, y: 0, width: 1728, height: 1117)
        _ = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 4, "a display resized")
        server.pixels[1] = [1728, 1117]
        _ = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 5, "a display's scale changed, its bounds kept")
        server.displays[2] = nil
        _ = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 6, "a display removed")
        _ = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 6)
    }


    @MainActor
    func testAKeptWindowTheContentDoesNotListOrAnUnprovenReadFetchesAgain() async throws {
        let server = FakeWindowServer()
        server.open(201, Self.browser, "com.example.browser")
        let cache = server.cache()
        _ = try await cache.content(listing: [201])
        server.open(202, Self.browser, "com.example.browser")
        let content = try await cache.content(listing: [201, 202])
        XCTAssertEqual(server.fetches, 2, "a kept window newer than the content")
        XCTAssertTrue(content.windows.contains(202))

        server.readable = false
        _ = try await cache.content(listing: [])
        _ = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 4, "a window server that cannot say proves nothing")

        server.readable = true
        _ = try await cache.content(listing: [])
        server.fetchFails = true
        server.open(203, Self.vault, "com.example.vault")
        do {
            _ = try await cache.content(listing: [])
            XCTFail("the fetch failed")
        } catch {}
        server.fetchFails = false
        server.owners[203] = nil
        _ = try await cache.content(listing: [])
        XCTAssertEqual(server.fetches, 7, "a failed fetch leaves nothing to reuse")
    }


    @MainActor
    func testARejectionBeforeAcquisitionIsSpelledBeforeTheCapture() {
        let facts = PhaseFacts()
        let admission = CaptureAdmission(excluded: ["com.example.vault"], system: facts)
        let editor = CaptureApplication(bundleID: "com.example.editor", name: "Example Editor", pid: Self.editor)
        let witness = AdmissionWitness(application: editor, runningExcluded: [], filteredExcluded: [])
        XCTAssertNil(admission.check(.beforeAcquisition, witness))

        facts.running = [Self.vault]
        XCTAssertEqual(admission.check(.beforeAcquisition, witness), .contextChangedBeforeCapture)
        XCTAssertEqual(admission.check(.afterAcquisition, witness), .contextChangedDuringCapture)
        XCTAssertEqual(admission.check(.publication, witness), .contextChangedDuringCapture)

        let running = AdmissionWitness(application: editor, runningExcluded: [Self.vault], filteredExcluded: [])
        XCTAssertNil(admission.check(.beforeAcquisition, running), "running, but showing no window")
        facts.visible = [Self.vault]
        XCTAssertEqual(admission.check(.beforeAcquisition, running), .excludedVisibleApplicationNotCoveredBeforeCapture)
        XCTAssertEqual(admission.check(.afterAcquisition, running), .excludedVisibleApplicationNotCoveredDuringCapture)
        XCTAssertEqual(admission.check(.publication, running), .excludedVisibleApplicationNotCoveredDuringCapture)
    }


    @MainActor
    func testOnePublicationCheckFollowsEveryDisplayAndClosesThemAll() async throws {
        let adapter = TwoDisplays()
        let capture = ScreenCapture(adapter: adapter)
        let results = await Self.finished(try await capture.capture())
        XCTAssertEqual(results.map(\.observation.displayID), [1, 2])
        XCTAssertEqual(adapter.phases, [[.beforeAcquisition, .afterAcquisition], [.beforeAcquisition, .afterAcquisition]])
        XCTAssertEqual(adapter.publicationChecks, 1)

        adapter.publication = .secureInputEnabled
        let closed = await Self.finished(try await capture.capture())
        XCTAssertEqual(closed.map(\.observation.reason), [CaptureGapReason.secureInputEnabled.rawValue],
                       "both displays' images are closed")
        XCTAssertEqual(closed.compactMap(\.image).count, 0)
        XCTAssertEqual(adapter.publicationChecks, 2)
    }


    final class SilencingBrowser: BrowserPageFacts, @unchecked Sendable {
        private var answers: [[BrowserWindow]]
        private(set) var reads = 0

        init(_ answers: [[BrowserWindow]]) { self.answers = answers }

        func windows(pid: Int32, bundleID: String) async -> [BrowserWindow] {
            reads += 1
            return answers.isEmpty ? [] : answers.removeFirst()
        }
    }

    @MainActor
    func testASilentBrowsersFrontPageIsUnreadableNeverItsLastAnswer() async throws {
        let chrome = "com.google.Chrome"
        let bounds = CaptureRect(x: 100, y: 80, width: 900, height: 700)
        let title = "Synthetic page - Example Browser"
        let inventory = [DisplaySelection.Window(id: 501, pid: Self.browser, layer: 0, bounds: bounds, title: title)]
        let modes = RecordingModes(siteExclude: ["video.example"])
        let news = BrowserWindow(bounds: bounds, kind: .standard, page: .site(Site(rule: "news.example")!))
        let pages = SilencingBrowser([[news]])
        let read = { await SitePlan.read(inventory: inventory, modes: modes, pages: pages, bundle: { _ in chrome }) }

        let answered = await read()
        let allowed = try XCTUnwrap(answered.front(of: Self.browser, in: inventory))
        XCTAssertEqual(allowed.page, WindowPage(mode: .record, site: "news.example"))

        let silent = await read()
        let front = try XCTUnwrap(silent.front(of: Self.browser, in: inventory))
        XCTAssertEqual(front.reading, .page(.unknown), "no earlier answer stands in for the page")
        XCTAssertEqual(front.cause, .browserDidNotAnswer)
        XCTAssertEqual(front.page, WindowPage(mode: .exclude, site: nil))
        let gap = ForegroundPageGap(page: front.reading.page ?? .unknown, cause: front.cause)
        XCTAssertEqual(gap.reason, .foregroundPageUnreadable)
        let observation = gap.observation(at: Date(timeIntervalSince1970: 1_700_000_000))
        XCTAssertEqual(observation.reason, CaptureGapReason.foregroundPageUnreadable.rawValue)
        XCTAssertEqual(observation.status, ObservationStatus.excluded.rawValue)
        XCTAssertEqual(observation.pageCause, PageUnknownCause.browserDidNotAnswer.rawValue)
        XCTAssertNil(observation.site)
        XCTAssertTrue(observation.windows.isEmpty, "the gap states no window and no page")
        XCTAssertEqual(silent.filteredBrowsers, [Self.browser])
        XCTAssertTrue(silent.keptWindows.isEmpty)

        XCTAssertFalse(SitePlan.samePages(answered, silent))
        let again = await read()
        XCTAssertFalse(SitePlan.samePages(answered, again), "the read taken once more is still silent")
        XCTAssertEqual(pages.reads, 3)
    }

    @MainActor
    static func finished(_ attempt: CaptureAttempt) async -> [CaptureResult] {
        switch attempt {
        case .done(let results): results
        case .recognizing(_, let finish): await finish()
        }
    }
}

@MainActor
final class PhaseFacts: SystemFacts {
    var running: Set<pid_t> = []
    var visible: Set<Int32>? = []

    var screenRecordingPermitted: Bool { true }
    var sessionPermitsCapture: Bool { true }
    var secureInputEnabled: Bool { false }
    func secureField() -> SecureFieldReading { .none }
    func secureFieldOffMain() async -> SecureFieldReading { .none }
    func frontmostApplication() -> CaptureApplication? {
        CaptureApplication(bundleID: "com.example.editor", name: "Example Editor", pid: DiscoveryTests.editor)
    }
    func frontWindow(pid: Int32) -> FrontWindowReading { .unstated(.focusedWindowUnreadable) }
    func frontWindowOffMain(pid: Int32) async -> FrontWindowReading { frontWindow(pid: pid) }
    func runningPIDs(bundleIDs: Set<String>) -> Set<pid_t> { running }
    func visiblePIDs() -> Set<Int32>? { visible }
}

@MainActor
final class TwoDisplays: CaptureAdapter {
    var publication: CaptureGapReason?
    private(set) var phases: [[CapturePipeline.Phase]] = []
    private(set) var publicationChecks = 0

    func prepare(pipeline: CapturePipeline, ticket: CapturePipeline.Ticket) async throws -> CaptureBatch {
        phases = []
        let requests = [UInt32(1), 2].enumerated().map { index, display in
            CaptureRequest(displayID: display) { [self] in
                phases.append([])
                return CaptureOperation(acquire: {
                    AcquiredCapture(image: try XCTUnwrap(FrontWindowTests.image()),
                        provenance: CaptureAcquisition(backend: "screenshot", receivedAt: FrontWindowTests.at,
                                                       freshness: "screenshot-request-completed"),
                        endedAt: FrontWindowTests.at)
                }, validate: { [self] phase in
                    phases[index].append(phase)
                    return nil
                }, enrich: { acquired in
                    EnrichedCapture(observation: CaptureObservation(capturedAt: FrontWindowTests.at, displayID: display,
                        width: acquired.width, height: acquired.height), image: .png(Data([0x01])), text: Task {
                            RecognizedText(image: RecognizedImage(observations: [], status: .complete, requests: 0,
                                                                  recalled: 0), ms: 0)
                        })
                })
            }
        }
        return CaptureBatch(requests: requests, validate: { [self] in
            publicationChecks += 1
            return publication
        })
    }
}
