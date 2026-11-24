#if !APP_STORE
import Cockpit
import Foundation
import LifestreamCaptureCore
import SwiftUI


@MainActor
enum DeliberateCrashRequest {
    static func persistMarkerThenSchedule(
        persistMarker: () async throws -> Void,
        scheduleCrash: () -> Void
    ) async throws {
        try await persistMarker()
        scheduleCrash()
    }
}

extension CaptureAppModel {
    func markExperiment(_ marker: String) async throws {
        let observedAt = CaptureTime.rfc3339(AppClock.now)
        try await runtime.recordExperimentMarker(
            marker,
            observedAt: observedAt
        )
        await refresh()
    }

    func requestDeliberateCrash(
        scheduleCrash: @escaping @MainActor () -> Void = {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                fatalError("E2 deliberate crash")
            }
        }
    ) async throws {
        let observedAt = CaptureTime.rfc3339(AppClock.now)
        try await DeliberateCrashRequest.persistMarkerThenSchedule(
            persistMarker: {
                try await self.runtime.recordExperimentMarker(
                    "e2_deliberate_crash_requested",
                    observedAt: observedAt
                )
            },
            scheduleCrash: scheduleCrash
        )
    }
}

struct ExperimentsView: View {
    @EnvironmentObject private var model: CaptureAppModel
    @State private var confirmCrash = false
    @State private var outcomes: [String: ActOutcome] = [:]

    var body: some View {
        SheetPage("Experiments") {
            SheetPart("Markers", line: "Each press writes a marker into this iPhone's log, now.") {
                marker("Mark movement start (E4)", "e4_movement_start")
                marker("Mark trip end (E4)", "e4_trip_end")
                marker("Mark death-matrix step (E2)", "e2_step", separator: false)
            }
            SheetPart("First run", line: "Opens Welcome again. Permissions and pairing stay as they are.") {
                ListRow("Start the first run again", chevron: false, separator: false, action: startFirstRunAgain)
                    .environment(\.cockpitRowActs, true)
                    .accessibilityIdentifier("experiments.first-run")
            }
            SheetPart("Death matrix", line: "Ends the app at once, after a marker says it was asked.") {
                ListRow("Crash the app", chevron: false, separator: false, action: { confirmCrash = true })
                    .environment(\.cockpitRowWarns, true)
                    .accessibilityIdentifier("experiments.crash")
                    .actOutcome(outcomes[Self.crash] ?? .idle) { confirmCrash = true }
            }
        }
        .confirmationDialog("Crash the app now?", isPresented: $confirmCrash, titleVisibility: .visible) {
            Button("Crash the app", role: .destructive) {
                perform(Self.crash) {
                    try await model.requestDeliberateCrash()
                }
            }
            Button("Not now", role: .cancel) {}
        }
    }

    private func startFirstRunAgain() {
        AppNavigation.shared.presented = nil
        model.runtime.firstRun.again()
    }

    private func marker(_ title: String, _ marker: String, separator: Bool = true) -> some View {
        let write = { perform(marker) { try await model.markExperiment(marker) } }
        return ListRow(title, chevron: false, separator: separator, action: write)
            .environment(\.cockpitRowActs, true)
            .accessibilityIdentifier("experiments.marker.\(marker)")
            .actOutcome(outcomes[marker] ?? .idle, retry: write)
    }

    private static let crash = "e2_deliberate_crash_requested"

    private func perform(_ key: String, _ operation: @escaping @MainActor () async throws -> Void) {
        Task { @MainActor in
            await ActOutcome.run(Binding(get: { outcomes[key] ?? .idle }, set: { outcomes[key] = $0 }), operation)
        }
    }
}
#endif
