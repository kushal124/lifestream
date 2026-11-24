import Foundation
import HomeLink
import os

final class LaunchReady: Sendable {
    enum Outcome: Sendable, Equatable {
        case ready, gaveUp, stopped
    }

    private struct State {
        var outcome: Outcome?
        var waiting: [UUID: CheckedContinuation<Outcome, Never>] = [:]
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    init(heal: Task<Void, Never>, bound: TimeInterval = HomeLink.readyBound, pacer: Pacer = .system) {
        Task { [weak self] in
            await heal.value
            self?.settle(.ready)
        }
        pacer.after(bound) { [weak self] in self?.settle(.gaveUp) }
    }

    func hold(_ link: HomeLink) {
        link.tellsWait(for: { [weak self] in _ = await self?.wait() })
    }

    func wait() async -> Outcome {
        let id = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (next: CheckedContinuation<Outcome, Never>) in
                let now: Outcome? = state.withLock {
                    if let outcome = $0.outcome { return outcome }
                    if Task.isCancelled { return .stopped }
                    $0.waiting[id] = next
                    return nil
                }
                if let now { next.resume(returning: now) }
            }
        } onCancel: {
            state.withLock { $0.waiting.removeValue(forKey: id) }?.resume(returning: .stopped)
        }
    }

    var waiters: Int { state.withLock { $0.waiting.count } }

    func stop() {
        settle(.stopped)
    }

    private func settle(_ outcome: Outcome) {
        let waiting = state.withLock { held -> [CheckedContinuation<Outcome, Never>] in
            guard held.outcome == nil else { return [] }
            held.outcome = outcome
            defer { held.waiting = [:] }
            return Array(held.waiting.values)
        }
        for next in waiting { next.resume(returning: outcome) }
    }
}
