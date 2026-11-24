import Foundation
import HomeLink
import LifestreamCaptureCore

@MainActor
final class SearchModel: ObservableObject {
    static let shared = SearchModel()

    typealias Search = HomeLink.Pages.Search
    typealias Kind = HomeLink.Pages.SearchKind
    typealias Row = HomeLink.Pages.SearchRow
    typealias Section = HomeLink.Pages.KindSection

    struct Asking: Equatable, Hashable, Sendable {
        var words: String
        var span: SearchWords.Span?
        var attempt: Int
    }

    struct Door {
        let answers: @MainActor (HomeLink.PageKey) -> AsyncStream<PageShelf.Drawn<Search>>
        let kind: @MainActor (HomeLink.PageKey) async throws -> Kind
        let revision: @MainActor () -> Int

        @MainActor static var life: Door {
            Door(answers: { AppRuntime.shared.pages.reading(Search.self, $0) }, kind: { try await AppRuntime.shared.life.searchKind($0) },
                 revision: { AppRuntime.shared.life.revision })
        }
    }

    enum Answer: Equatable {
        case found(Search)
        case failed(LifeReader.Failure)
    }

    enum Part: Equatable, Identifiable {
        case top([Row])
        case kind(Section)

        var id: String {
            switch self {
            case .top: "top"
            case .kind(let kind): kind.family.rawValue
            }
        }
    }

    struct Seeing: Equatable, Hashable, Sendable {
        let asking: Asking
        let family: String
        let upcoming: Bool
    }

    struct Page: Equatable {
        let seeing: Seeing
        var rows: [Row]
        var next: String?
        var reading: HomeLink.Pages.Reading?
        var unread: String?
        var nothing: String?
        var failed: LifeReader.Failure?
    }

    enum Seen: Equatable {
        case page(Page)
        case failed(Seeing, LifeReader.Failure)
    }

    struct Sitting: Hashable {
        let key: String
        let title: String
        let said: String?
        let when: HomeLink.Pages.When
        let windows: [HomeLink.Pages.SearchWindow]
        let windowsLine: String?
        let opens: HomeLink.Pages.Opens

        func hash(into hasher: inout Hasher) {
            hasher.combine(key)
        }
    }

    nonisolated static let tiles = 3
    static let gone = "Couldn't open this."
    static let elsewhere = "Can't open this on iPhone yet."

    @Published var text = "" {
        didSet {
            guard words.isEmpty else { return }
            kind = nil
            kept = nil
            upcoming = false
        }
    }
    @Published var span: SearchWords.Span? {
        didSet { if span != oldValue { upcoming = false } }
    }
    @Published var kind: String? {
        didSet { if kind != oldValue { upcoming = false } }
    }
    @Published var upcoming = false
    @Published private var attempt = 0
    @Published private(set) var answer: Answer?
    @Published private(set) var kept: Search?
    @Published private(set) var seen: Seen?
    @Published private(set) var loadingMore = false
    @Published private(set) var unopened: [String: String] = [:]
    @Published var viewing: PhotoViewer.Opening?
    @Published private(set) var recent: SearchHistory
    @Published private(set) var places: [HomeLink.Pages.PlaceRow] = []
    @Published private(set) var namesRead = false
    private(set) var placesRead = false

    private let door: Door
    private let placesPage = PageReading<HomeLink.Pages.Places>(HomeLink.PageKey(HomeLink.Pages.Places.route))
    private let settle: Duration
    private let wait: Duration

    private convenience init() {
        self.init(door: .life, recent: AppRuntime.shared.root.appendingPathComponent(DisplayCaches.search).appendingPathComponent("recent.json"))
    }

    init(door: Door, recent file: URL, settle: Duration = .milliseconds(150), wait: Duration = .seconds(5)) {
        self.door = door
        self.settle = settle
        self.wait = wait
        recent = SearchHistory(file: file)
    }

    var words: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var found: Search? {
        if case .found(let found) = answer { return found }
        return nil
    }

