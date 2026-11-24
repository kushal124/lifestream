public enum VigilanceRules {
    public static let protocolName = "pvt-b-3min-v1"
    public static let durationMS = 180_000.0
    public static let minimumIntervalMS = 2_000.0
    public static let maximumIntervalMS = 10_000.0
    public static let lapseThresholdMS = 500.0
    public static let falseStartUnderMS = 100.0
    public static let timeoutMS = 30_000.0
    public static let feedbackMS = 600.0

    public enum Classification: String, Codable, Sendable { case response, falseStart = "false_start", timeout }

    public static func classify(stimulusMS: Double?, responseMS: Double?) -> Classification {
        guard let responseMS else { return .timeout }
        guard let stimulusMS else { return .falseStart }
        let rt = responseMS - stimulusMS
        if rt < falseStartUnderMS { return .falseStart }
        return rt >= timeoutMS ? .timeout : .response
    }

    public static func interval(unitDraw: Double) -> Double {
        minimumIntervalMS + min(1, max(0, unitDraw)) * (maximumIntervalMS - minimumIntervalMS)
    }

    public static func canStart(elapsedMS: Double, intervalMS: Double) -> Bool {
        elapsedMS >= 0 && intervalMS >= minimumIntervalMS && intervalMS <= maximumIntervalMS
            && elapsedMS + intervalMS + timeoutMS + feedbackMS <= durationMS
    }
}

public struct CheckInRandom: Sendable {
    private var state: UInt64
    public init(seed: UInt64) { state = seed }
    public mutating func unit() -> Double {
        state &+= 0x9e3779b97f4a7c15
        var z = state
        z = (z ^ (z >> 30)) &* 0xbf58476d1ce4e5b9
        z = (z ^ (z >> 27)) &* 0x94d049bb133111eb
        z ^= z >> 31
        return Double(z >> 11) / 9_007_199_254_740_992
    }
}
