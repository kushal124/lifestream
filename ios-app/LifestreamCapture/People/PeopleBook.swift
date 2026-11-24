import Foundation
import HomeLink
import LifestreamCaptureCore
import os

@MainActor
final class PeopleBook: ObservableObject {
    static let shared = PeopleBook(life: AppRuntime.shared.life,
                                   kept: AppRuntime.shared.root.appendingPathComponent(DisplayCaches.people, isDirectory: true))

    static let firstCheck: Duration = .seconds(1)
    static let lastCheck: Duration = .seconds(30)

    final class Drawn: Sendable {
        let people: HomeLink.People
        let chats: [String: HomeLink.Chat]
        let byID: [String: HomeLink.Person]
        let suggested: [HomeLink.Person]

        init(_ people: HomeLink.People) {
            self.people = people
            chats = Dictionary(people.chats.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
            let all = (people.you.map { [$0] } ?? []) + people.people
            byID = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            let named = people.people.filter { !$0.name.isEmpty }
            suggested = Array(named.sorted { ($0.last30, $0.lastMs ?? 0) > ($1.last30, $1.lastMs ?? 0) }.prefix(SearchModel.tiles))
        }

        nonisolated static func of(_ people: HomeLink.People) async -> Drawn {
            await Task.detached(priority: .userInitiated) { Drawn(people) }.value
        }
    }

    enum Subject: Hashable, Sendable {
        case person(String)
        case chat(String)
    }

    enum State: Equatable {
        case sending
        case unanswered(HomeLink.ActSaid)

        var said: HomeLink.ActSaid {
            switch self {
            case .sending: .saving
            case .unanswered(let said): said
            }
        }
    }

    struct Act {
        let action: HomeLink.OwnerAction
        let subject: Subject
        let words: String
        let reading: @MainActor () async -> Void
        var state: State

        var request: String { action.request }
    }

    enum Sent: Equatable {
        case answered(HomeLink.OwnerAnswer)
        case refused(HomeLink.Refusal)
        case said(HomeLink.ActSaid)
        case held(HomeLink.ActSaid)
    }

    struct Newest: Equatable {
        let subject: Subject
        let act: String
        let words: String
    }

    @Published private(set) var drawn: Drawn?
    @Published private(set) var failure: LifeReader.Failure?
    @Published private(set) var position: HomeLink.Position?
    @Published private(set) var takes = false
    @Published private(set) var acts: [Act] = []
    @Published private(set) var newest: Newest?
    @Published private(set) var sending: Set<String> = []

    private let life: LifeReader
    private let kept: PeopleShelf
    private var unsent: [Subject: HomeLink.OwnerAction] = [:]
    private var answeredList = false
    private var reading: Task<Void, Never>?
    private var again = false
    private var generation = 0
    private let pause: @MainActor (Duration) async -> Void
    private var polling: Task<Void, Never>?

    init(life: LifeReader, kept folder: URL,
         pause: @escaping @MainActor (Duration) async -> Void = { try? await Task.sleep(for: $0) }) {
        self.life = life
        kept = PeopleShelf(folder: folder)
        self.pause = pause
        takes = life.takesPeople
    }

    var people: HomeLink.People? { drawn?.people }

    var chats: [String: HomeLink.Chat] { drawn?.chats ?? [:] }

    func person(_ id: String) -> HomeLink.Person? {
        drawn?.byID[id]
    }

    func need() async {
        if !answeredList { await read() }
    }

    var polls: Bool { polling != nil }

    func pending(_ subject: Subject) -> State? {
        acts.last { $0.subject == subject }?.state
    }

    func inFlight(_ subject: Subject) -> HomeLink.PeopleAct? {
        guard case .people(_, let act)? = acts.last(where: { $0.subject == subject })?.action else { return nil }
        return act
    }

    func acting(_ subject: Subject) -> Bool {
        acts.contains { $0.subject == subject && sending.contains($0.request) }
    }

    func undoes(_ subject: Subject) -> String? {
        guard let newest, newest.subject == subject, acts.isEmpty else { return nil }
        return newest.act
    }

    func send(_ subject: Subject, _ make: (String) -> HomeLink.OwnerAction, words: String,
              reading: @escaping @MainActor () async -> Void = {}) async -> Sent {
        if let pending = acts.last(where: { $0.subject == subject }) {
            guard make(pending.request) == pending.action else { return .held(pending.state.said) }
            return await check(pending.request)
        }
        let request = unsent[subject].flatMap { make($0.request) == $0 ? $0.request : nil } ?? UUID().uuidString
        acts.append(Act(action: make(request), subject: subject, words: words, reading: reading, state: .sending))
        return await check(request)
    }

    func check(_ subject: Subject) async -> Sent? {
        guard let pending = acts.last(where: { $0.subject == subject }) else { return nil }
        return await check(pending.request)
    }

    func undo(_ subject: Subject, reading: @escaping @MainActor () async -> Void = {}) async -> Sent? {
        guard let newest, undoes(subject) == newest.act else { return nil }
        return await send(subject, { .people(request: $0, .undo(act: newest.act)) }, words: "Undone", reading: reading)
    }

