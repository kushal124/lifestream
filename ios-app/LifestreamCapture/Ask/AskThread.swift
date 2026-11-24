import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit

struct AskThread: View {
    @ObservedObject var conversation: AskConversation
    @ObservedObject private var book = AskBook.shared
    @ObservedObject private var home = HomeToday.shared
    @ObservedObject private var agents = AppRuntime.shared.agents
    @ObservedObject private var feedbackPage = FeedbackDesk.page
    @State private var reporting: FeedbackOpening?
    @State private var position = ScrollPosition(idType: Int.self)
    @State private var opened: Opened?
    @State private var counted: Counted?
    @State private var described: [String: HomeLink.Citation] = [:]
    @State private var unopened: Unopened?
    @State private var disclosed: Set<Int> = []
    @State private var modelViews: Set<Int> = []
    @State private var atEnd = true
    @FocusState private var focused: Bool

    @State private var asked = false

    struct Opened: Identifiable {
        let handle: String
        let day: String
        let focus: String
        let marks: [String]
        var id: String { handle }
    }

    struct Unopened {
        let turn: Int
        let handle: String
        let words: String
        let again: Bool
    }

    struct Counted: Identifiable {
        let handle: String
        let ref: String
        let asked: String
        var id: String { handle }
    }

    var body: some View {
        GeometryReader { view in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if conversation.turns.isEmpty {
                        empty
                    }
                    ForEach(conversation.turns.indices, id: \.self) { index in
                        let turn = conversation.turns[index]
                        turnView(turn, after: index == 0 ? nil : conversation.turns[index - 1])
                            .frame(minHeight: asked && index == conversation.turns.count - 1 ? max(0, view.size.height - Cockpit.Space.s4 * 2) : nil,
                                   alignment: .top)
                            .id(turn.id)
                    }
                }
                .scrollTargetLayout()
                .padding(.horizontal, Cockpit.Gap.edge)
                .padding(.top, Cockpit.Space.s4)
                .padding(.bottom, Cockpit.Space.s4)
                .frame(minHeight: view.size.height, alignment: .top)
                .tappingKeyboardAway($focused)
            }
            .scrollPosition($position, anchor: .top)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.visibleRect.maxY - geometry.contentInsets.bottom >= geometry.contentSize.height - 2
            } action: { _, end in
                atEnd = end
            }
            .scrollBounceBehavior(.always, axes: .vertical)
            .scrollDismissesKeyboard(.never)
            .accessibilityIdentifier("ask.thread")
        }
        .overlay(alignment: .bottom) {
            if !atEnd {
                IconButton(.expand, label: "Scroll to the end", style: .glass) {
                    withAnimation { position.scrollTo(edge: .bottom) }
                }
                .accessibilityIdentifier("ask.end")
                .padding(.bottom, Cockpit.Space.s3)
            }
        }
        .feedbackSheet($reporting)
        .groundColor(Cockpit.Color.canvas)
        .chatBar(conversation: true, title: conversation.title)
        .pageFoot(lettingKeyboardGo: $focused) { foot }
        .sheet(item: $opened) { opened in moment(opened) }
        .sheet(item: $counted) { counted in
            AskStatsSheet(ref: counted.ref, asked: counted.asked) { sentence in
                conversation.draft = sentence
                focused = true
            }
        }
        .readsAgain(failed: { if case .failed(let failure) = conversation.read { failure } else { nil } }) { await conversation.open() }
        .task {
            let unread = conversation.read == .unread
            await conversation.open()
            if unread, !conversation.turns.isEmpty, !AppRuntime.asked("--ui-test-scroll") {
                await Task.yield()
                position.scrollTo(edge: .bottom)
            }
        }
        .onChange(of: conversation.turns.count) { before, after in
            if after == before + 1, before > 0, let last = conversation.turns.last {
                asked = true
                position.scrollTo(id: last.id, anchor: .top)
            }
        }
        .onDisappear { book.player.stop(conversation) }
        .onChange(of: conversation.focus, initial: true) { _, focus in
            guard focus else { return }
            focused = true
            conversation.focus = false
        }
    }


    @ViewBuilder
    private func turnView(_ turn: AskConversation.Turn, after previous: AskConversation.Turn?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            let stamp = Self.sitting(turn, after: previous) ? AskWords.stamp(turn.at, today: home.today) : nil
            let seen = Self.seen(turn)
            let modelView = seen != nil && modelViews.contains(turn.id)
            let photos = turn.photos.isEmpty ? nil : AnyView(AskQuestionPhotos(photos: turn.photos, seen: modelView ? seen?.photos : nil))
            if let note = turn.note {
                AskNoteQuestion(note: note, player: book.player, at: Words.stamp(turn.at), stamp: stamp, photos: photos, seen: seen?.asked, modelView: modelView) {
                    conversation.play(turn)
                }
                .accessibilityIdentifier("ask.question.voice")
            } else {
                AskQuestion(turn.question, at: Words.stamp(turn.at), stamp: stamp, picture: photos, edit: edit(turn),
                            seen: seen?.asked, modelView: modelView)
                    .accessibilityIdentifier(turn.photos.isEmpty ? "ask.question" : "ask.question.photos")
            }
            let answer = turn.answer
            AskSteps(answer.trace, waiting: answer.end == .running ? answer.waiting : nil,
                     open: Binding(get: { disclosed.contains(turn.id) },
                                   set: { if $0 { disclosed.insert(turn.id) } else { disclosed.remove(turn.id) } }))
                .padding(.top, Cockpit.Space.s3 + 2)
                .accessibilityIdentifier("ask.steps")
            ForEach(answer.access) { change in
                access(change).padding(.top, Self.result)
            }
            if case .failed(let sentence) = answer.end, conversation.mend(turn) == .photo {
                InPlaceLine(sentence, act: "Remove photo") { conversation.unrefuse(turn) }
                    .padding(.top, Cockpit.Space.s3)
                    .accessibilityIdentifier("ask.answer")
            } else if case .failed(let sentence) = answer.end, conversation.mend(turn) == .remove {
                InPlaceLine(sentence, act: "Remove") { conversation.withdraw(turn) }
                    .padding(.top, Cockpit.Space.s3)
                    .accessibilityIdentifier("ask.answer")
            } else if !(answer.signIn && book.waits) {
                AskAnswer(answer.trace, refs: refs(answer.refs ?? [:]), open: opened?.handle,
                          end: end(turn), seen: seen,
                          modelView: seen == nil ? nil : Binding(get: { modelViews.contains(turn.id) },
                                                                 set: { if $0 { modelViews.insert(turn.id) } else { modelViews.remove(turn.id) } }),
                          feedback: feedback(answer),
                          cite: { handle in cite(handle, answer, in: turn.id) }) { handle, _, fit in
                    AskPicture(hash: answer.refs?[handle]?.citation?.image, fit: fit)
                } voice: { handle, note in
                    if let voice = answer.refs?[handle].flatMap(heard) {
                        AskVoice(voice: voice, note: note, player: book.player, replay: conversation.replays[voice.record],
                                 play: { conversation.play(voice) }, open: { cite(handle, answer, in: turn.id) })
                            .accessibilityIdentifier("ask.voice")
                    }
                }
                .padding(.top, Cockpit.Space.s3)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("ask.answer")
                if let unopened, unopened.turn == turn.id {
                    InPlaceLine(unopened.words, retry: unopened.again ? { cite(unopened.handle, answer, in: turn.id) } : nil)
                        .padding(.top, Cockpit.Space.s3)
                        .accessibilityIdentifier("ask.unopened")
                }
                if answer.unsaved {
                    InPlaceLine(AskConversation.Answer.notSaved)
                        .padding(.top, Cockpit.Space.s3)
                        .accessibilityIdentifier("ask.unsaved")
                }
            }
        }
        .padding(.top, previous == nil ? 0 : Cockpit.Space.s10)
    }

    private static let result: CGFloat = 18

    static func seen(_ turn: AskConversation.Turn) -> AskSeen? {
        guard let kept = turn.answer.seen else { return nil }
        let spans = { (spans: [HomeLink.Ask.Message.Seen.Span]) in
            spans.map { span in span.placeholder.map { AskSeen.Span.placeholder(span.start, span.end, $0) } ?? .added(span.start, span.added ?? "") }
        }
        let end: AskSeen.End = switch turn.answer.end {
        case .running: .running
        case .done: .done
        case .stopped: .stopped
        case .failed: .failed
        }
        let shown: String? = if let note = turn.note { note.words } else { turn.question }
        guard let words = shown else { return nil }
        return AskSeen.eye(AskSeen(asked: spans(kept.asked), spoken: kept.spoken, answered: spans(kept.answered), photos: kept.photos),
                           words: words, voice: turn.note != nil, photos: turn.photos.count, answer: turn.answer.trace.text, end: end)
    }

    @ViewBuilder private func access(_ change: HomeLink.AccessChange) -> some View {
        switch change {
        case .narrowed(let id, let reader, let narrowed):
            let state = agents.undos[id]
            let failed: String? = if case .failed(let words, _) = state { words } else { nil }
            let again = switch state {
            case nil: true
            case .failed(_, let again)?: again
            case .sending?, .done?: false
            }
            AskAccessLine(AgentsWords.plain(narrowed.words), undoing: state == .sending, failed: failed,
                          undo: again || state == .sending ? { agents.undo(id, reader: reader, narrowed.undo) } : nil)
                .accessibilityIdentifier("ask.access.line")
        case .unchanged(_, _, let words):
            AskAccessLine(words)
                .accessibilityIdentifier("ask.access.line")
        case .asked(_, let snapshot):
            let listed = agents.listed(snapshot.id)
            let ended = agents.ended[snapshot.id]
            let card = agents.cards[snapshot.id]
            let choices = agents.choices(listed ?? snapshot)
            AskAccessCard(head: snapshot.head, adds: snapshot.adds, keeps: snapshot.keeps, screen: snapshot.screen,
                          answered: ended?.outcome.map { Words.phrase($0) } ?? agents.gone[snapshot.id], allowed: ended?.state == .allowed,
                          words: (choices.first { $0.answer != .no }?.words, choices.first { $0.answer == .no }?.words ?? "Don\u{2019}t allow"),
                          sending: card?.sending, failed: card?.failed,
                          edit: listed.flatMap { ask in card?.checking != true && agents.changes(ask) ? { agents.edit(ask) } : nil },
                          answer: listed.flatMap { ask in card?.checking == true ? nil : { agents.answerChat(ask, $0) } })
                .accessibilityIdentifier("ask.access.card")
                .task { agents.follow(snapshot.id) }
        }
    }

    static func sitting(_ turn: AskConversation.Turn, after previous: AskConversation.Turn?) -> Bool {
        guard let previous else { return true }
        return HomeClock.current.dayAt(previous.at).day != HomeClock.current.dayAt(turn.at).day
            || turn.at.timeIntervalSince(previous.at) >= 3600
    }

    private func end(_ turn: AskConversation.Turn) -> AskEnd {
        switch turn.answer.end {
        case .running: .running
        case .done: .done
        case .stopped: .stopped
        case .failed(let sentence): .failed(sentence, retry: { conversation.retry(turn) })
        }
    }

    private func edit(_ turn: AskConversation.Turn) -> (() -> Void)? {
        {
            conversation.draft = turn.question
            focused = true
        }
    }

    private func refs(_ refs: [String: HomeLink.Ask.Cited]) -> [String: AskRef] {
        refs.mapValues { cited in
            let citation = cited.citation ?? described[cited.ref]
            let voice = heard(cited).map { voice in
                AskRef.Voice(record: voice.record, seconds: voice.seconds, from: voice.from, mine: voice.mine, when: citation.flatMap(when))
            }
            return AskRef(citation?.words ?? "A moment", day: citation?.day.map { Words.shortDay($0, today: home.today) },
                          image: citation?.image != nil, source: voice == nil ? citation.flatMap(Self.source) : nil, voice: voice)
        }
    }

    private func heard(_ cited: HomeLink.Ask.Cited) -> HomeLink.Citation.Voice? {
        conversation.voice((cited.citation ?? described[cited.ref])?.voice)
    }

    private func when(_ citation: HomeLink.Citation) -> String? {
        guard let day = citation.day else { return nil }
        return [Words.shortDay(day, today: home.today), SearchWords.clock(local: citation.at)].compactMap { $0 }.joined(separator: ", ")
    }

    private static func source(_ citation: HomeLink.Citation) -> String? {
        guard let chat = citation.chat else { return nil }
        return "\(citation.day ?? "") \(chat)"
    }

    private func cite(_ handle: String, _ answer: AskConversation.Answer, in turn: Int) {
        guard let cited = answer.refs?[handle] else { return }
        unopened = nil
        Task {
            let citation: HomeLink.Citation
            if let known = cited.citation ?? described[cited.ref] {
                citation = known
            } else {
                do {
                    guard let first = try await AppRuntime.shared.life.describe([cited.ref]).described.first else {
                        unopened = Unopened(turn: turn, handle: handle, words: "Couldn't open this now.", again: true)
                        return
                    }
                    described[cited.ref] = first
                    citation = first
                } catch {
                    let words = (error as? LifeReader.Failure).flatMap(PeopleWords.failure) ?? "Couldn't open this."
                    unopened = Unopened(turn: turn, handle: handle, words: words, again: true)
                    return
                }
            }
            open(handle, citation, answer, in: turn)
        }
    }

    private func open(_ handle: String, _ citation: HomeLink.Citation, _ answer: AskConversation.Answer, in turn: Int) {
        switch CitedOpening.of(citation) {
        case .moment(let day, let focus):
            opened = Opened(handle: handle, day: day, focus: focus, marks: citedChat(citation, focus: focus, among: answer.refs ?? [:]))
        case .day(let day): AppNavigation.shared.open(.day(day), in: .ask)
        case .route(let route): AppNavigation.shared.open(route, in: .ask)
        case .row(let ref, let asked): counted = Counted(handle: handle, ref: ref, asked: asked)
        case .nothing:
            unopened = Unopened(turn: turn, handle: handle, words: CitedOpening.unopened(citation), again: false)
        }
    }

    private func moment(_ opened: Opened) -> some View {
        InspectorSheet(day: opened.day, focus: opened.focus, marks: opened.marks.isEmpty ? nil : opened.marks)
    }

    private func citedChat(_ citation: HomeLink.Citation, focus: String, among refs: [String: HomeLink.Ask.Cited]) -> [String] {
        guard focus.hasPrefix(Self.recordFocus), let source = Self.source(citation) else { return [] }
        let focuses = refs.values.compactMap { $0.citation ?? described[$0.ref] }.filter { Self.source($0) == source }.compactMap { each -> String? in
            guard case .days(_, let focus?) = each.opens, focus.hasPrefix(Self.recordFocus) else { return nil }
            return focus
        }
        return Set(focuses + [focus]).sorted()
    }

    private static let recordFocus = "rec:"

    @ViewBuilder
    private var empty: some View {
        if case .failed(let failure) = conversation.read {
            ReadLack(failure, lacks: "This conversation isn't on this iPhone yet.", words: PeopleWords.failure(failure)) {
                Task { await conversation.open() }
            }
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(0..<2, id: \.self) { index in
                    AskQuestion("When did I last have dinner with Person A?")
                        .padding(.top, index == 0 ? 0 : Cockpit.Space.s10)
                    AskAnswer(AskTrace("You had dinner at Synthetic Cafe with Person A on Friday 16 October, from about 19:40 to 22:10."),
                              refs: [:], cite: { _ in }) { _, _, _ in EmptyView() }
                        .padding(.top, Cockpit.Space.s4)
                }
                WaitLine()
            }
            .reading(true)
        }
    }

    private func feedback(_ answer: AskConversation.Answer) -> AskFeedback? {
        guard let page = feedbackPage.page, page.open, let chat = conversation.chat, let n = answer.n else { return nil }
        return AskFeedback(page.title) { reporting = .take(.chat(chat, n: n)) }
    }

    private var foot: some View {
        AskFoot(draft: $conversation.draft, picked: $conversation.picked, owner: conversation.key, running: conversation.running,
                focus: $focused, send: send, sendNote: send, stop: conversation.stop, conversation: conversation)
    }

    private func send() {
        guard book.askable, book.outbox.refusal(conversation.picked, limits: book.limits) == nil,
              conversation.ask(conversation.draft, photos: conversation.picked) else { return }
        conversation.draft = ""
        conversation.picked = []
    }

    private func send(_ note: ChatRecorder.Note) -> Bool {
        guard conversation.ask(voice: note, photos: conversation.picked) else { return false }
        conversation.picked = []
        return true
    }
}

