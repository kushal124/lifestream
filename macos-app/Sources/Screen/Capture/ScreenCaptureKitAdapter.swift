import AppKit
import BrowserPages
import Evidence
import ScreenCaptureKit

@MainActor
final class ScreenCaptureKitAdapter: CaptureAdapter {
    private struct Batch {
        let witness: AdmissionWitness
        let admission: CaptureAdmission
        let modes: RecordingModes
        let excluded: [SCRunningApplication]
        let kept: [SCWindow]
        let privacy: WindowPrivacy
        let plan: SitePlan
        let front: FrontWindowReading
        let owners: WindowOwners
        let selection: CaptureDisplaySelection
        let pipeline: CapturePipeline
        let ticket: CapturePipeline.Ticket
    }

    struct FrameScope {
        let bounds: CaptureRect
        var observation: CaptureObservation
        let targetWindows: [CaptureWindow]
        let pages: AccessibilityPageScope?
        let scopeInventory: [DisplaySelection.Window]
        let front: UInt32?
    }

    struct WindowOwners: Sendable {
        private let known: [Int32: CaptureApplication]
        private let held: [UInt32: Int32]

        init(_ windows: [DisplaySelection.Window], carrying earlier: WindowOwners? = nil) {
            self = ResourceMeter.shared.measure(.capture, units: 0) { Self(looking: windows, carrying: earlier) }
        }

        private init(looking windows: [DisplaySelection.Window], carrying earlier: WindowOwners?) {
            var held: [UInt32: Int32] = [:]
            for window in windows { if let id = window.id { held[id] = window.pid } }
            let carried = Set(held.compactMap { id, pid in earlier?.held[id] == pid ? pid : nil })
            var known: [Int32: CaptureApplication] = [:]
            for window in windows where known[window.pid] == nil {
                known[window.pid] = (carried.contains(window.pid) ? earlier?.known[window.pid] : nil) ?? Self.lookup(window.pid)
            }
            self.known = known
            self.held = held
        }

        func application(_ pid: Int32) -> CaptureApplication { known[pid] ?? Self.lookup(pid) }

        func bundle(_ pid: Int32) -> String? { application(pid).bundleID }

        private static func lookup(_ pid: Int32) -> CaptureApplication {
            let app = NSRunningApplication(processIdentifier: pid)
            return CaptureApplication(bundleID: app?.bundleIdentifier, name: app?.localizedName, pid: pid)
        }
    }

    private struct FrameRequest {
        let filter: SCContentFilter
        let configuration: SCStreamConfiguration
        let scope: FrameScope
    }

