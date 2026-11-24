import LifestreamCaptureCore
@preconcurrency import MetricKit
import os
import UIKit

struct MetricKitSignposts: EnergySignposts {
    private let log = MXMetricManager.makeLogHandle(category: "Parts")

    func begin(_ part: EnergyPart) -> OSSignpostID {
        let id = OSSignpostID(log: log)
        mxSignpost(.begin, log: log, name: Self.name(part), signpostID: id)
        return id
    }

    func end(_ part: EnergyPart, _ id: OSSignpostID) {
        mxSignpost(.end, log: log, name: Self.name(part), signpostID: id)
    }

    private static func name(_ part: EnergyPart) -> StaticString {
        switch part {
        case .location: "location"
        case .motion: "motion"
        case .health: "health"
        case .photos: "photos"
        case .contacts: "contacts"
        case .usage: "usage"
        case .shipping: "shipping"
        case .checkin: "checkin"
        case .places: "places"
        case .energy: "energy"
        }
    }
}

enum BackgroundWake {
    nonisolated static func note(_ trigger: String) {
        Task { @MainActor in
            if UIApplication.shared.applicationState != .active { EnergyLedger.shared.wake(trigger) }
        }
    }
}
