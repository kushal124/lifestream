import Foundation

public final class MachineDiary: @unchecked Sendable {
    public static let kind = "machine-event"

    private let store: CaptureStore
    private let now: @Sendable () -> Date
    private let beforeCapture: @Sendable () async throws -> Void
    private var held: [String: String]?
    private var read = false
    private let lock = NSLock()
    private var tail: Task<Void, Never>?

    public init(store: CaptureStore, now: @escaping @Sendable () -> Date = { AppClock.now },
                beforeCapture: @escaping @Sendable () async throws -> Void = {}) {
        self.store = store
        self.now = now
        self.beforeCapture = beforeCapture
    }

    @discardableResult
    public func record(_ grants: [String: String]) -> Task<Void, Never> {
        lock.withLock {
            let previous = tail
            let task = Task {
                await previous?.value
                await write(grants.filter { $0.value != "asking" })
            }
            tail = task
            return task
        }
    }

    private func write(_ grants: [String: String]) async {
        do {
            try await beforeCapture()
            if !read {
                held = try await store.foldEntries(domain: .machine, initial: nil) { Self.include(&$0, $1) }
                read = true
            }
            let observedAt = CaptureTime.rfc3339(now())
            let drafts: [CaptureDraft]
            if let held {
                drafts = grants.keys.sorted().filter { held[$0] != grants[$0] }.map { grant in
                    Self.draft("access", ["grant": grant, "state": grants[grant]!], at: observedAt)
                }
            } else {
                drafts = [Self.draft("state", Dictionary(uniqueKeysWithValues: grants.map { ("access_\($0.key)", $0.value) }),
                                     at: observedAt)]
            }
            guard !drafts.isEmpty else { return }
            try await store.appendBatch(domain: .machine, drafts: drafts)
            held = (held ?? [:]).merging(grants) { _, new in new }
        } catch {
        }
    }

    private static func draft(_ event: String, _ detail: [String: String], at observedAt: String) -> CaptureDraft {
        CaptureDraft(kind: kind, observedAt: observedAt,
                     payload: .object(["event": .string(event), "detail": .object(detail.mapValues(JSONValue.string))]))
    }

    private static func include(_ held: inout [String: String]?, _ entry: CaptureEntry) {
        guard entry.kind == kind, case .object(let payload) = entry.payload, case .object(let detail)? = payload["detail"] else { return }
        switch payload["event"] {
        case .string("state")?:
            var state = held ?? [:]
            for (member, value) in detail where member.hasPrefix("access_") {
                if case .string(let word) = value { state[String(member.dropFirst("access_".count))] = word }
            }
            held = state
        case .string("access")?:
            if case .string(let grant)? = detail["grant"], case .string(let word)? = detail["state"] { held?[grant] = word }
        default:
            break
        }
    }
}