    private let configuration: ScreenCapture.Configuration
    private let system: SystemFacts
    private let pages: BrowserPageFacts
    private var modes: RecordingModes
    let recognizer: TextRecognizer
    private var pendingActivity: CaptureObservation?
    private let shareable = ShareableContentCache<SCShareableContent>(read: WindowServerSnapshot.read,
        fetch: { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) },
        windows: { Set($0.windows.map(\.windowID)) })

    init(configuration: ScreenCapture.Configuration, system: SystemFacts,
         pages: BrowserPageFacts = LiveBrowserPages(), reader: @escaping TextRecognizer.Reader) {
        self.configuration = configuration
        self.system = system
        self.pages = pages
        modes = configuration.modes
        recognizer = TextRecognizer(mode: configuration.ocr, reader: reader)
    }

    func apply(_ modes: RecordingModes) {
        self.modes = modes
    }

    func apply(ocr: OCRMode) {
        recognizer.mode = ocr
    }

    func activityOnly() -> CaptureObservation? {
        if let pending = pendingActivity {
            pendingActivity = nil
            return pending
        }
        let admission = CaptureAdmission(modes: modes, system: system)
        guard let application = system.frontmostApplication(),
              application.bundleID.map(admission.activity.contains) == true else { return nil }
        let inventory = WindowInventory.read()
        let owners = WindowOwners(inventory.selection)
        let browsers = Set(SitePlan.browsers(in: inventory.selection, modes: modes, bundle: owners.bundle).map(\.pid))
        let front = system.frontWindow(pid: application.pid)
        var privacy = Self.privacy(admission, modes: modes, plan: .empty) { system.runningPIDs(bundleIDs: $0) }
        privacy.browserPIDs.formUnion(browsers)
        return Self.activityObservation(application: application, inventory: inventory,
            privacy: privacy, at: Date(), front: front, lookup: owners.application)
    }

    static func activityObservation(application: CaptureApplication, inventory: WindowInventory,
        privacy: WindowPrivacy, at date: Date, reason: CaptureGapReason = .foregroundAppActivityOnly,
        site: String? = nil, front: FrontWindowReading, lookup: (Int32) -> CaptureApplication) -> CaptureObservation {
        let windows = inventory.visible(in: nil, privacy: privacy, application: lookup)
        var observation = CaptureObservation(capturedAt: date, displayID: 0, width: 0, height: 0,
            application: application, windows: windows,
            status: ObservationStatus.activityOnly.rawValue, reason: reason.rawValue)
        observation.site = site
        observation.frontWindow = front.stated(in: windows, application: application.pid)
        return observation
    }

    static func privacy(_ admission: CaptureAdmission, modes: RecordingModes, plan: SitePlan,
                        running: (Set<String>) -> Set<Int32>) -> WindowPrivacy {
        WindowPrivacy(excludedPIDs: running(admission.excluded), excluded: admission.excluded,
            activityPIDs: running(admission.activity), activity: admission.activity,
            pages: plan.pagesByWindow, browserPIDs: plan.browserPIDs,
            unreadBrowserMode: modes.hasSiteRules ? .exclude : .record)
    }

    func prepare(pipeline: CapturePipeline, ticket: CapturePipeline.Ticket) async throws -> CaptureBatch {
        pendingActivity = nil
        let modes = self.modes
        let admission = CaptureAdmission(modes: modes, system: system)
        await admission.readFrontOffMain()
        let application: CaptureApplication
        let runningExcluded: Set<pid_t>
        switch admission.beforeDiscovery() {
        case .rejected(.foregroundAppActivityOnly):
            let inventory = WindowInventory.read()
            if let front = system.frontmostApplication(), front.bundleID.map(admission.activity.contains) == true {
                let owners = WindowOwners(inventory.selection)
                let window = await system.frontWindowOffMain(pid: front.pid)
                let plan = await SitePlan.read(inventory: inventory.selection, modes: modes, pages: pages,
                                               bundle: owners.bundle)
                pendingActivity = Self.activityObservation(application: front, inventory: inventory,
                    privacy: Self.privacy(admission, modes: modes, plan: plan) { system.runningPIDs(bundleIDs: $0) },
                    at: Date(), front: window, lookup: owners.application)
            }
            throw CapturePipeline.Failure.rejected(.foregroundAppActivityOnly)
        case .rejected(let reason):
            throw CapturePipeline.Failure.rejected(reason)
        case .admitted(let admitted, let running):
            application = admitted
            runningExcluded = running
        }
        let inventory = WindowInventory.read()
        let owners = WindowOwners(inventory.selection)
        let front = await system.frontWindowOffMain(pid: application.pid)
        let plan = await SitePlan.read(inventory: inventory.selection, modes: modes, pages: pages, bundle: owners.bundle)
        let keptIDs = plan.keptWindows
        let content: SCShareableContent
        do {
            content = try await shareable.content(listing: keptIDs)
        } catch {
            throw CapturePipeline.Failure.rejected(.shareableContentUnavailable)
        }
        guard !content.displays.isEmpty else { throw CapturePipeline.Failure.rejected(.noDisplay) }
        let hidden = Self.filtered(content.applications, hidden: admission.hidden, bundle: \.bundleIdentifier)
        let witness = AdmissionWitness(application: application, runningExcluded: runningExcluded,
            filteredExcluded: Set(hidden.map(\.processID)))
        let privacy = Self.privacy(admission, modes: modes, plan: plan) { bundles in
            Set(hidden.filter { bundles.contains($0.bundleIdentifier) }.map(\.processID))
        }
        if let page = plan.front(of: application.pid, in: inventory.selection) {
            switch page.page.mode {
            case .exclude:
                throw CapturePipeline.Failure.excludedPage(ForegroundPageGap(page: page.reading.page ?? .unknown,
                                                                             cause: page.cause))
            case .activity:
                pendingActivity = Self.activityObservation(application: application, inventory: inventory,
                    privacy: privacy, at: Date(), reason: .foregroundSiteActivityOnly, site: page.page.site,
                    front: front, lookup: owners.application)
                throw CapturePipeline.Failure.rejected(.foregroundSiteActivityOnly)
            case .record:
                break
            }
        }
        let browsers = plan.filteredBrowsers
        let excluded = hidden + content.applications.filter {
            browsers.contains($0.processID) && !hidden.contains($0)
        }
        let kept = content.windows.filter { keptIDs.contains($0.windowID) }
        let selection = DisplaySelection.select(
            displays: content.displays.map { .init(id: $0.displayID, bounds: CaptureRect($0.frame)) },
            windows: inventory.selection, foregroundPID: application.pid,
            primaryDisplayID: CGMainDisplayID(), allDisplays: configuration.allDisplays)
        let liveDisplays = Set(selection.displayIDs)
        guard !liveDisplays.isEmpty else { throw CapturePipeline.Failure.rejected(.noValidDisplay) }
        recognizer.retain(displays: Set(content.displays.map(\.displayID)))
        let batch = Batch(witness: witness, admission: admission, modes: modes, excluded: excluded, kept: kept,
            privacy: privacy, plan: plan, front: front, owners: owners,
            selection: selection.provenance, pipeline: pipeline, ticket: ticket)
        let displays = content.displays.filter { liveDisplays.contains($0.displayID) }
        let requests = displays.enumerated().map { index, display in
            CaptureRequest(displayID: display.displayID) { [self] in
                let fresh = index == 0 ? inventory : WindowInventory.read()
                return try operation(display: display, inventory: fresh, batch: batch)
            }
        }
        return CaptureBatch(requests: requests, validate: { [admission] in admission.check(.publication, witness) })
    }

    static func filtered<Application>(_ applications: [Application], hidden: Set<String>,
        bundle: (Application) -> String) -> [Application] {
        applications.filter { hidden.contains(bundle($0)) }
    }

    func enrich(_ acquired: AcquiredCapture, observation initial: CaptureObservation,
        accessibility: @escaping @MainActor () async -> AccessibilitySnapshot,
        vision: @escaping TextRecognizer.Vision,
        timing: StepTiming? = nil) async throws -> EnrichedCapture {
        guard let application = initial.application else {
            throw CapturePipeline.Failure.rejected(.noFocusedApplication)
        }
        async let accessibilitySnapshot = accessibility()
        let image = try acquired.takeImage()
        let bytes = ImageBytes.materialize(image)
        let requested = StepTiming.now()
        let recognition = await recognizer.start(image, bytes: bytes, display: initial.displayID, vision: vision)
        let text = Task { RecognizedText(image: await recognition.value, ms: StepTiming.since(requested)) }
        let savedImage = try await ImageConversion.capture(image, bytes: bytes)
        var observation = initial
        observation.width = acquired.width
        observation.height = acquired.height
        observation.accessibility = await accessibilitySnapshot
        observation.acquisition = acquired.provenance
        observation.capturedUntil = acquired.endedAt
        observation.ocrScope = CaptureOCRScope(requested: "display", effective: "display", focusedPID: application.pid)
        return EnrichedCapture(observation: observation, image: savedImage, text: text)
    }

    private func operation(display: SCDisplay, inventory: WindowInventory, batch: Batch) throws -> CaptureOperation {
        let started = Date()
        guard !Task.isCancelled else { throw CapturePipeline.Failure.rejected(.captureCancelled) }
        let request = try frameRequest(display: display, inventory: inventory, batch: batch, started: started)
        let timing = StepTiming()
        return CaptureOperation(
            acquire: { [self] in
                let shot = StepTiming.now()
                let image = try await SCScreenshotManager.captureImage(contentFilter: request.filter,
                    configuration: request.configuration)
                let provenance = CaptureAcquisition(backend: "screenshot", receivedAt: Date(),
                    freshness: "screenshot-request-completed")
                let acquired = AcquiredCapture(image: image, provenance: provenance, endedAt: Date())
                timing.timings.screenshotMs = StepTiming.since(shot)
                let check = StepTiming.now()
                try await confirmPages(batch)
                timing.timings.pageCheckMs = StepTiming.since(check)
                return acquired
            },
            validate: { phase in batch.admission.check(phase, batch.witness) },
            enrich: { [self] acquired in
                let began = StepTiming.now()
                var enriched = try await enrich(acquired, observation: request.scope.observation,
                    accessibility: { [self] in await scopedAccessibility(request, batch: batch) },
                    vision: VisionRecognizer.read,
                    timing: timing)
                timing.timings.enrichMs = StepTiming.since(began)
                enriched.observation.timings = timing.timings
                return enriched
            })
    }

    private func confirmPages(_ batch: Batch) async throws {
        let inventory = WindowInventory.read().selection
        let owners = WindowOwners(inventory, carrying: batch.owners)
        for _ in 0..<2 {
            let after = await SitePlan.read(inventory: inventory, modes: batch.modes, pages: pages, bundle: owners.bundle)
            if SitePlan.samePages(batch.plan, after) { return }
        }
        throw CapturePipeline.Failure.rejected(.siteChangedDuringCapture)
    }

    private func frameRequest(display: SCDisplay, inventory: WindowInventory, batch: Batch,
                              started: Date) throws -> FrameRequest {
        let filter = SCContentFilter(display: display, excludingApplications: batch.excluded,
                                     exceptingWindows: batch.kept)
        let nativeWidth = Int((display.frame.width * CGFloat(filter.pointPixelScale)).rounded())
        let nativeHeight = Int((display.frame.height * CGFloat(filter.pointPixelScale)).rounded())
        guard let scaling = CaptureScaling.plan(width: nativeWidth, height: nativeHeight,
                  maximumHeight: configuration.maximumHeight, maximumDimension: configuration.maximumDimension),
              CGDisplayCopyDisplayMode(display.displayID) != nil else {
            throw CapturePipeline.Failure.rejected(.invalidCaptureSizeOrDisplayMode)
        }
        let settings = SCStreamConfiguration()
        settings.width = scaling.requestedWidth
        settings.height = scaling.requestedHeight
        settings.showsCursor = false
        settings.capturesAudio = false
        var scope = Self.frameScope(inventory: inventory, bounds: CaptureRect(display.frame), displayID: display.displayID,
            application: batch.witness.application, privacy: batch.privacy, plan: batch.plan, modes: batch.modes,
            front: batch.front, selection: batch.selection, at: started,
            lookup: WindowOwners(inventory.selection, carrying: batch.owners).application)
        scope.observation.scaling = scaling
        return FrameRequest(filter: filter, configuration: settings, scope: scope)
    }

    static func frameScope(inventory: WindowInventory, bounds: CaptureRect, displayID: UInt32,
        application: CaptureApplication, privacy: WindowPrivacy, plan: SitePlan, modes: RecordingModes,
        front: FrontWindowReading, selection: CaptureDisplaySelection,
        at started: Date, lookup: (Int32) -> CaptureApplication) -> FrameScope {
        let pid = application.pid
        let windows = inventory.visible(in: bounds, privacy: privacy, application: lookup)
        let scopeInventory = inventory.selection.filter {
            $0.pid == pid && $0.layer == 0 && AccessibilityWindowCorrelation.intersects($0.bounds, bounds)
        }
        let correlated = scopeInventory.compactMap { candidate in
            windows.first {
                $0.windowID == candidate.id && $0.application?.pid == candidate.pid && $0.bounds == candidate.bounds
            }
        }
        let readable = correlated.filter { plan.mode(of: $0.windowID) == .record }
        let listed = Set(correlated.map(\.windowID))
        let accounted = scopeInventory.allSatisfy { window in
            guard let id = window.id else { return false }
            return listed.contains(id) || plan.mode(of: id) != .record
        }
        let browser = plan.browserPIDs.contains(pid)
        let pages = browser ? application.bundleID.map {
            AccessibilityPageScope(bundleID: $0, modes: modes)
        } : nil
        var observation = CaptureObservation(capturedAt: started, displayID: displayID,
            width: 0, height: 0, application: application, windows: windows,
            reason: "foreground-pid-matched-around-image-acquisition; non-atomic-observation")
        observation.displayBounds = bounds
        observation.displaySelection = selection
        observation.frontWindow = front.stated(in: windows, application: pid)
        let targets = accounted && (!browser || pages != nil) ? readable : []
        let walked = observation.frontWindow?.windowID.flatMap { id in targets.contains { $0.windowID == id } ? id : nil }
        return FrameScope(bounds: bounds, observation: observation, targetWindows: targets, pages: pages,
                          scopeInventory: scopeInventory, front: walked)
    }

    private func scopedAccessibility(_ request: FrameRequest, batch: Batch) async -> AccessibilitySnapshot {
        let started = Date()
        let pid = batch.witness.application.pid
        let scope = request.scope
        let snapshot = await batch.pipeline.scoped(ticket: batch.ticket, read: {
            await AccessibilityReader.capture(pid: pid, windows: scope.targetWindows, display: scope.bounds,
                                              pages: scope.pages, front: scope.front)
        }, validate: {
            WindowInventory.read().matchesScope(scope.scopeInventory, pid: pid, display: scope.bounds)
        })
        if let snapshot { return snapshot }
        var invalid = AccessibilitySnapshot(capturedAt: started,
            status: AccessibilityStatus.windowChangedDuringCapture.rawValue, nodes: [], capturedUntil: Date())
        invalid.windowCorrelation = "changed-during-capture"
        invalid.limitReasons = ["window-or-context-changed-during-ax"]
        return invalid
    }
}