struct AskNoteQuestion: View {
    let note: AskConversation.Note
    @ObservedObject var player: NotePlayer
    let at: String
    let stamp: String?
    let photos: AnyView?
    let seen: [AskSeen.Span]?
    let modelView: Bool
    let play: () -> Void

    var body: some View {
        let levels = shown
        let played: Double? = switch player.state(of: note.sound) {
        case let .playing(at, of), let .paused(at, of): of > 0 ? at / of : 0
        case .idle, .loading, .failed: nil
        }
        let playing = if case .playing = player.state(of: note.sound) { true } else { false }
        AskQuestion(voice: AskQuestion.Voice(time: ChatRecorder.time(ms: note.ms), levels: levels,
                                             played: played.map { Int(($0 * Double(levels.count)).rounded()) },
                                             playing: playing, words: note.words, writing: note.writing,
                                             play: play),
                    at: at, stamp: stamp, picture: photos, seen: seen, modelView: modelView)
    }

    private var shown: [Double] {
        note.levels.isEmpty ? Array(repeating: 0.12, count: 40) : note.levels
    }
}

struct AskVoice: View {
    let voice: HomeLink.Citation.Voice
    let note: AskRef.Voice
    @ObservedObject var player: NotePlayer
    let replay: AskConversation.Replay?
    let play: () -> Void
    let open: () -> Void

