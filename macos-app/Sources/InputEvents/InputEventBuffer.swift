import Foundation
import os

final class InputEventBuffer: @unchecked Sendable {
    private struct State {
        var items: [InputBufferItem] = []
        var spare: [InputBufferItem] = []
        var tapEvents = 0
        var lost = 0
        var woken = false
        var deferred = false
    }

    static let deferral = 0.05

    let capacity: Int
    private let state: OSAllocatedUnfairLock<State>
    private let wake: () -> Void
    private let wakeLater: () -> Void

    init(capacity: Int = 50_000, wake: @escaping () -> Void, wakeLater: @escaping () -> Void) {
        self.capacity = capacity
        self.wake = wake
        self.wakeLater = wakeLater
        var initial = State()
        initial.items.reserveCapacity(1024)
        initial.spare.reserveCapacity(1024)
        state = OSAllocatedUnfairLock(uncheckedState: initial)
    }

    func append(_ item: InputBufferItem) {
        enum Wake { case none, now, later }
        let wake = state.withLockUnchecked { state -> Wake in
            if case .tap = item {
                guard state.tapEvents < capacity else {
                    state.lost += 1
                    return .none
                }
                state.tapEvents += 1
            }
            state.items.append(item)
            guard !state.woken else { return .none }
            if item.isUrgent {
                state.woken = true
                return .now
            }
            guard !state.deferred else { return .none }
            state.deferred = true
            return .later
        }
        switch wake {
        case .none: break
        case .now: self.wake()
        case .later: wakeLater()
        }
    }

    func take() -> (items: [InputBufferItem], lost: Int) {
        state.withLockUnchecked { state in
            let items = state.items
            state.items = state.spare
            state.spare = []
            let lost = state.lost
            state.lost = 0
            state.tapEvents = 0
            state.woken = false
            state.deferred = false
            return (items, lost)
        }
    }

    func recycle(_ items: inout [InputBufferItem]) {
        items.removeAll(keepingCapacity: true)
        state.withLockUnchecked { state in
            if state.spare.capacity < items.capacity { swap(&state.spare, &items) }
        }
    }
}

extension InputBufferItem {
    var isUrgent: Bool {
        guard case .tap(let raw) = self else { return true }
        switch raw.type {
        case .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown: return true
        default: return false
        }
    }
}
