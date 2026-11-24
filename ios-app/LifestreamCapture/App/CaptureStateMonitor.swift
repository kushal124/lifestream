import Foundation
import LifestreamCaptureCore
@preconcurrency import MetricKit
import UIKit

enum BatteryLedger {
    static func shouldResetBaseline(
        priorDay: String?,
        baseline: Double?,
        currentDay: String,
        level: Double,
        charging: Bool
    ) -> Bool {
        priorDay != currentDay || baseline == nil || charging || ((baseline ?? -1) < 0 && level >= 0)
    }

    static func costPercent(baseline: Double, level: Double) -> Double? {
        guard baseline >= 0, level >= 0 else { return nil }
        return max(0, (baseline - level) * 100)
    }
}

struct CaptureStateCadence {
    struct Plan: Equatable {
        let recordEvidence: Bool
        let applyResourcePressure: Bool
    }

    private var lastEvidence: [String: JSONValue]?
    private var lastDegradedState: Bool?

    mutating func plan(detail: [String: JSONValue], degraded: Bool) -> Plan {
        var evidence = detail
        evidence["reason"] = nil
        let plan = Plan(
            recordEvidence: evidence != lastEvidence,
            applyResourcePressure: degraded != lastDegradedState
        )
        lastEvidence = evidence
        lastDegradedState = degraded
        return plan
    }
}

private struct MetricPayloadSnapshot: Sendable {
    let bytes: Data
    let rangeStart: Date
    let rangeEnd: Date
    let latestApplicationVersion: String
    let includesMultipleApplicationVersions: Bool

    nonisolated init(_ payload: MXDiagnosticPayload) {
        bytes = payload.jsonRepresentation()
        rangeStart = payload.timeStampBegin
        rangeEnd = payload.timeStampEnd
        latestApplicationVersion = ""
        includesMultipleApplicationVersions = false
    }

    nonisolated init(_ payload: MXMetricPayload) {
        bytes = payload.jsonRepresentation()
        rangeStart = payload.timeStampBegin
        rangeEnd = payload.timeStampEnd
        latestApplicationVersion = payload.latestApplicationVersion
        includesMultipleApplicationVersions = payload.includesMultipleApplicationVersions
    }
}

@MainActor
final class CaptureStateMonitor: NSObject, MXMetricManagerSubscriber {
    private weak var locationRecorder: LocationRecorderCoordinator?
    private let energy: EnergyLedger
    private var observers: [NSObjectProtocol] = []
    private var pollTimer: Timer?
    private var cadence = CaptureStateCadence()
    private let defaults = UserDefaults.standard

    private(set) var wholeDeviceBatteryChangePercent: Double?

    init(locationRecorder: LocationRecorderCoordinator, energy: EnergyLedger = .shared) {
        self.locationRecorder = locationRecorder
        self.energy = energy
        super.init()
    }