    var body: some View {
        VoiceCite(note, look: Self.look(player.state(of: .held(voice.audio)), replay), toggle: play, open: open)
    }

    static func look(_ state: NotePlayer.State, _ replay: AskConversation.Replay?) -> VoiceCite.Look {
        switch state {
        case .loading: return .loading
        case let .playing(at, of): return .playing(at: at, of: of)
        case let .paused(at, of): return .paused(at: at, of: of)
        case .idle, .failed: break
        }
        switch replay {
        case .unreached(let words)?: return .unreached(words)
        case .erased?: return .erased
        case .unplayed?: return .unplayed
        case .held?, .plain?, nil:
            if case .failed = state { return .unplayed }
            return .ready
        }
    }
}

struct AskQuestionPhotos: View {
    let photos: [AskConversation.Photo]
    var seen: [String?]?
    @ObservedObject private var outbox = AskBook.shared.outbox
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shown = Array(photos.prefix(4))
        let rows = shown.count <= 2 ? [shown] : [Array(shown.prefix(2)), Array(shown.dropFirst(2))]
        VStack(spacing: 2) {
            ForEach(rows.indices, id: \.self) { row in
                HStack(spacing: 2) {
                    ForEach(rows[row], id: \.self) { photo in
                        tile(photo)
                            .overlay { covered(photos.firstIndex(of: photo)) }
                            .overlay {
                                if photo == shown.last, photos.count > shown.count {
                                    ZStack {
                                        Cockpit.Color.overlay.opacity(0.6)
                                        Text("+\(photos.count - shown.count + 1)").cockpit(.headline).foregroundStyle(Cockpit.Color.text)
                                    }
                                }
                            }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func covered(_ index: Int?) -> some View {
        let hash = index.flatMap { seen?.indices.contains($0) == true ? seen?[$0] : nil }
        ZStack {
            if let hash {
                Cockpit.Color.raised
                    .overlay { AskPicture(hash: hash, fit: .fill) }
                    .transition(.opacity)
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: Cockpit.Duration.fast) : Cockpit.Ease.out(Cockpit.Duration.base), value: hash)
    }

    @ViewBuilder
    private func tile(_ photo: AskConversation.Photo) -> some View {
        switch photo {
        case .own(let id):
            if let image = outbox.thumbnails[id] { own(image) } else { Cockpit.Color.raised }
        case .held(let name):
            AskPicture(hash: name, fit: .fill)
        }
    }

    private func own(_ image: UIImage) -> some View {
        Color.clear.overlay { Image(uiImage: image).resizable().scaledToFill() }.clipped()
    }
}

struct AskPicture: View {
    let hash: String?
    let fit: AskFit
    @Environment(\.displayScale) private var scale
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image, fit == .own {
                Image(uiImage: image).resizable().scaledToFit()
            } else if let image {
                Color.clear.overlay { Image(uiImage: image).resizable().scaledToFill() }.clipped()
            } else if failed {
                VStack(spacing: Cockpit.Space.s2) {
                    Icon(.photo)
                    Text("Can't show this photo").cockpit(.footnote)
                }
                .foregroundStyle(Cockpit.Color.textTertiary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .aspectRatio(fit == .own ? 4 / 3 : nil, contentMode: .fit)
            } else {
                Color.clear.aspectRatio(fit == .own ? 4 / 3 : nil, contentMode: .fit)
            }
        }
        .animation(.easeOut(duration: Cockpit.Duration.fast), value: image != nil)
        .task(id: hash) {
            guard let hash else { return failed = true }
            let width = HomePictures.screen.width
            let box = fit == .own ? CGSize(width: width, height: 320) : CGSize(width: width / 2, height: 160)
            do {
                let want = HomePictures.want(box, scale: scale, fill: fit == .fill)
                image = try await HomePictures.shared.read(hash, want.size, side: want.side)
                failed = image == nil
            } catch is CancellationError {
            } catch {
                failed = true
            }
        }
    }
}
