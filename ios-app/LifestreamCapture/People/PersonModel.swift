import Combine
import Foundation
import HomeLink
import LifestreamCaptureCore
import SwiftUI

@MainActor
final class PersonModel: ObservableObject {
    @Published private var said: Said?

    enum Line: Equatable {
        case done(String, act: String?)
        case said(String)
        case unanswered(HomeLink.ActSaid)
    }

    enum Saved: Equatable {
        case saved
        case failed(HomeLink.ActSaid)
        case reread(String)
    }

    private enum Said: Equatable {
        case words(String)
        case undone(String)
    }

    let id: String
    let pages: PageReading<HomeLink.Pages.Person>
    private(set) var readID: String
    private let life: LifeReader
    private let book: PeopleBook
    private(set) lazy var photos = PersonPhotosModel(id: id, life: life)
    private var session = 0
    private var watching: AnyCancellable?

    init(id: String, life: LifeReader = AppRuntime.shared.life, book: PeopleBook = .shared,
         shelf: @escaping () -> PageShelf = { AppRuntime.shared.pages }) {
        self.id = id
        readID = id
        self.life = life
        self.book = book
        pages = PageReading(HomeLink.PageKey(HomeLink.Pages.Person.route, ["id": id]), shelf: shelf, revision: { [life] in life.revision })
        watching = book.objectWillChange.merge(with: pages.objectWillChange).sink { [weak self] _ in self?.objectWillChange.send() }
    }

    var page: HomeLink.Pages.Person? { pages.page }

    var failure: LifeReader.Failure? { pages.failure }

    var target: String { pages.page?.became ?? readID }

    var subject: PeopleBook.Subject { .person(id) }

    var acting: Bool { book.acting(subject) }

    var choosing: String? {
        guard case .photo(_, let square)? = book.inFlight(subject) else { return nil }
        return SHA256Digest.tagged(square)
    }

    var line: Line? {
        if case .unanswered(let said)? = book.pending(subject) { return .unanswered(said) }
        switch said {
        case .words(let words)?: return .said(words)
        case .undone(let words)?: return .done(words, act: book.undoes(subject))
        case nil: break
        }
        guard let newest = book.newest, newest.subject == subject else { return nil }
        return .done(newest.words, act: book.undoes(subject))
    }

    private static var kept: [PersonModel] = []
    private static var held: [String: Weak] = [:]
    private static let keptCount = 20

    private struct Weak {
        weak var model: PersonModel?
    }

    static func of(_ id: String) -> PersonModel {
        let model = held[id]?.model ?? PersonModel(id: id)
        held[id] = Weak(model: model)
        kept.removeAll { $0 === model }
        kept.append(model)
        if kept.count > keptCount {
            kept.removeFirst(kept.count - keptCount)
            held = held.filter { $0.value.model != nil }
        }
        return model
    }

    static func shed() {
        kept = []
        held = held.filter { $0.value.model != nil }
    }

    static func forgetAll() {
        kept = []
        held = [:]
    }

    func read(settled: Bool = false) async {
        await pages.read(settled: settled)
    }

    func find(_ words: String) async throws -> HomeLink.Pages.PeopleFind {
        try await life.find(words, for: target)
    }

    func left() {
        session += 1
        said = nil
    }

    func save(_ confirm: HomeLink.Confirm, words: String) async -> Saved {
        said = nil
        let sent = await book.send(subject, { .people(request: $0, .confirm(confirm)) }, words: words, reading: reading)
        switch sent {
        case .answered(let answer):
            route(answer)
            AccessibilityNotification.Announcement(words).post()
            return .saved
        case .refused(let refusal):
            guard refusal.code == "NOT_OFFERED" || refusal.code == "NOT_JOINED" else { return .failed(.refused(refusal.words)) }
            await read(settled: true)
            return .reread(refusal.code == "NOT_JOINED" ? "Not saved: someone joined in was split off already. Here it is as it stands."
                : refusal.words)
        case .said(let said), .held(let said):
            return .failed(said)
        }
    }

    func choose(_ square: Data) async {
        let hash = SHA256Digest.tagged(square)
        let head = HomePictures.want(.head, scale: 3)
        await HomePictures.shared.keep(hash, head.size, side: head.side, bytes: square)
        Task { await send(square) }
    }

    func again() async {
        guard case .unanswered = line, !acting else { return }
        let page = session
        guard case .refused(let refusal)? = await book.check(subject), page == session else { return }
        said = .words(refusal.words)
    }

    private func send(_ square: Data) async {
        let page = session
        said = nil
        let sent = await book.send(subject, { [target] in .people(request: $0, .photo(id: target, square: square)) }, words: "Photo saved",
                                   reading: reading)
        guard page == session else { return }
        switch sent {
        case .answered(let answer):
            route(answer)
        case .refused(let refusal): said = .words("Lifestream did not take this photo: " + refusal.words)
        case .said(.saving), .said(.unknown): break
        case .said(let said), .held(let said): self.said = .words(Self.sentence(said) + " Your photo wasn't saved.")
        }
    }

    func unreadable() {
        said = .words("This picture can't be opened.")
    }

    func undo() async {
        guard book.undoes(subject) != nil, !acting else { return }
        let page = session
        guard let sent = await book.undo(subject, reading: reading), page == session else { return }
        switch sent {
        case .answered:
            said = nil
            AccessibilityNotification.Announcement("Undone").post()
        case .refused(let refusal): said = .words(refusal.words)
        case .said(.saving), .said(.unknown): said = nil
        case .said(let said), .held(let said): self.said = .undone(Self.sentence(said) + " Nothing was undone.")
        }
    }

    private var reading: @MainActor () async -> Void {
        { [weak self] in await self?.read(settled: true) }
    }

    private func route(_ answer: HomeLink.OwnerAnswer) {
        guard let id = answer.id else { return }
        readID = id
        pages.follow(pages.key.became(id))
    }

    private static func sentence(_ said: HomeLink.ActSaid) -> String {
        let words = PeopleBook.words(said)
        return words.hasSuffix(".") ? words : words + "."
    }
}

typealias PersonPhotosModel = PhotoPages<LifeReader.Failure>

extension PhotoPages where Failure == LifeReader.Failure {
    convenience init(id: String, life: LifeReader = AppRuntime.shared.life) {
        self.init(read: { after, etag in try await life.personPhotos(id: id, after: after, etag: etag) },
                  failed: { $0 as? LifeReader.Failure ?? .refused($0.localizedDescription) })
    }
}
