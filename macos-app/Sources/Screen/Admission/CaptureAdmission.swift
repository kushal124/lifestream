import CoreGraphics
import Evidence

struct AdmissionWitness: Equatable {
    let application: CaptureApplication
    let runningExcluded: Set<pid_t>
    let filteredExcluded: Set<pid_t>
}

@MainActor
struct CaptureAdmission {
    static let loginWindowBundleID = "com.apple.loginwindow"

    enum Discovery: Equatable {
        case admitted(CaptureApplication, runningExcluded: Set<pid_t>)
        case rejected(CaptureGapReason)
    }

    let excluded: Set<String>
    let activity: Set<String>
    let system: SystemFacts
    let front: SecureFieldOnce

    var hidden: Set<String> { excluded.union(activity) }

    init(excluded: Set<String>, activity: Set<String> = [], system: SystemFacts) {
        self.excluded = excluded
        self.activity = activity.subtracting(excluded)
        self.system = system
        front = SecureFieldOnce(read: { system.secureField() })
    }

    init(modes: RecordingModes, system: SystemFacts) {
        self.init(excluded: modes.excluded, activity: modes.activity, system: system)
    }

    static func requiresHardInvalidation(bundleID: String?, hidden: Set<String>) -> Bool {
        guard let bundleID else { return true }
        return bundleID == loginWindowBundleID || hidden.contains(bundleID)
    }

    func beforeDiscovery() -> Discovery {
        ResourceMeter.shared.measure(.capture, units: 0) { discover() }
    }

    private func discover() -> Discovery {
        switch foreground() {
        case .rejected(let reason):
            return .rejected(reason)
        case .admitted(let application):
            return .admitted(application, runningExcluded: system.runningPIDs(bundleIDs: hidden))
        }
    }

    func check(_ phase: CapturePipeline.Phase, _ witness: AdmissionWitness) -> CaptureGapReason? {
        ResourceMeter.shared.measure(.capture, units: 0) { judge(phase, witness) }
    }

    private func judge(_ phase: CapturePipeline.Phase, _ witness: AdmissionWitness) -> CaptureGapReason? {
        let before = phase == .beforeAcquisition
        if case .rejected(let reason) = foreground() { return reason }
        guard system.runningPIDs(bundleIDs: hidden) == witness.runningExcluded else {
            return before ? .contextChangedBeforeCapture : .contextChangedDuringCapture
        }
        guard hidden.isEmpty || coversVisibleExcluded(witness) else {
            return before ? .excludedVisibleApplicationNotCoveredBeforeCapture
                : .excludedVisibleApplicationNotCoveredDuringCapture
        }
        guard phase != .publication, system.frontmostApplication()?.pid != witness.application.pid else { return nil }
        return before ? .contextChangedBeforeCapture : .contextChangedDuringCapture
    }

    private enum Foreground {
        case admitted(CaptureApplication)
        case rejected(CaptureGapReason)
    }

    func readFrontOffMain() async {
        guard system.secureInputEnabled else { return }
        front.seed(await system.secureFieldOffMain())
    }

    private func foreground() -> Foreground {
        guard system.screenRecordingPermitted else { return .rejected(.screenRecordingPermissionDenied) }
        guard system.sessionPermitsCapture else { return .rejected(.sessionLockedOrUnavailable) }
        if let reason = SecureInputRule.withheld(secureInput: system.secureInputEnabled, field: front.read) {
            return .rejected(reason)
        }
        guard let application = system.frontmostApplication() else { return .rejected(.noFocusedApplication) }
        guard application.bundleID != Self.loginWindowBundleID else { return .rejected(.loginWindowActive) }
        if application.bundleID.map(excluded.contains) == true { return .rejected(.foregroundAppExcluded) }
        if application.bundleID.map(activity.contains) == true { return .rejected(.foregroundAppActivityOnly) }
        return .admitted(application)
    }

    private func coversVisibleExcluded(_ witness: AdmissionWitness) -> Bool {
        ExcludedApplicationCoverage.permits(running: witness.runningExcluded,
            filtered: witness.filteredExcluded, visible: system.visiblePIDs())
    }
}
