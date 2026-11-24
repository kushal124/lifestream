import DeviceFiles
import Foundation

public final class SettingsQueue: @unchecked Sendable {
    public typealias Settings = [String: [String: HomeLink.JSON]]
    public typealias Merge = @Sendable (Change, HomeLink.JSON) -> HomeLink.JSON?

    public struct Change: Codable, Sendable, Equatable {
        public let connector: String
        public let member: String
        public let value: HomeLink.JSON
        public let was: HomeLink.JSON?

        public init(connector: String, member: String, value: HomeLink.JSON, was: HomeLink.JSON?) {
            self.connector = connector
            self.member = member
            self.value = value
            self.was = was
        }

        func of(_ connector: String, _ member: String) -> Bool { self.connector == connector && self.member == member }
        func of(_ other: Change) -> Bool { of(other.connector, other.member) }
        func at(_ value: HomeLink.JSON, over was: HomeLink.JSON?) -> Change {
            Change(connector: connector, member: member, value: value, was: was)
        }
    }

    public struct Sent: Sendable, Equatable {
        public let change: Change
        public let outcome: SettingOutcome
    }

    private static let most = 4 << 20

    private let file: URL
    private let files: DeviceFiles
    private let lock = NSLock()
    private var held: [Change]
    private var flying: Change?
    private let turns = Turns()

    public init(file: URL, files: DeviceFiles? = nil) {
        self.file = file
        let files = files ?? DeviceFiles(.plain)
        self.files = files
        held = (try? files.read(file, maximumBytes: Self.most)).flatMap { try? JSONDecoder().decode([Change].self, from: $0) } ?? []
    }

    public var changes: [Change] { lock.withLock { held } }

    public func enqueue(connector: String, member: String, value: HomeLink.JSON, was: HomeLink.JSON?) throws {
        try lock.withLock {
            var next = held
            if let index = next.firstIndex(where: { $0.of(connector, member) }) {
                let first = next[index].was
                if first != nil, value == first, flying?.of(connector, member) != true {
                    next.remove(at: index)
                } else {
                    next[index] = next[index].at(value, over: first)
                }
            } else {
                next.append(Change(connector: connector, member: member, value: value, was: was))
            }
            try write(next)
            held = next
        }
    }

    public func queued(connector: String, member: String) -> HomeLink.JSON? {
        lock.withLock { held.first { $0.of(connector, member) }?.value }
    }

    public func overlay(_ settings: Settings) -> Settings {
        var running = settings
        for change in changes { running[change.connector, default: [:]][change.member] = change.value }
        return running
    }

    public func exchange(through link: HomeLink, offers: [String] = [], drain: Bool = true, merge: Merge? = nil,
                         heard: @Sendable (Sent) async -> Void = { _ in },
                         stated: @Sendable () async -> Settings,
                         apply: (@Sendable (Settings) async -> Void)?) async throws -> FreshAnswer {
        try await turns.run {
            if drain { await self.drain(through: link, merge: merge, heard: heard) }
            let statement = await stated()
            var answer = try await link.exchange(offers: offers, settings: statement)
            guard let apply else { return answer }
            await apply(answer.settings)
            let now = await stated()
            guard now != statement else { return answer }
            answer = try await link.exchange(offers: offers, settings: now)
            await apply(answer.settings)
            return answer
        }
    }

    func drain(through link: HomeLink, merge: Merge?, heard: @Sendable (Sent) async -> Void) async {
        defer { lock.withLock { flying = nil } }
        for member in changes {
            guard var sending = take(member) else { continue }
            var merged = false
            while true {
                let outcome = (try? await link.setSetting(connector: sending.connector, member: sending.member,
                                                         value: sending.value, was: sending.was)) ?? .unreachable
                let each = Sent(change: sending, outcome: outcome)
                switch outcome {
                case .unreachable, .saving, .unknown:
                    await heard(each)
                    return
                case .taken, .changed, .refused: break
                }
                let again = settle(sending, outcome, merge: merge)
                await heard(each)
                guard let again, !merged else { break }
                merged = true
                sending = take(again) ?? again
            }
            lock.withLock { flying = nil }
        }
    }

    private func take(_ member: Change) -> Change? {
        lock.withLock {
            flying = held.first { $0.of(member) }
            return flying
        }
    }

    private func settle(_ change: Change, _ outcome: SettingOutcome, merge: Merge?) -> Change? {
        lock.withLock {
            guard let index = held.firstIndex(where: { $0.of(change) }) else { return nil }
            defer { try? write(held) }
            let newest = held[index]
            let holds: HomeLink.JSON?
            var merged: HomeLink.JSON?
            switch outcome {
            case .taken: holds = change.value
            case .refused: holds = change.was
            case .changed(let home):
                holds = home
                merged = merge?(newest, home)
            case .unreachable, .saving, .unknown: return nil
            }
            guard let value = merged ?? (newest == change ? nil : newest.value), value != holds else {
                held.remove(at: index)
                return nil
            }
            held[index] = newest.at(value, over: holds ?? newest.was)
            return merged == nil ? nil : held[index]
        }
    }

    private func write(_ changes: [Change]) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try files.replace(file, with: try JSONEncoder().encode(changes), commit: .atomic)
    }
}
