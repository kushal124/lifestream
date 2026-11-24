import Cockpit
import Foundation
import LifestreamCaptureCore
import os
import SwiftUI

@MainActor
final class CaptureAppModel: ObservableObject {
    private static let log = Logger(subsystem: "org.lifestreamprotocol.phone", category: "shipping")
    @Published var export: ActOutcome = .idle
    @Published var locationCountToday = 0
    @Published var eventCountToday = 0
    @Published var motionCountToday = 0
    @Published var healthCountToday = 0
    @Published var cameraCountToday = 0
    @Published var photosCountToday = 0
    @Published var voiceCountToday = 0
    @Published var week: [CaptureDomain: [Int]] = [:]
    @Published var last: [CaptureDomain: Date] = [:]
    @Published var lastFixDate: Date?
    @Published var coverageState: CoverageState = .unknown
    @Published var recorderOperationalState = "not_started"
    @Published var serviceRequested: Bool?
    @Published var startingCapture: ActOutcome = .idle
    @Published var platformDiagnostic = "No diagnostic yet"
    @Published var backgroundRefresh = "Checking"
    @Published var livenessSamples: [Double] = []
    @Published var wholeDeviceBatteryChangePercent: Double?

    let runtime: AppRuntime
    private var isRefreshing = false

    init(runtime: AppRuntime) {
        self.runtime = runtime
        coverageState = runtime.locationRecorder.coverageState
        recorderOperationalState = runtime.locationRecorder.operationalState
        serviceRequested = runtime.locationRecorder.serviceRequested
        if let diagnostic = runtime.locationRecorder.persistenceDiagnostic {
            platformDiagnostic = diagnostic
        }
        Task { await refresh() }
    }

    func startCapture() {
        Task { await start() }
    }

    func start() async {
        guard !startingCapture.running else { return }
        await ActOutcome.run(\.startingCapture, of: self) { try await runtime.startCapture() }
        serviceRequested = runtime.locationRecorder.serviceRequested
        await refresh()
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let summary = try await runtime.captureStore.statusSummary()
            locationCountToday = summary.locationFixesToday
            eventCountToday = summary.locationEventsToday
            motionCountToday = summary.motionEntriesToday
            healthCountToday = summary.healthEntriesToday
            cameraCountToday = summary.cameraEntriesToday
            photosCountToday = summary.photosEntriesToday
            voiceCountToday = summary.voiceEntriesToday
            week = summary.week
            last = summary.last
            lastFixDate = summary.lastFixObservedAt.flatMap(CaptureTime.date(rfc3339:))
            coverageState = runtime.locationRecorder.coverageState
            recorderOperationalState = runtime.locationRecorder.operationalState
            serviceRequested = runtime.locationRecorder.serviceRequested
            if let diagnostic = runtime.locationRecorder.persistenceDiagnostic {
                platformDiagnostic = diagnostic
            } else {
                platformDiagnostic = Self.coverageDescription(
                    runtime.locationRecorder.coverageState,
                    reason: runtime.locationRecorder.lastPlatformDiagnostic
                )
            }
            backgroundRefresh = Self.backgroundRefreshDescription(
                UIApplication.shared.backgroundRefreshStatus)
            wholeDeviceBatteryChangePercent =
                runtime.captureStateMonitor.wholeDeviceBatteryChangePercent
            let now = AppClock.now
            var hourly = Array(repeating: 0.0, count: 24)
            for wallTime in summary.recorderHealthEventWallTimes {
                let age = max(0, now.timeIntervalSince1970 - wallTime)
                let bucket = max(0, min(23, 23 - Int(age / 3_600)))
                hourly[bucket] += 1
            }
            let peak = max(1, hourly.max() ?? 1)
            livenessSamples = hourly.map { min(1, $0 / peak) }
        } catch {
            Self.log.error("A status read did not finish: \(String(describing: error), privacy: .public)")
        }
    }

    @discardableResult
    func makeExport() async -> [URL] {
        let files = await ActOutcome.run(\.export, of: self, said: Self.exportFailed) {
            if AppRuntime.asked("--ui-test-export-fails"), !exportFailedOnce {
                exportFailedOnce = true
                throw PhoneShipper.NothingToExport(errorDescription: "This phone couldn't build the export. Try again in a moment.")
            }
            return try await runtime.shipping.shipper.export()
        }
        guard let files else { return [] }
        await refresh()
        return files
    }

    private var exportFailedOnce = false

    private static func exportFailed(_ error: any Error) -> ActOutcome {
        if let nothing = error as? PhoneShipper.NothingToExport, let words = nothing.errorDescription {
            return .failed(.refused(words))
        }
        log.error("An export did not finish: \(String(describing: error), privacy: .public)")
        return .failed(.refused("This phone couldn't build the export. Try again in a moment."))
    }
}

extension CaptureAppModel {
    func lastFixAge(at now: Date) -> String {
        Self.lastFixAge(lastFixDate: lastFixDate, at: now)
    }

    static func lastFixAge(lastFixDate: Date?, at now: Date) -> String {
        guard let lastFixDate else { return "None yet" }
        let seconds = now.timeIntervalSince(lastFixDate)
        if seconds < -1 { return "Clock skew (+\(Self.duration(Int(-seconds))))" }
        return "\(Self.duration(Int(max(0, seconds)))) ago"
    }

    private static func duration(_ seconds: Int) -> String {
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3_600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3_600)h \((seconds % 3_600) / 60)m" }
        return "\(seconds / 86_400)d \((seconds % 86_400) / 3_600)h"
    }

    static func coverageDescription(_ state: CoverageState, reason: String) -> String {
        switch state {
        case .stationaryAutoPaused: return "Stationary / OS-paused — quiet is expected"
        case .highRateExpected: return "Recent active delivery — \(reason)"
        case .authorizationBlocked: return "Location permission blocked"
        case .accuracyDegraded: return "Reduced location accuracy"
        case .locationUnavailable: return "Location currently unavailable"
        case .coarseFallbackOnly: return "Resurrection lattice only"
        case .processAbsence: return "Prior process absence inferred"
        case .deviceOffOrPreunlock: return "Device-off or pre-unlock absence inferred"
        case .unknown: return "Requested; delivery state unknown"
        }
    }

    static func serviceRequestDescription(_ requested: Bool?) -> String {
        switch requested {
        case true: "Yes"
        case false: "No"
        case nil: "Unknown — persistence failure"
        }
    }

    static func backgroundRefreshDescription(_ status: UIBackgroundRefreshStatus) -> String {
        switch status {
        case .available: return "Available"
        case .denied: return "Denied in Settings"
        case .restricted: return "Restricted"
        @unknown default: return "Unknown"
        }
    }
}