    var asking: Asking { Asking(words: words, span: span, attempt: attempt) }

    var seeing: Seeing? {
        guard !words.isEmpty, let kind else { return nil }
        return Seeing(asking: asking, family: kind, upcoming: upcoming && chosenKind?.upcoming != nil)
    }

    var page: Page? {
        if case .page(let page) = seen, page.seeing == seeing { return page }
        return nil
    }

    var today: String { HomeClock.current.today() }

    var drawn: Search? {
        switch answer {
        case .found(let found): found
        case .failed, nil: kept
        }
    }

    var parts: [Part] {
        guard let drawn else { return [] }
        return (drawn.top.isEmpty ? [] : [.top(drawn.top)]) + drawn.kinds.map(Part.kind)
    }

    func offset(of family: String) -> Int {
        guard let drawn else { return 0 }
        let before = drawn.kinds.prefix { $0.family.rawValue != family }.map { $0.rows.filter(Self.isHit).count }.reduce(0, +)
        return drawn.top.filter(Self.isHit).count + before
    }

    static func isHit(_ row: Row) -> Bool {
        if case .hit = row { true } else { false }
    }

    static func readying(_ found: Search) -> String? {
        guard case .building(let line, _)? = found.reading, found.top.isEmpty, found.kinds.isEmpty else { return nil }
        return line
    }

    static func isEmpty(_ found: Search) -> Bool {
        found.top.isEmpty && found.kinds.isEmpty
    }

    func chipsShown(_ found: Search) -> Bool {
        !found.kinds.isEmpty || !found.top.isEmpty || span != nil || kind != nil
    }

    func stillReading(_ found: Search) -> String? {
        SearchWords.reading(found.reading, today: today)
    }

    func stillReading(_ page: Page) -> String? {
        SearchWords.reading(page.reading, today: today)
    }

    func seenUnread(_ kind: Section?) -> String? {
        guard let page else { return kind?.unread }
        return page.unread
    }

    var chosenKind: Section? {
        drawn?.kinds.first { $0.family.rawValue == kind }
    }

    var spans: [SearchWords.Span] { SearchWords.spans(today: today, first: drawn?.held?.first) }

    var suggestedPeople: [HomeLink.Person] { PeopleBook.shared.drawn?.suggested ?? [] }

    var suggestedPlaces: [HomeLink.Pages.PlaceRow] { Array(places.prefix(Self.tiles)) }

    func readNames() async {
        await PeopleBook.shared.need()
        if !placesRead {
            await placesPage.read()
            placesRead = placesPage.page != nil
        }
        places = placesPage.page?.cities.flatMap { $0.places + $0.once } ?? []
        if !Task.isCancelled { namesRead = true }
    }

    func forget() {
        draw(nil)
        kept = nil
        seen = nil
        kind = nil
        span = nil
        upcoming = false
        places = []
        namesRead = false
        placesRead = false
    }

    func ask(_ asking: Asking) async {
        guard !asking.words.isEmpty else {
            draw(nil)
            return
        }
        try? await Task.sleep(for: settle)
        let key = Self.key(asking)
        while !Task.isCancelled {
            var last: Search?
            for await drawn in door.answers(key) {
                guard !Task.isCancelled else { return }
                take(drawn)
                last = drawn.page
            }
            guard !Task.isCancelled, case .found? = answer, let last, Self.readying(last) != nil else { return }
            try? await Task.sleep(for: wait)
        }
    }

    func see(_ seeing: Seeing?) async {
        guard let seeing else { return }
        if case .page(let page) = seen, page.seeing == seeing { return }
        loadingMore = false
        do {
            try await Task.sleep(for: settle)
            while true {
                let page = try await read(seeing, cursor: nil)
                guard !Task.isCancelled, self.seeing == seeing else { return }
                if let page {
                    seen = .page(page)
                    return
                }
                try await Task.sleep(for: wait)
            }
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, self.seeing == seeing else { return }
            seen = .failed(seeing, Self.failure(error))
        }
    }