    static func words(_ said: HomeLink.ActSaid) -> String {
        switch said {
        case .notSent: ReachWords.notSent + "."
        case .saving: ReachWords.saving
        case .refused(let words), .unknown(let words): words
        }
    }

    private func check(_ request: String) async -> Sent {
        guard let act = acts.first(where: { $0.request == request }) else { return .said(.notSent) }
        guard !sending.contains(request) else { return .held(act.state.said) }
        sending.insert(request)
        let acted = await life.act(act.action)
        if case .answered = acted {
            answeredList = false
            await read()
            await act.reading()
        }
        sending.remove(request)
        return settle(request, acted)
    }

    private func settle(_ request: String, _ acted: HomeLink.Acted) -> Sent {
        guard let index = acts.firstIndex(where: { $0.request == request }) else { return .said(.notSent) }
        let act = acts[index]
        switch acted {
        case .answered(let answer):
            acts.remove(at: index)
            unsent[act.subject] = nil
            if case .people(_, .undo) = act.action {
                newest = nil
            } else {
                newest = answer.act.map { Newest(subject: act.subject, act: $0, words: act.words) }
            }
            return .answered(answer)
        case .refused(let refusal):
            acts.remove(at: index)
            unsent[act.subject] = nil
            return .refused(refusal)
        case .unanswered(let said):
            switch (said, act.state) {
            case (.unknown, .unanswered(.saving)):
                return .said(.saving)
            case (.saving, _), (.unknown, _):
                acts[index].state = .unanswered(said)
                poll()
            case (_, .unanswered(let before)):
                return .said(before)
            case (.notSent, _), (.refused, _):
                acts.remove(at: index)
                unsent[act.subject] = said == .notSent ? act.action : nil
            }
            return .said(said)
        }
    }

    private var due: Bool {
        acts.contains { act in
            if case .unanswered = act.state { return true }
            return false
        }
    }

    private func poll() {
        guard polling == nil, due else { return }
        let pause = pause
        polling = Task { [weak self] in
            var wait = Self.firstCheck
            while !Task.isCancelled {
                await pause(wait)
                guard let self, !Task.isCancelled else { return }
                for act in acts {
                    if case .unanswered = act.state { _ = await check(act.request) }
                }
                guard !Task.isCancelled else { return }
                guard due else {
                    polling = nil
                    return
                }
                wait = min(wait * 2, Self.lastCheck)
            }
        }
    }

    func read() async {
        Task { await ProductsBook.shared.need() }
        again = true
        if reading == nil {
            let generation = generation
            reading = Task {
                while again, self.generation == generation {
                    again = false
                    await load(generation)
                }
                if self.generation == generation { reading = nil }
            }
        }
        await reading?.value
    }

    private func load(_ generation: Int) async {
        if drawn == nil, let held = await kept.people(generation) {
            let drawn = await Drawn.of(held)
            guard self.generation == generation else { return }
            if self.drawn == nil { self.drawn = drawn }
        }
        do {
            let read = try await life.peopleAt()
            let people = read.value
            let drawn = await Drawn.of(people)
            guard self.generation == generation else { return }
            self.drawn = drawn
            position = read.position
            failure = nil
            answeredList = true
            Task { await kept.keep(people, generation) }
        } catch is CancellationError {
        } catch {
            guard self.generation == generation else { return }
            failure = error as? LifeReader.Failure ?? .refused(error.localizedDescription)
        }
        heardTakes()
    }


    func heardTakes() {
        let takes = life.takesPeople
        if self.takes != takes { self.takes = takes }
    }

    func forget() {
        drawn = nil
        position = nil
        failure = nil
        answeredList = false
        acts = []
        unsent = [:]
        newest = nil
        sending = []
        polling?.cancel()
        polling = nil
        generation += 1
        reading?.cancel()
        reading = nil
        Task { [generation] in _ = await kept.at(generation) }
    }
}

private actor PeopleShelf {
    private static let log = Logger(subsystem: "org.lifestreamprotocol.phone", category: "shelf")
    private let folder: URL
    private var held: HomeLink.People?
    private var generation = 0

    init(folder: URL) {
        self.folder = folder
    }

    private var file: URL { folder.appendingPathComponent("people.json") }

    func people(_ generation: Int) -> HomeLink.People? {
        guard at(generation) else { return nil }
        if held == nil, let data = try? Data(contentsOf: file) {
            held = try? JSONDecoder().decode(HomeLink.People.self, from: data)
        }
        return held
    }

    func keep(_ people: HomeLink.People, _ generation: Int) {
        guard at(generation), people != held else { return }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileDurability.excludeFromBackup(folder)
            try JSONEncoder().encode(people).write(to: file, options: FileDurability.unlockedOnly)
            held = people
        } catch {
            Self.log.error("the people were not kept: \(String(describing: error), privacy: .public)")
        }
    }

    func at(_ generation: Int) -> Bool {
        if generation > self.generation {
            try? FileManager.default.removeItem(at: folder)
            held = nil
            self.generation = generation
        }
        return generation == self.generation
    }
}

extension HomeLink.People {
    func id(of handle: String) -> String? {
        people.first { $0.id == handle || $0.handles.contains { $0.id == handle } }?.id
    }
}
