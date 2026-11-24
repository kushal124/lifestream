public enum CheckInForm: String, CaseIterable, Codable, Sendable {
    case moment, day, week, prework
    case blockBefore = "block_before", blockAfter = "block_after", blockRework = "block_rework"

    public var items: [CheckInItem] {
        switch self {
        case .moment: [
            .rating("pleasant", "How pleasant or unpleasant do you feel right now?", "Pleasant or unpleasant?", pleasant),
            .rating("energy", "How much energy do you have right now?", "How much energy?", ["None", "Low", "Moderate", "High", "Very high"]),
            .rating("tense", "How tense do you feel right now?", "How tense?", intensity)]
        case .day: [
            .rating("overall", "Overall, how did today feel?", "Overall, how did it feel?", pleasant),
            .rating("worthwhile", "How worthwhile did today feel?", "How worthwhile?", intensity),
            .rating("connected", "How connected to other people did you feel today?", "How connected to people?", intensity)]
        case .week: [.init(id: "satisfaction", question: "All things considered, how satisfied are you with your life as a whole these days?",
                          title: "How satisfied with life as a whole?", labels: (0...10).map { String($0) },
                          anchors: ["Not at all", "Completely"], firstValue: 0)]
        case .prework: [
            .rating("clarity", "How clear-headed do you feel right now?", "How clear-headed?", ["Very foggy", "Foggy", "Neither foggy nor clear", "Clear", "Very clear"]),
            .rating("kss", "How sleepy are you right now?", "How sleepy?", ["Extremely alert", "Very alert", "Alert", "Rather alert", "Neither alert nor sleepy", "Some signs of sleepiness", "Sleepy, but no effort to keep awake", "Sleepy, some effort to keep awake", "Very sleepy, great effort to keep awake, fighting sleep"])]
        case .blockBefore: [
            .text("what", "What"), .text("done_looks_like", "Done looks like"),
            .rating("difficulty", "How hard do you expect this to be?", "How hard do you expect it to be?", ["Routine", "Slightly hard", "Moderate", "Hard", "Very hard"]),
            .init(id: "kind", question: "Kind of work", title: "Kind of work", labels: ["Build", "Think", "Talk"], anchors: ["build", "talk"], format: .category)]
        case .blockAfter: [
            .rating("progress", "How far did you get against that?", "How far did you get?", ["Nowhere", "A little", "Halfway", "Most of it", "All of it"]),
            .rating("effort", "How much effort did it take?", "How much effort?", ["Easy", "A little", "Moderate", "A lot", "Everything I had"]),
            .yesNo("interrupted", "A major interruption?")]
        case .blockRework: [.yesNo("rework", "Did any of yesterday's block need redoing?")]
        }
    }
    private var pleasant: [String] { ["Very unpleasant", "Unpleasant", "Slightly unpleasant", "Neutral", "Slightly pleasant", "Pleasant", "Very pleasant"] }
    private var intensity: [String] { ["Not at all", "A little", "Moderately", "Very", "Extremely"] }
}

public struct CheckInItem: Sendable, Equatable, Identifiable {
    public enum Format: Sendable { case rating, text, category, yesNo }
    public let id: String
    public let question: String
    public let title: String
    public let labels: [String]
    public let anchors: [String]
    public var firstValue = 1
    public var format: Format = .rating
    public var scale: Int { labels.count }
    public var values: Range<Int> { firstValue..<(firstValue + scale) }

    static func rating(_ id: String, _ question: String, _ title: String, _ labels: [String]) -> Self {
        .init(id: id, question: question, title: title, labels: labels, anchors: [labels[0], labels[labels.count - 1]])
    }
    static func text(_ id: String, _ question: String) -> Self {
        .init(id: id, question: question, title: question, labels: [], anchors: [], format: .text)
    }
    static func yesNo(_ id: String, _ question: String) -> Self {
        .init(id: id, question: question, title: question, labels: ["No", "Yes"], anchors: ["No", "Yes"], format: .yesNo)
    }
    public func accepts(_ value: JSONValue?) -> Bool {
        switch (format, value) {
        case (.rating, .integer(let n)): values.contains(Int(n))
        case (.text, .string(let s)): !s.isEmpty && s.contains { !$0.isWhitespace }
        case (.category, .string(let s)): ["build", "think", "talk"].contains(s)
        case (.yesNo, .bool): true
        default: false
        }
    }
    public func answer(_ value: JSONValue) -> JSONValue {
        .object(["id": .string(id), "question": .string(question), "scale": .integer(Int64(scale)),
                 "anchors": .array(anchors.map(JSONValue.string)), "value": value])
    }
}

public struct CheckInReport: Sendable {
    public let form: CheckInForm
    public let openedAt: String
    public let answeredAt: String
    public let localZone: String
    public let responseMS: Double
    public let changes: Int
    public let answers: [String: JSONValue]
    public let note: String?
    public let blockID: String?
    public let promptID: String?
    public let trigger: String
    public let awakeForSeconds: Double?
    public let wakeSource: String?
    public let endedBy: String?

    public init(form: CheckInForm, openedAt: String, answeredAt: String, localZone: String,
                responseMS: Double, changes: Int, answers: [String: JSONValue], note: String? = nil,
                blockID: String? = nil, promptID: String? = nil, trigger: String = "manual",
                awakeForSeconds: Double? = nil, wakeSource: String? = nil, endedBy: String? = nil) {
        self.form = form; self.openedAt = openedAt; self.answeredAt = answeredAt; self.localZone = localZone
        self.responseMS = responseMS; self.changes = changes; self.answers = answers; self.note = note
        self.blockID = blockID; self.promptID = promptID; self.trigger = trigger
        self.awakeForSeconds = awakeForSeconds; self.wakeSource = wakeSource; self.endedBy = endedBy
    }
    public var firstMissing: String? { form.items.first { !$0.accepts(answers[$0.id]) }?.id }
    public var payload: JSONValue {
        var value: [String: JSONValue] = [
            "form": .string(form.rawValue), "form_version": .integer(1),
            "opened_at": .string(openedAt), "answered_at": .string(answeredAt), "local_zone": .string(localZone),
            "response_ms": .number(responseMS), "changes": .integer(Int64(changes)),
            "prompt_id": promptID.map(JSONValue.string) ?? .null, "trigger": .string(trigger),
            "awake_for_s": awakeForSeconds.map(JSONValue.number) ?? .null,
            "wake_source": wakeSource.map(JSONValue.string) ?? .null,
            "block_id": blockID.map(JSONValue.string) ?? .null,
            "items": .array(form.items.compactMap { item in answers[item.id].map(item.answer) }),
            "note": note.map(JSONValue.string) ?? .null]
        if let endedBy { value["ended_by"] = .string(endedBy) }
        return .object(value)
    }
}
