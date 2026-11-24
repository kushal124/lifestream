import Foundation

struct CaptureGate {
    struct Ticket: Equatable {
        fileprivate let generation: UInt64
    }

    struct Interval: Equatable {
        let generation: UInt64
        let closedAt: Date
        fileprivate(set) var openedAt: Date?
        fileprivate(set) var consumed = false
    }

    private var displayAwake: Bool?
    private var sessionActive: Bool?
    private(set) var generation: UInt64 = 0
    private(set) var intervals: [Interval] = []
    private(set) var lastOpenedAt: Date?

    init(displayAwake: Bool?, sessionActive: Bool?) {
        self.displayAwake = displayAwake
        self.sessionActive = sessionActive
    }

    var isOpen: Bool { displayAwake == true && sessionActive == true }

    mutating func set(displayAwake: Bool?, sessionActive: Bool?, at now: Date) {
        let wasOpen = isOpen
        self.displayAwake = displayAwake
        self.sessionActive = sessionActive
        if wasOpen, !isOpen {
            generation += 1
            intervals.append(Interval(generation: generation, closedAt: now))
        } else if !wasOpen, isOpen {
            lastOpenedAt = now
            if let last = intervals.indices.last, intervals[last].openedAt == nil { intervals[last].openedAt = now }
        }
    }

    var completed: [Interval] { intervals.filter { $0.openedAt != nil && !$0.consumed } }

    var lasting: Interval? {
        guard !isOpen, let last = intervals.last, last.openedAt == nil, !last.consumed else { return nil }
        return last
    }

    func interval(of generation: UInt64) -> Interval? {
        intervals.first { $0.generation == generation }
    }

    mutating func consume(through generation: UInt64) {
        intervals.removeAll { $0.generation <= generation && $0.openedAt != nil }
        for index in intervals.indices where intervals[index].generation <= generation { intervals[index].consumed = true }
    }

    func ticket() -> Ticket? {
        isOpen ? Ticket(generation: generation) : nil
    }

    func canCommit(_ ticket: Ticket) -> Bool {
        isOpen && ticket.generation == generation
    }
}
