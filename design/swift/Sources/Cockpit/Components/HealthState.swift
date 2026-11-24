import SwiftUI

public extension Cockpit {
    enum HealthState: String, CaseIterable, Sendable {
        case off
        case setup
        case paused
        case needsYou = "needs-you"
        case broken
        case waiting
        case quiet
        case syncing
        case ok

        public var signal: SignalKind? {
            switch self {
            case .off, .paused, .waiting, .quiet: .idle
            case .setup, .syncing, .ok: nil
            case .needsYou: .caution
            case .broken: .warning
            }
        }

        public var word: String? {
            switch self {
            case .off: "Off"
            case .setup: nil
            case .paused: "Paused"
            case .needsYou: "Needs you"
            case .broken: "Stopped"
            case .waiting: "Waiting"
            case .quiet: nil
            case .syncing: nil
            case .ok: nil
            }
        }
    }
}
