import Combine
import Foundation
import LifestreamCaptureCore

struct VigilanceTrial: Sendable {
    let n: Int
    let intervalMS: Double
    var stimulusMS: Double?
    var responseMS: Double?
    var classification: VigilanceRules.Classification?
    var rtMS: Double? { stimulusMS.flatMap { stimulus in responseMS.map { $0 - stimulus } } }
    var payload: JSONValue {
        .object(["n": .integer(Int64(n)), "isi_ms": .number(intervalMS),
            "stimulus_ms": stimulusMS.map { .number(Self.tenth($0)) } ?? .null,
            "response_ms": responseMS.map { .number(Self.tenth($0)) } ?? .null,
            "rt_ms": rtMS.map { .number(Self.tenth($0)) } ?? .null,
            "class": classification.map { .string($0.rawValue) } ?? .null])
    }
    static func tenth(_ value: Double) -> Double { (value * 10).rounded() / 10 }
}

struct VigilanceRecord: Sendable {
    let startedAt: String
    let endedAt: String
    let completed: Bool
    let promptID: String?
    let trigger: String
    let awakeForSeconds: Double?
    let wakeSource: String?
    let device: JSONValue
    let trials: [VigilanceTrial]
    let interruptions: [JSONValue]
    func payload(sessionNumber: Int) -> JSONValue {
        .object(["protocol": .string(VigilanceRules.protocolName), "duration_ms": .number(VigilanceRules.durationMS),
            "isi_ms": .array([.number(VigilanceRules.minimumIntervalMS), .number(VigilanceRules.maximumIntervalMS)]),
            "lapse_threshold_ms": .number(VigilanceRules.lapseThresholdMS),
            "false_start_under_ms": .number(VigilanceRules.falseStartUnderMS), "timeout_ms": .number(VigilanceRules.timeoutMS),
            "prompt_id": promptID.map(JSONValue.string) ?? .null, "trigger": .string(trigger),
            "started_at": .string(startedAt), "ended_at": .string(endedAt), "completed": .bool(completed),
            "session_number": .integer(Int64(sessionNumber)),
            "awake_for_s": awakeForSeconds.map(JSONValue.number) ?? .null,
            "wake_source": wakeSource.map(JSONValue.string) ?? .null, "device": device,
            "trials": .array(trials.map(\.payload)), "interruptions": .array(interruptions)])
    }
}

@MainActor
final class VigilanceSession: ObservableObject {
    struct Frame {
        var counter = ""
        var hint = "Wait for the counter"
        var feedback = false
        var progress = 0.0
    }
    @Published private(set) var record: VigilanceRecord?
    private var startDate: Date?
    private var startClock = 0.0
    private var trials: [VigilanceTrial] = []
    private var interruptions: [JSONValue] = []
    private var random = CheckInRandom(seed: UInt64.random(in: .min ... .max))
    private var scheduledMS: Double?
    private var feedbackUntil = 0.0
    private var lastFrame: Double?
    private var device: JSONValue = .null
    let promptID: String?
    let trigger: String
    let wake: Date?
    let wakeSource: String?

    init(promptID: String?, trigger: String, wake: Date?, wakeSource: String?) {
        self.promptID = promptID; self.trigger = trigger; self.wake = wake; self.wakeSource = wakeSource
    }
    func start(clock: Double, date: Date, device: JSONValue) {
        guard startDate == nil else { return }
        startClock = clock; startDate = date; self.device = device
        nextTrial(at: 0)
    }
    private func nextTrial(at elapsed: Double) {
        let interval = VigilanceRules.interval(unitDraw: random.unit())
        guard VigilanceRules.canStart(elapsedMS: elapsed, intervalMS: interval) else { scheduledMS = nil; return }
        trials.append(.init(n: trials.count + 1, intervalMS: interval))
        scheduledMS = elapsed + interval
    }
    func frame(targetTimestamp: Double, frameDuration: Double) -> Frame {
        guard startDate != nil, record == nil else { return Frame() }
        let elapsed = (targetTimestamp - startClock) * 1000
        if let last = lastFrame, targetTimestamp - last > frameDuration * 1.5,
           let trial = trials.last, trial.stimulusMS != nil, trial.classification == nil {
            interrupt("frame_drop", clock: targetTimestamp)
        }
        lastFrame = targetTimestamp
        if elapsed >= VigilanceRules.durationMS { finish(completed: true, clock: targetTimestamp); return Frame(progress: 1) }
        if feedbackUntil > 0 && elapsed >= feedbackUntil {
            feedbackUntil = 0
            nextTrial(at: elapsed)
        }
        var frame = Frame(progress: min(1, max(0, elapsed / VigilanceRules.durationMS)))
        if feedbackUntil > elapsed, let trial = trials.last {
            frame.counter = trial.rtMS.map { String(Int(max(0, $0))) } ?? "0"
            frame.feedback = true
            frame.hint = trial.classification == .falseStart ? "False start" : ""
        } else if let scheduled = scheduledMS, !trials.isEmpty {
            let index = trials.count - 1
            if trials[index].stimulusMS == nil && elapsed >= scheduled {
                trials[index].stimulusMS = elapsed
            }
            if let stimulus = trials[index].stimulusMS {
                if elapsed - stimulus >= VigilanceRules.timeoutMS {
                    trials[index].classification = .timeout
                    scheduledMS = nil
                    feedbackUntil = elapsed + VigilanceRules.feedbackMS
                } else {
                    frame.counter = String(Int(max(0, elapsed - stimulus)))
                    frame.hint = "Tap"
                }
            }
        }
        return frame
    }
    func touch(timestamp: Double) {
        guard startDate != nil, record == nil, scheduledMS != nil, !trials.isEmpty else { return }
        let elapsed = (timestamp - startClock) * 1000
        let index = trials.count - 1
        guard trials[index].classification == nil, elapsed >= 0 else { return }
        if elapsed >= VigilanceRules.durationMS { finish(completed: true, clock: timestamp); return }
        trials[index].responseMS = elapsed
        trials[index].classification = VigilanceRules.classify(stimulusMS: trials[index].stimulusMS, responseMS: elapsed)
        scheduledMS = nil
        feedbackUntil = elapsed + VigilanceRules.feedbackMS
    }
    func interrupt(_ reason: String, clock: Double) {
        guard startDate != nil, record == nil else { return }
        interruptions.append(.object(["at_ms": .number(VigilanceTrial.tenth(max(0, (clock - startClock) * 1000))), "reason": .string(reason)]))
    }
    func finish(completed: Bool, clock: Double) {
        guard let startDate, record == nil else { return }
        record = VigilanceRecord(startedAt: CaptureTime.rfc3339(startDate),
            endedAt: CaptureTime.rfc3339(startDate.addingTimeInterval(max(0, clock - startClock))), completed: completed,
            promptID: promptID, trigger: trigger, awakeForSeconds: wake.map { startDate.timeIntervalSince($0) },
            wakeSource: wakeSource, device: device, trials: trials, interruptions: interruptions)
    }
}
