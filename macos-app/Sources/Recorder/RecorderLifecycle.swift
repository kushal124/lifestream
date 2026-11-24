import Evidence
import Foundation

@MainActor struct RecorderLifecycle {
    enum Rest: Equatable {
        case stopped, captured, gap, permissionRequired
    }

    enum Attempt: Equatable {
        case recording, waiting, recovering, permissionRequired
    }

    enum Outcome: Equatable {
        case stopped, captured, gap
    }

    enum Ending: Equatable {
        case stopped
        case ended(Outcome)
    }

    enum Step {
        case idle(Rest)
        case opening(Run, retrying: Bool)
        case stating(Run)
        case recording(Run, Attempt)
        case closing(Run, Ending)
    }

    enum Part: CaseIterable {
        case machine, input, audio
    }

    enum Event {
        case start(Run)
        case oneShot(Run)
        case refusedWithoutGrant
        case opened(Run)
        case stated(Run)
        case openingFailed(Run)
        case storageLost(Run)
        case attempt(Attempt)
        case screenAllowed
        case ended(Run, Outcome)
        case stop
        case released(Run)
    }

    enum Taken: Equatable {
        case moved, unchanged
        case refused(RecorderError)
    }

    static let openingMessage = "Opening capture storage."
    static let recoveringMessage = "Capture encountered a technical failure; recovery is pending."

    private(set) var step: Step = .idle(.stopped)
    private(set) var started: Set<Part> = []

    @discardableResult
    mutating func take(_ event: Event) -> Taken {
        switch event {
        case .start(let run):
            switch step {
            case .idle: return move(.opening(run, retrying: false))
            case .opening(let current, _), .stating(let current), .recording(let current, _):
                return current.oneShot ? .refused(.alreadyActive) : .unchanged
            case .closing: return .refused(.stillPausing)
            }
        case .oneShot(let run):
            guard case .idle = step else { return .refused(.alreadyActive) }
            return move(.opening(run, retrying: false))
        case .refusedWithoutGrant:
            guard case .idle = step else { return .refused(.alreadyActive) }
            return move(.idle(.permissionRequired))
        case .stop:
            switch step {
            case .idle: return move(.idle(.stopped))
            case .opening(let run, _), .stating(let run), .recording(let run, _), .closing(let run, .ended):
                return move(.closing(run, .stopped))
            case .closing: return .unchanged
            }
        case .opened(let run):
            guard owns(run) else { return .unchanged }
            switch step {
            case .opening: return move(.stating(run))
            case .closing: return .unchanged
            case .idle, .stating, .recording: return impossible(event)
            }
        case .stated(let run):
            guard owns(run) else { return .unchanged }
            switch step {
            case .stating: return move(.recording(run, .recording))
            case .closing: return .unchanged
            case .idle, .opening, .recording: return impossible(event)
            }
        case .openingFailed(let run):
            guard owns(run) else { return .unchanged }
            switch step {
            case .opening, .stating: return move(run.oneShot ? .closing(run, .ended(.stopped)) : .opening(run, retrying: true))
            case .closing: return .unchanged
            case .idle, .recording: return impossible(event)
            }
        case .storageLost(let run):
            guard owns(run) else { return .unchanged }
            switch step {
            case .recording: return move(run.oneShot ? .closing(run, .ended(.stopped)) : .recording(run, .recovering))
            case .idle, .opening, .stating, .closing: return .unchanged
            }
        case .attempt(let attempt):
            guard case .recording(let run, let shown) = step, shown != .permissionRequired else { return .unchanged }
            return move(.recording(run, attempt))
        case .screenAllowed:
            guard case .recording(let run, .permissionRequired) = step else { return .unchanged }
            return move(.recording(run, .recording))
        case .ended(let run, let outcome):
            guard owns(run) else { return .unchanged }
            switch step {
            case .opening, .stating, .recording: return move(.closing(run, .ended(outcome)))
            case .closing, .idle: return .unchanged
            }
        case .released(let run):
            guard owns(run) else { return .unchanged }
            guard case .closing(_, let ending) = step else { return impossible(event) }
            return move(.idle(Self.rest(of: ending)))
        }
    }

    mutating func settle(off: Set<Producer>, seal: Bool = false) -> (stop: [Part], start: [Part]) {
        let wanted: Set<Part>
        switch step {
        case .recording:
            wanted = Set(Part.allCases.filter { part in Self.producer(of: part).map { !off.contains($0) } ?? true })
        case .closing:
            wanted = seal ? [] : started
        case .idle, .opening, .stating:
            wanted = []
        }
        let stop = Part.allCases.reversed().filter { started.contains($0) && !wanted.contains($0) }
        let start = Part.allCases.filter { !started.contains($0) && wanted.contains($0) }
        started = wanted
        return (stop, start)
    }

    var run: Run? {
        switch step {
        case .idle: return nil
        case .opening(let run, _), .stating(let run), .recording(let run, _), .closing(let run, _): return run
        }
    }

    var running: Bool { run != nil }

    var stopping: Bool {
        if case .closing = step { return true }
        return false
    }

    var capturing: Bool {
        switch step {
        case .recording(_, .recording), .recording(_, .recovering), .opening(_, retrying: true): return true
        default: return false
        }
    }

    func records(_ run: Run) -> Bool {
        switch step {
        case .opening(let current, _), .stating(let current), .recording(let current, _): return current === run
        case .idle, .closing: return false
        }
    }

