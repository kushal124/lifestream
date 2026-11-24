import Foundation

struct CaptureCadence {
    struct Advance: Equatable, Sendable {
        let nextDeadline: Double
        let missedCount: Int
        let firstMissedDeadline: Double?
        let lastMissedDeadline: Double?
    }

    let interval: Double
    private var deadline: Double

    init(interval: Double, start: Double) {
        precondition(interval.isFinite && interval > 0 && start.isFinite)
        self.interval = interval
        self.deadline = start
    }

    mutating func advance(after now: Double, maximumLateness: Double = 0) -> Advance {
        precondition(now.isFinite && maximumLateness.isFinite && maximumLateness >= 0)
        precondition(maximumLateness < interval)
        let first = deadline + interval
        precondition(first.isFinite && first > deadline)
        var missed = 0
        deadline = first
        let cutoff = now - maximumLateness
        let expired = maximumLateness == 0 ? deadline <= now : deadline < cutoff
        if expired {
            let count = maximumLateness == 0
                ? floor((now - deadline) / interval) + 1
                : ceil((cutoff - deadline) / interval)
            precondition(count.isFinite && count < Double(Int.max))
            missed = Int(count)
            deadline += count * interval
        }
        precondition(deadline.isFinite && (maximumLateness == 0 ? deadline > now : deadline >= cutoff))
        return Advance(nextDeadline: deadline, missedCount: missed,
                       firstMissedDeadline: missed > 0 ? first : nil,
                       lastMissedDeadline: missed > 0 ? first + Double(missed - 1) * interval : nil)
    }
}
