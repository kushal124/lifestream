import Foundation
import HomeLink
import os

private let pagesLog = Logger(subsystem: "org.lifestreamprotocol.phone", category: "pages")

public protocol PageAnswer: Decodable, Sendable, Equatable {
    static var route: String { get }
    var position: String { get }
    var became: String? { get }
    var counting: Bool { get }
}

extension PageAnswer {
    public var became: String? { nil }
    public var counting: Bool { false }
}

extension HomeLink.Pages.People: PageAnswer {}
extension HomeLink.Pages.Person: PageAnswer {}
extension HomeLink.Pages.Group: PageAnswer {}
extension HomeLink.Pages.PeopleFind: PageAnswer {}
extension HomeLink.Pages.Search: PageAnswer {}
extension HomeLink.Pages.Places: PageAnswer {}
extension HomeLink.Pages.Place: PageAnswer {}
extension HomeLink.Pages.PlaceEdit: PageAnswer {}
extension HomeLink.Pages.Year: PageAnswer {}
extension HomeLink.Pages.Days: PageAnswer {}
extension HomeLink.Pages.Day: PageAnswer {}
extension HomeLink.Pages.Moment: PageAnswer {}
extension HomeLink.Pages.Thread: PageAnswer {}
extension HomeLink.Pages.Settings: PageAnswer {}
extension HomeLink.Pages.SettingsPage: PageAnswer {}
extension HomeLink.Pages.Storage: PageAnswer {}
extension HomeLink.Pages.Feedback: PageAnswer {}