    func start() {
        guard observers.isEmpty else { return }
        UIDevice.current.isBatteryMonitoringEnabled = true
        MXMetricManager.shared.add(self)
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            UIDevice.batteryLevelDidChangeNotification,
            UIDevice.batteryStateDidChangeNotification,
            .NSProcessInfoPowerStateDidChange,
            ProcessInfo.thermalStateDidChangeNotification,
            UIApplication.backgroundRefreshStatusDidChangeNotification,
            UIApplication.significantTimeChangeNotification,
        ]
        observers = names.map { name in
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    self?.sample(reason: "notification:\(name.rawValue)")
                }
            }
        }
        pollTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.sample(reason: "five_minute_poll")
            }
        }
        sample(reason: "monitor_started")
        for payload in MXMetricManager.shared.pastPayloads {
            recordMetricPayload(MetricPayloadSnapshot(payload), delivery: "past_payload")
        }
        for payload in MXMetricManager.shared.pastDiagnosticPayloads {
            recordDiagnosticPayload(MetricPayloadSnapshot(payload), delivery: "past_payload")
        }
    }

    nonisolated func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let snapshots = payloads.map(MetricPayloadSnapshot.init)
        Task { @MainActor [weak self] in
            for snapshot in snapshots {
                self?.recordDiagnosticPayload(snapshot, delivery: "subscriber")
            }
        }
    }

    nonisolated func didReceive(_ payloads: [MXMetricPayload]) {
        let snapshots = payloads.map(MetricPayloadSnapshot.init)
        Task { @MainActor [weak self] in
            for snapshot in snapshots {
                self?.recordMetricPayload(snapshot, delivery: "subscriber")
            }
        }
    }

    func sample(reason: String) {
        let device = UIDevice.current
        let process = ProcessInfo.processInfo
        let level = Double(device.batteryLevel)
        let day = Self.dayKey(AppClock.now)
        let baselineDayKey = "battery-ledger.day"
        let baselineLevelKey = "battery-ledger.baseline-level"
        let priorDay = defaults.string(forKey: baselineDayKey)
        let priorBaseline = defaults.object(forKey: baselineLevelKey).map { _ in
            defaults.double(forKey: baselineLevelKey)
        }
        let charging = device.batteryState == .charging || device.batteryState == .full
        if BatteryLedger.shouldResetBaseline(
            priorDay: priorDay,
            baseline: priorBaseline,
            currentDay: day,
            level: level,
            charging: charging
        ) {
            defaults.set(day, forKey: baselineDayKey)
            defaults.set(level, forKey: baselineLevelKey)
        }
        let baseline = defaults.double(forKey: baselineLevelKey)
        wholeDeviceBatteryChangePercent = BatteryLedger.costPercent(baseline: baseline, level: level)

        let thermallySerious = process.thermalState == .serious || process.thermalState == .critical
        let batteryCritical = level >= 0 && level < 0.15 && !charging
        let degraded = RecorderTuning.requiresDegradedMode(
            batteryLevel: level,
            charging: charging,
            thermalState: process.thermalState
        )
        let degradedReason: String
        if thermallySerious { degradedReason = "thermal_\(String(describing: process.thermalState))" }
        else if batteryCritical { degradedReason = "battery_below_15_percent" }
        else { degradedReason = "none" }

        let detail: [String: JSONValue] = [
            "reason": .string(reason),
            "battery_level": .number(level),
            "battery_state": .string(String(describing: device.batteryState)),
            "whole_device_battery_change_percent": wholeDeviceBatteryChangePercent.map(JSONValue.number) ?? .null,
            "estimate_method": .string("same-day_unplugged_level_delta; charging_resets_baseline"),
            "low_power_mode": .bool(process.isLowPowerModeEnabled),
            "thermal_state": .string(String(describing: process.thermalState)),
            "background_refresh_status": .string(String(describing: UIApplication.shared.backgroundRefreshStatus)),
            "degraded": .bool(degraded),
            "degraded_reason": .string(degradedReason),
            "timezone_identifier": .string(TimeZone.current.identifier),
        ]
        let plan = cadence.plan(detail: detail, degraded: degraded)
        if plan.recordEvidence {
            energy.record(kind: "power_state", payload: .object(detail), at: AppClock.now)
        }
        if plan.applyResourcePressure {
            locationRecorder?.resourcePressureChanged(degraded: degraded, reason: degradedReason)
        }
    }

    private func recordMetricPayload(_ payload: MetricPayloadSnapshot, delivery: String) {
        energy.record(kind: "metrickit_payload", payload: .object([
            "delivery": .string(delivery),
            "range_start": .string(CaptureTime.rfc3339(payload.rangeStart)),
            "range_end": .string(CaptureTime.rfc3339(payload.rangeEnd)),
            "latest_application_version": .string(payload.latestApplicationVersion),
            "includes_multiple_application_versions": .bool(payload.includesMultipleApplicationVersions),
            "json_base64": .string(payload.bytes.base64EncodedString()),
            "json_bytes": .integer(Int64(payload.bytes.count)),
        ]), at: AppClock.now)
    }

    private func recordDiagnosticPayload(_ payload: MetricPayloadSnapshot, delivery: String) {
        energy.record(kind: "metrickit_diagnostic", payload: .object([
            "delivery": .string(delivery),
            "range_start": .string(CaptureTime.rfc3339(payload.rangeStart)),
            "range_end": .string(CaptureTime.rfc3339(payload.rangeEnd)),
            "json_base64": .string(payload.bytes.base64EncodedString()),
            "json_bytes": .integer(Int64(payload.bytes.count)),
        ]), at: AppClock.now)
    }

    private static func dayKey(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}
