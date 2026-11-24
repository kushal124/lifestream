public enum CheckInScheduleRules {
    public static let expirySeconds = 15.0 * 60
    public static let reminderSeconds = 5.0 * 60
    public static let calibrationDays = 28
    public static let workBlockLimitSeconds = 3.0 * 60 * 60

    public struct Prompt: Codable, Equatable, Sendable {
        public let form: String
        public let trigger: String
        public let time: Double
        public var expires: Double { time + expirySeconds }
        public var reminder: Double { time + reminderSeconds }
    }
    public struct Plan: Codable, Equatable, Sendable {
        public let wake: Double
        public let wakeSource: String
        public let seed: UInt64
        public let draws: [Double]
        public let prompts: [Prompt]
    }

    public static func build(now: Double, defaultWake: Double, healthWake: Double?, bedtime: Double,
                             afternoon: Double, weekday: Int, calibrationDay: Int?, seed: UInt64) -> Plan {
        let health = healthWake.flatMap { $0 <= now && now - $0 <= 18 * 3600 ? $0 : nil }
        let wake = health ?? defaultWake
        var random = CheckInRandom(seed: seed)
        let draws = [random.unit(), random.unit()]
        let start = wake + 2 * 3600, end = bedtime - 2 * 3600
        var prompts: [Prompt] = []
        if end > start {
            let half = (end - start) / 2
            for index in 0..<2 {
                prompts.append(Prompt(form: "moment", trigger: "random",
                    time: start + Double(index) * half + draws[index] * half))
            }
        }
        prompts.append(Prompt(form: "day", trigger: "bedtime", time: bedtime))
        if weekday == 1 { prompts.append(Prompt(form: "week", trigger: "weekly", time: bedtime)) }
        if let day = calibrationDay, (0..<calibrationDays).contains(day), [2, 4, 6].contains(weekday) {
            prompts.append(Prompt(form: "vigilance", trigger: "calibration", time: afternoon))
        }
        return Plan(wake: wake, wakeSource: health == nil ? "default" : "healthkit", seed: seed,
                    draws: draws, prompts: prompts.sorted { $0.time < $1.time })
    }
}