public actor PageShelf {
    public static let days = 14
    public static let searches = 20
    public static let dayRoute = "/v1/page/day"
    static let indexName = "index.json"

    public enum State: Sendable, Equatable {
        case kept
        case fresh
        case offline
        case waiting(line: String, until: Date)
        case missing
        case refused(String)
        case failed(String)
    }

    public struct Drawn<Page: PageAnswer>: Sendable {
        public let key: HomeLink.PageKey
        public let page: Page?
        public let position: HomeLink.Position?
        public let state: State

        public init(key: HomeLink.PageKey, page: Page?, position: HomeLink.Position?, state: State) {
            self.key = key
            self.page = page
            self.position = position
            self.state = state
        }

        public var asOf: Date? {
            position.map { Date(timeIntervalSince1970: TimeInterval($0.atMs) / 1000) }
        }
    }

    struct Kept: Codable {
        let etag: String?
        let position: String
        let body: String
    }

    private struct Shelved<Page: PageAnswer> {
        let etag: String?
        let position: HomeLink.Position?
        let page: Page
    }

    private let folder: URL
    private let link: HomeLink
    private let clock: @Sendable () -> Date
    private let pause: @Sendable (TimeInterval) async -> Void
    private var keys: [String]?
    private var generation = 0

    public init(root: URL, link: HomeLink, clock: @escaping @Sendable () -> Date = { AppClock.now },
                pause: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) }) {
        folder = root.appendingPathComponent(DisplayCaches.pages, isDirectory: true)
        self.link = link
        self.clock = clock
        self.pause = pause
    }

    public func kept<Page: PageAnswer>(_ type: Page.Type, _ key: HomeLink.PageKey) -> Drawn<Page>? {
        shelved(type, key).map { Drawn(key: key, page: $0.page, position: $0.position, state: .kept) }
    }

    public nonisolated func reading<Page: PageAnswer>(_ type: Page.Type, _ key: HomeLink.PageKey,
                                                      settled: Bool = false) -> AsyncStream<Drawn<Page>> {
        AsyncStream { out in
            let task = Task {
                await self.follow(Page.self, key, settled: settled, out)
                out.finish()
            }
            out.onTermination = { _ in task.cancel() }
        }
    }

    public func empty() {
        generation += 1
        try? FileManager.default.removeItem(at: folder)
        keys = []
    }

    private func follow<Page: PageAnswer>(_ type: Page.Type, _ asked: HomeLink.PageKey, settled: Bool,
                                          _ out: AsyncStream<Drawn<Page>>.Continuation) async {
        let generation = generation
        var key = asked
        var held = shelved(type, key)
        if let held { out.yield(Drawn(key: key, page: held.page, position: held.position, state: .kept)) }
        var settled = settled
        while !Task.isCancelled {
            let answer: HomeLink.Tagged<Data>?
            do {
                answer = try await link.page(key, etag: held?.etag, settled: settled)
            } catch {
                guard !Task.isCancelled, self.generation == generation else { return }
                held = shelved(type, key) ?? held
                let state = Self.state(of: error, now: clock())
                out.yield(Drawn(key: key, page: held?.page, position: held?.position, state: state))
                guard case .waiting(_, let until) = state else { return }
                await pause(max(0, until.timeIntervalSince(clock())))
                continue
            }
            guard !Task.isCancelled, self.generation == generation else { return }
            guard let answer else {
                guard let same = shelved(type, key) ?? held else { return }
                held = same
                out.yield(Drawn(key: key, page: same.page, position: same.position, state: .fresh))
                guard same.page.counting else { return }
                settled = true
                continue
            }
            let page: Page
            do {
                page = try JSONDecoder().decode(type, from: answer.value)
            } catch {
                pagesLog.error("a page answer did not read: \(key.route, privacy: .public)")
                out.yield(Drawn(key: key, page: held?.page, position: held?.position,
                                state: .failed(LinkFailure.unreadable(200).description)))
                return
            }
            let filed = page.became.map { key.became($0) } ?? key
            if filed != key { drop(key) }
            key = filed
            let position = HomeLink.Position(page.position)
            if let newer = shelved(type, filed), let ahead = newer.position, let position, position < ahead {
                pagesLog.info("an older page answer was refused over a newer one: \(filed.route, privacy: .public)")
                held = newer
                out.yield(Drawn(key: filed, page: newer.page, position: newer.position, state: .fresh))
            } else {
                held = Shelved(etag: answer.etag, position: position, page: page)
                keep(filed, Kept(etag: answer.etag, position: page.position, body: String(decoding: answer.value, as: UTF8.self)))
                out.yield(Drawn(key: filed, page: page, position: position, state: .fresh))
            }
            guard page.counting else { return }
            settled = true
        }
    }

    static func state(of error: Error, now: Date) -> State {
        if case let .unavailable(_, message, retryAfter, notNow)? = error as? LinkFailure, notNow != nil {
            return .waiting(line: message ?? ReachWords.waiting, until: now.addingTimeInterval(retryAfter ?? HomeLink.probeEvery))
        }
        if case .refused(404, _, _)? = error as? LinkFailure { return .missing }
        switch HomeLink.state(of: error, now: now) {
        case .reach?: return .offline
        case .wait(let words, let until)?: return .waiting(line: words, until: until)
        case .refused(let words)?, .unknown(let words)?: return .refused(words)
        case .failed?, .saving?, .inFlight?, nil: return .failed(String(describing: error))
        }
    }

    private func shelved<Page: PageAnswer>(_ type: Page.Type, _ key: HomeLink.PageKey) -> Shelved<Page>? {
        guard index().contains(key.description) else { return nil }
        guard let data = try? Data(contentsOf: file(key)),
              let kept = try? JSONDecoder().decode(Kept.self, from: data),
              let page = try? JSONDecoder().decode(type, from: Data(kept.body.utf8)),
              page.position == kept.position else {
            pagesLog.error("a kept page does not read and is dropped: \(key.route, privacy: .public)")
            drop(key)
            return nil
        }
        return Shelved(etag: kept.etag, position: HomeLink.Position(kept.position), page: page)
    }

    private func keep(_ key: HomeLink.PageKey, _ kept: Kept) {
        var list = index().filter { $0 != key.description }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileDurability.excludeFromBackup(folder)
            try JSONEncoder().encode(kept).write(to: file(key), options: FileDurability.unlockedOnly)
        } catch {
            pagesLog.error("a page was not kept: \(String(describing: error), privacy: .public)")
            return
        }
        list.insert(key.description, at: 0)
        let dropped = Set(list.filter(Self.isDay).dropFirst(Self.days) + list.filter(Self.isSearch).dropFirst(Self.searches))
        for gone in dropped {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(Self.name(of: gone)))
        }
        save(list.filter { !dropped.contains($0) })
    }

    private func drop(_ key: HomeLink.PageKey) {
        try? FileManager.default.removeItem(at: file(key))
        let list = index()
        guard list.contains(key.description) else { return }
        save(list.filter { $0 != key.description })
    }

    private func index() -> [String] {
        if let keys { return keys }
        let read = (try? Data(contentsOf: folder.appendingPathComponent(Self.indexName)))
            .flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
        let held = read.filter { FileManager.default.fileExists(atPath: folder.appendingPathComponent(Self.name(of: $0)).path) }
        let known = Set(held.map(Self.name(of:)) + [Self.indexName])
        for name in (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? [] where !known.contains(name) {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
        }
        keys = held
        if held != read { save(held) }
        return held
    }

    private func save(_ list: [String]) {
        keys = list
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileDurability.excludeFromBackup(folder)
            try JSONEncoder().encode(list).write(to: folder.appendingPathComponent(Self.indexName), options: FileDurability.unlockedOnly)
        } catch {
            pagesLog.error("the kept pages' order was not kept: \(String(describing: error), privacy: .public)")
        }
    }

    private func file(_ key: HomeLink.PageKey) -> URL {
        folder.appendingPathComponent(Self.name(of: key.description))
    }

    static func name(of key: String) -> String {
        SHA256Digest.hex(Data(key.utf8)) + ".json"
    }

    static func isDay(_ key: String) -> Bool {
        key.hasPrefix(dayRoute + "?") || key.hasPrefix(dayRoute + "/")
    }

    static func isSearch(_ key: String) -> Bool {
        key.hasPrefix(HomeLink.Pages.Search.route + "?")
    }
}
