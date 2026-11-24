import Foundation

public struct KeptPause {
    public static let key = "LifestreamRecordingPaused"
    private let defaults: UserDefaults

    public init(_ defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var paused: Bool { defaults.bool(forKey: Self.key) }

    func keep(_ paused: Bool) {
        if paused {
            defaults.set(true, forKey: Self.key)
        } else {
            defaults.removeObject(forKey: Self.key)
        }
    }
}
