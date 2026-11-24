import Cockpit
import Combine
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct GroupScreen: View {
    let key: String
    @StateObject private var group: PageReading<HomeLink.Pages.Group>
    @ObservedObject private var book = PeopleBook.shared
    @ObservedObject private var home = HomeToday.shared
    @StateObject private var word = GroupWord()

    private static let writersFit = 8

    init(key: String) {
        self.key = key
        _group = StateObject(wrappedValue: PageReading(HomeLink.PageKey(HomeLink.Pages.Group.route, ["chat": key])))
    }

    var body: some View {
        let page = group.page
        OnePage(page?.head.title ?? "") {
            if group.failure == .missing {
                EmptyState(.meeting, "This group is not in your messages any more.")
            } else if page == nil, let failure = group.failure {
                ReadLack(failure, lacks: "This group isn't on this iPhone yet.", words: PeopleWords.failure(failure)) {
                    Task { await group.read() }
                }
            } else {
                PageNote(drawn: group.drawn)
                content(page)
            }
        }
        .accessibilityIdentifier("group.screen")
        .task(id: home.revision) { await group.read() }
        .readsAgain(failed: { group.failure }) { await group.read() }
    }

    @ViewBuilder
    private func content(_ page: HomeLink.Pages.Group?) -> some View {
        OneHead(page?.head.title ?? "Group Alpha", line: page.map { line($0.head) } ?? "Messages group · 12 people · since Mar 2025",
                identifier: "group.name") {
            PersonFace(page?.head.title, size: .head)
        }
        .reading(page == nil)
        PageTalk(talk: page?.talk, reading: page == nil)
        VStack(alignment: .leading, spacing: 0) {
            Facts("Together", page.map { page in
                [("Messages", Words.count(page.total)), page.yours.map { ("Yours", $0) }].compactMap { $0 }
            } ?? [("Messages", "0,000"), ("Yours", "00%")], reading: page == nil || page?.counting == true)
            WaitLine()
        }
        .waiting(page == nil)
        if let page, !page.writers.isEmpty {
            let most = Array(page.writers.prefix(Self.writersFit))
            Card("Who writes most", group: true) {
                ForEach(most, id: \.id) { writer in
                    let drawn = HomePictures.shared.face(writer.photo)
                    ListRow(writer.name, meta: writer.share, metaReading: page.counting, mono: true,
                            leading: .monogram(writer.named ? writer.name : nil, photo: drawn),
                            separator: writer.id != most.last?.id,
                            action: { AppNavigation.shared.push(.person(writer.id)) })
                        .readsFace(writer.photo, size: .row)
                        .facesValue(writer.photo, drawn: drawn)
                        .accessibilityIdentifier("group.writer.\(writer.id)")
                }
            }
        }
        if let page { quietRow(page.head) }
    }

    private func line(_ head: HomeLink.Pages.Group.Head) -> String {
        let since = head.since?.civilDay.map { "since " + Words.monthYear(ofDay: $0) }
        return [head.line, since].compactMap { $0 }.joined(separator: Words.dot)
    }

    private func quietRow(_ head: HomeLink.Pages.Group.Head) -> some View {
        let chosen = word.drawn(key, over: head.word)
        return SheetPart(nil) {
            SettingRow("Quiet", line: word.why(key, over: head, today: home.today), separator: false) {
                if book.takes {
                    MenuRow("Quiet", selection: Binding(get: { chosen }, set: { next in
                        guard next != chosen else { return }
                        Task { await word.choose(next, key: key) { await group.read(settled: true) } }
                    }), options: GroupWord.Choice.allCases.map { MenuRow.Option($0, $0.words) }, busy: word.acting(key))
                        .accessibilityIdentifier("group.quiet.choice")
                } else {
                    SettingValue(chosen.words)
                        .accessibilityIdentifier("group.quiet.choice")
                }
            } held: {
                if let said = word.said(key) {
                    InPlaceLine(InPlaceLine.Said(said), retry: GroupWord.sendsAgain(said) ? {
                        Task { await word.again(key) { await group.read(settled: true) } }
                    } : nil)
                    .accessibilityIdentifier("group.quiet.failure")
                }
            }
            .accessibilityIdentifier("group.quiet")
        }
    }
}

@MainActor
final class GroupWord: ObservableObject {
    enum Choice: CaseIterable, Hashable {
        case rule, quiet, never

        init(_ word: Bool?) {
            self = word.map { $0 ? .quiet : .never } ?? .rule
        }

        init(_ word: HomeLink.Pages.Group.Head.Word) {
            switch word {
            case .always: self = .quiet
            case .never: self = .never
            case .rule, .unknown: self = .rule
            }
        }

        var word: Bool? {
            switch self {
            case .rule: nil
            case .quiet: true
            case .never: false
            }
        }

        var words: String {
            switch self {
            case .rule: "Follow the rule"
            case .quiet: "Always quiet"
            case .never: "Never quiet"
            }
        }
    }

    @Published private var failed: (said: HomeLink.ActSaid, choice: Choice)?
    private let book: PeopleBook
    private var watching: AnyCancellable?

    init(book: PeopleBook = .shared) {
        self.book = book
        watching = book.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
    }

    private func held(_ key: String) -> Choice? {
        guard case .group(_, let quiet)? = book.inFlight(.chat(key)) else { return nil }
        return Choice(quiet)
    }

    func drawn(_ key: String, over word: HomeLink.Pages.Group.Head.Word) -> Choice {
        held(key) ?? Choice(word)
    }

    func why(_ key: String, over head: HomeLink.Pages.Group.Head, today: String) -> String? {
        if let held = held(key), held != Choice(head.word) { return held == .rule ? nil : "You set it" }
        guard let why = head.why else { return nil }
        let since = why.since?.civilDay.map { Words.shortDay($0, weekday: false, today: today) }
        return [why.words, since].compactMap { $0 }.joined(separator: " ")
    }

    func acting(_ key: String) -> Bool {
        book.acting(.chat(key))
    }

    func said(_ key: String) -> HomeLink.ActSaid? {
        if case .unanswered(let said)? = book.pending(.chat(key)) { return said }
        return failed?.said
    }

    static func sendsAgain(_ said: HomeLink.ActSaid) -> Bool {
        if case .refused = said { false } else { true }
    }

    func choose(_ choice: Choice, key: String, reading: @escaping @MainActor () async -> Void = {}) async {
        failed = nil
        let sent = await book.send(.chat(key), { .people(request: $0, .group(chat: key, quiet: choice.word)) }, words: choice.words,
                                   reading: reading)
        switch sent {
        case .answered, .held, .said(.saving), .said(.unknown): break
        case .refused(let refusal): failed = (.refused(refusal.words), choice)
        case .said(let said): failed = (said, choice)
        }
    }

    func again(_ key: String, reading: @escaping @MainActor () async -> Void = {}) async {
        if book.pending(.chat(key)) != nil {
            _ = await book.check(.chat(key))
        } else if let failed {
            await choose(failed.choice, key: key, reading: reading)
        }
    }
}