    func admits(_ run: Run) -> Bool {
        switch step {
        case .opening(let current, _), .stating(let current), .recording(let current, _), .closing(let current, .ended):
            return current === run
        case .idle, .closing:
            return false
        }
    }

    var state: RecorderState {
        switch step {
        case .idle(.stopped), .closing(_, .stopped), .closing(_, .ended(.stopped)): return .stopped
        case .idle(.captured), .closing(_, .ended(.captured)): return .captured
        case .idle(.gap), .closing(_, .ended(.gap)): return .gap
        case .idle(.permissionRequired), .recording(_, .permissionRequired): return .permissionRequired
        case .opening(_, retrying: false): return .starting
        case .stating, .recording(_, .recording): return .recording
        case .recording(_, .waiting): return .waiting
        case .opening(_, retrying: true), .recording(_, .recovering): return .recovering
        }
    }

    var message: String? {
        switch step {
        case .idle(.permissionRequired), .recording(_, .permissionRequired): return Recorder.screenRecordingMessage
        case .opening(_, retrying: false): return Self.openingMessage
        case .opening(_, retrying: true), .recording(_, .recovering): return Self.recoveringMessage
        default: return nil
        }
    }

    private func owns(_ run: Run) -> Bool {
        self.run === run
    }

    private mutating func move(_ next: Step) -> Taken {
        step = next
        return .moved
    }

    private func impossible(_ event: Event) -> Taken {
        assertionFailure("recorder lifecycle: \(event) in \(step)")
        return .unchanged
    }

    private static func rest(of ending: Ending) -> Rest {
        switch ending {
        case .stopped: return .stopped
        case .ended(.stopped): return .stopped
        case .ended(.captured): return .captured
        case .ended(.gap): return .gap
        }
    }

    private static func producer(of part: Part) -> Producer? {
        switch part {
        case .machine: return nil
        case .input: return .input
        case .audio: return .audio
        }
    }
}

@MainActor final class Run {
    struct Closure {
        let reason: CaptureGapReason
        let openedAt: Date
        let interval: Double
        var stated = false
        var lost = false
        var generation: UInt64?

        var from: Date { stated ? openedAt.addingTimeInterval(interval) : openedAt }
    }

    static let shortestWait: Double = 15
    static let longestWait: Double = 300

    let oneShot: Bool
    var task: Task<Void, Error>?
    var stopAt: Double?
    private(set) var store: (any RecorderStorage)?
    var compaction: Task<Void, Never>?
    var napping: Task<Void, Error>?
    var closure: Closure?
    private(set) var publications: Publications
    var opened = false
    var lost: StorageFailure?
    var lastAppended: Date?
    var wait = Run.shortestWait
    var activity: (() -> Void)?
    private let failed: @MainActor (Run, Error) -> Void

    let began: Date
    var stoppedAt: Date?

    init(oneShot: Bool, stopAt: Double?, began: Date = Date(), failed: @escaping @MainActor (Run, Error) -> Void) {
        self.oneShot = oneShot
        self.stopAt = stopAt
        self.began = began
        self.failed = failed
        publications = Publications()
        listen()
    }

    func begin(_ store: any RecorderStorage) {
        self.store = store
        lost = nil
        publications = Publications()
        listen()
    }

    func drop() {
        store = nil
    }

    func appended(_ observation: CaptureObservation) {
        reached(max(observation.capturedAt, observation.capturedUntil ?? observation.capturedAt))
    }

    func reached(_ end: Date) {
        lastAppended = max(lastAppended ?? end, end)
    }

    private func listen() {
        let chain = publications
        chain.failed = { [unowned self, unowned chain] error in
            if chain === publications { failed(self, error) }
        }
    }
}

@MainActor final class Publications {
    private var last: Task<Void, Never>?
    private var failure: Error?
    fileprivate var failed: ((Error) -> Void)?
    private(set) var waiting = 0
    private var room: [CheckedContinuation<Void, Never>] = []
    var held: Int { room.count }

    @discardableResult
    func ordered(_ body: @escaping @MainActor () async throws -> Void) -> Task<Void, Error> {
        chain({ () }, { _ in try await body() })
    }

    func whenRecognized<Value>(_ text: @escaping @MainActor () async -> Value,
                               _ body: @escaping @MainActor (Value) async throws -> Void) {
        waiting += 1
        chain({
            let value = await text()
            self.waiting -= 1
            self.wake()
            return value
        }, body)
    }

    func room(below limit: Int, while going: () -> Bool) async {
        while waiting >= limit, failure == nil, going() {
            await withCheckedContinuation { room.append($0) }
        }
    }

    func settle() async throws {
        await last?.value
        if let failure { throw failure }
    }

    func drain() async {
        await last?.value
    }

    @discardableResult
    private func chain<Value>(_ before: @escaping @MainActor () async -> Value,
                              _ body: @escaping @MainActor (Value) async throws -> Void) -> Task<Void, Error> {
        let previous = last
        let link = Task { @MainActor [self] in
            await previous?.value
            let value = await before()
            if let failure { throw failure }
            do {
                try await body(value)
            } catch {
                if failure == nil {
                    failure = error
                    wake()
                    failed?(error)
                }
                throw error
            }
        }
        last = Task { _ = try? await link.value }
        return link
    }

    private func wake() {
        let held = room
        room = []
        held.forEach { $0.resume() }
    }
}