    func more() async {
        guard let page, let next = page.next, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        let later: Result<Page?, Error>
        var over = false
        do {
            later = .success(try await read(page.seeing, cursor: next))
        } catch is HomeLink.CursorExpired {
            over = true
            do {
                later = .success(try await read(page.seeing, cursor: nil))
            } catch {
                later = .failure(error)
            }
        } catch {
            later = .failure(error)
        }
        guard !Task.isCancelled, case .page(var now) = seen, now.seeing == page.seeing else { return }
        switch later {
        case .success(let later?) where over:
            now = later
        case .success(let later?):
            now.rows += later.rows
            now.next = later.next
            now.reading = later.reading
            now.unread = later.unread
            now.failed = nil
        case .success(nil):
            return
        case .failure(let error):
            if error is CancellationError { return }
            now.failed = Self.failure(error)
        }
        seen = .page(now)
    }

    func open(_ row: Row) -> LifeRoute? {
        switch row {
        case .hit(let ref, let family, _, _, _, let picture, let opens):
            if family == .photos, let picture {
                unopened[ref] = nil
                viewing = PhotoViewer.Opening(photos: [picture], at: 0)
                return nil
            }
            return reached(ref, opens, family: family.rawValue)
        case .person(let ref, _, _, _, let opens), .place(let ref, _, _, let opens):
            return reached(ref, opens, family: nil)
        case .date(_, let opens):
            return LifeRoute.opening(opens, family: nil)
        case .track(_, let title, let artist, _):
            return .track(title, artist: artist)
        case .sitting(let key, let title, _, let said, let when, let windows, let windowsLine, let opens):
            return .sitting(Sitting(key: key, title: title, said: said, when: when, windows: windows, windowsLine: windowsLine, opens: opens))
        case .unknown:
            return nil
        }
    }

    func tryAgain() { attempt += 1 }

    func remember() { recent.add(words) }

    func clearRecent() { recent.clear() }

    static func key(_ asking: Asking) -> HomeLink.PageKey {
        HomeLink.PageKey(Search.route, query(asking))
    }

    static func key(_ seeing: Seeing) -> HomeLink.PageKey {
        var query = query(seeing.asking)
        query["see"] = seeing.family
        if seeing.upcoming { query["upcoming"] = "1" }
        return HomeLink.PageKey(Kind.route, query)
    }

    private static func query(_ asking: Asking) -> [String: String] {
        var query = ["query": asking.words, "typing": "1"]
        if let span = asking.span {
            query["from"] = span.from
            query["to"] = span.to
        }
        return query
    }

    private func reached(_ ref: String, _ opens: HomeLink.Pages.Opens?, family: String?) -> LifeRoute? {
        let route = opens.flatMap { LifeRoute.opening($0, family: family) }
        unopened[ref] = route != nil ? nil : opens == nil ? Self.gone : Self.elsewhere
        return route
    }

    private func take(_ drawn: PageShelf.Drawn<Search>) {
        kept = drawn.page
        let failure = PageReading<Search>.failure(drawn.state, begun: door.revision())
        draw(failure.map(Answer.failed) ?? drawn.page.map(Answer.found))
    }

    private func draw(_ answer: Answer?) {
        unopened = [:]
        self.answer = answer
    }

    private func read(_ seeing: Seeing, cursor: String?) async throws -> Page? {
        let read = try await door.kind(cursor.map { HomeLink.PageKey(Kind.route, ["cursor": $0]) } ?? Self.key(seeing))
        if case .building? = read.reading, read.rows.isEmpty { return nil }
        return Page(seeing: seeing, rows: read.rows, next: read.next, reading: read.reading, unread: read.unread, nothing: read.nothing)
    }

    private static func failure(_ error: Error) -> LifeReader.Failure {
        (error as? LifeReader.Failure) ?? .refused(String(describing: error))
    }
}
