import Evidence
import Foundation

@MainActor
protocol SystemFacts {
    var screenRecordingPermitted: Bool { get }
    var sessionPermitsCapture: Bool { get }
    var secureInputEnabled: Bool { get }
    func secureField() -> SecureFieldReading
    func secureFieldOffMain() async -> SecureFieldReading
    func frontmostApplication() -> CaptureApplication?
    func frontWindow(pid: Int32) -> FrontWindowReading
    func frontWindowOffMain(pid: Int32) async -> FrontWindowReading
    func runningPIDs(bundleIDs: Set<String>) -> Set<pid_t>
    func visiblePIDs() -> Set<Int32>?
}
