import Evidence
import Foundation

@MainActor
final class StepTiming {
    var timings = CaptureTimings()

    nonisolated static func now() -> Double { ProcessInfo.processInfo.systemUptime }

    nonisolated static func since(_ start: Double) -> Int { CaptureTimings.milliseconds(now() - start) }
}
