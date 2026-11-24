import CoreLocation
import Foundation
import LifestreamCaptureCore

struct RequestedLocationConfiguration {
    var desiredAccuracy: CLLocationAccuracy
    var distanceFilter: CLLocationDistance
    var activityType: CLActivityType
    var pausesAutomatically: Bool
    var legacyKnobsApplied = true
    var liveUpdateConfiguration: String? = nil

    var json: [String: JSONValue] {
        [
            "desired_accuracy_m": legacyKnobsApplied ? .number(desiredAccuracy) : .null,
            "distance_filter_m": legacyKnobsApplied ? .number(distanceFilter) : .null,
            "activity_type": legacyKnobsApplied ? .string(activityType.captureName) : .null,
            "pauses_automatically": legacyKnobsApplied ? .bool(pausesAutomatically) : .null,
            "target_distance_policy_m": .number(distanceFilter),
            "live_update_configuration": liveUpdateConfiguration.map(JSONValue.string) ?? .null,
        ]
    }
}

enum MotionTravelMode: String {
    case stationary
    case walking
    case vehicle
    case uncertain
}

enum RecorderTuning {
    static func settleHysteresis(for mode: MotionTravelMode) -> TimeInterval {
        switch mode {
        case .walking: 120
        case .vehicle: 300
        case .stationary, .uncertain: 180
        }
    }

    static func stationaryClusterRadius(
        candidateAccuracy: CLLocationAccuracy,
        currentAccuracy: CLLocationAccuracy
    ) -> CLLocationDistance? {
        StillWatch.clusterReach(centreAccuracy: candidateAccuracy, fixAccuracy: currentAccuracy)
    }

    static func appearsStationary(_ location: CLLocation, relativeTo candidate: CLLocation?) -> Bool {
        if location.speed >= 0.5 { return false }
        guard location.horizontalAccuracy >= 0 else { return false }
        guard let candidate else { return true }
        guard let radius = stationaryClusterRadius(
            candidateAccuracy: candidate.horizontalAccuracy,
            currentAccuracy: location.horizontalAccuracy
        ) else { return false }
        return location.distance(from: candidate) <= radius
    }

    static func dwellSeconds(since start: TimeInterval, now: TimeInterval) -> TimeInterval {
        max(0, now - start)
    }

    static func requiresDegradedMode(
        batteryLevel: Double,
        charging: Bool,
        thermalState: ProcessInfo.ThermalState
    ) -> Bool {
        let thermallySerious = thermalState == .serious || thermalState == .critical
        let batteryCritical = batteryLevel >= 0 && batteryLevel < 0.15 && !charging
        return thermallySerious || batteryCritical
    }
}

enum GapEvidence {
    static func payload(
        start: String,
        end: String,
        reason: String,
        evidence: ReasonEvidence,
        expected: CoverageState,
        priorSequence: UInt64?
    ) -> JSONValue {
        .object([
            "start": .string(start),
            "end": .string(end),
            "expected_coverage": .string(expected.rawValue),
            "reason": .string(reason),
            "reason_evidence": .string(evidence.rawValue),
            "confidence": .string(evidence == .observed ? "high" : "unknown"),
            "bounding_previous_fix_observed_at": .string(start),
            "bounding_previous_fix_sequence": priorSequence.map(JSONValue.unsigned) ?? .null,
            "bounding_next_fix_observed_at": .string(end),
            "fabricated_coordinates": .bool(false),
        ])
    }
}

enum LocationBatchBookkeeping {
    struct Silence: Equatable {
        let start: Date
        let endIndex: Int
    }

    static func earliestIndex(after boundary: Date, in locations: [CLLocation]) -> Int? {
        locations.indices
            .filter { locations[$0].timestamp > boundary }
            .min { lhs, rhs in
                let left = locations[lhs].timestamp
                let right = locations[rhs].timestamp
                return left == right ? lhs < rhs : left < right
            }
    }

    static func latestIndex(in locations: [CLLocation]) -> Int? {
        locations.indices.max { lhs, rhs in
            let left = locations[lhs].timestamp
            let right = locations[rhs].timestamp
            return left == right ? lhs < rhs : left < right
        }
    }

    static func silences(
        after boundary: Date,
        exceeding threshold: TimeInterval,
        in locations: [CLLocation]
    ) -> [Silence] {
        let ordered = locations.indices
            .filter { locations[$0].timestamp > boundary }
            .sorted { lhs, rhs in
                let left = locations[lhs].timestamp
                let right = locations[rhs].timestamp
                return left == right ? lhs < rhs : left < right
            }
        var prior = boundary
        var result: [Silence] = []
        for index in ordered {
            let timestamp = locations[index].timestamp
            if timestamp.timeIntervalSince(prior) > threshold {
                result.append(.init(start: prior, endIndex: index))
            }
            if timestamp > prior { prior = timestamp }
        }
        return result
    }
}

extension CLActivityType {
    var captureName: String {
        switch self {
        case .other: "other"
        case .automotiveNavigation: "automotive_navigation"
        case .fitness: "fitness"
        case .otherNavigation: "other_navigation"
        case .airborne: "airborne"
        case .maritime: "maritime"
        @unknown default: "unknown_\(rawValue)"
        }
    }
}
