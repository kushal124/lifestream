import Foundation
import HomeLink
import LifestreamCaptureCore

@MainActor
final class DayModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case shown
        case unwritten
        case failed(LifeReader.Failure)
    }

    let day: String
    @Published private(set) var phase = Phase.loading
    @Published private(set) var page: HomeLink.Pages.Day?
    @Published private(set) var drawn: PageShelf.Drawn<HomeLink.Pages.Day>?
    @Published private(set) var failure: LifeReader.Failure?
    @Published var toggled: Set<String> = []
    @Published var lit: String?
    var offset: CGFloat = 0
    @Published private(set) var naming: Set<String> = []
    @Published private(set) var namingTurns = 0

    private var pageReads = 0

    static let namingQuickReads = 24
    static let namingQuick: Duration = .seconds(5)
    static let namingSlow: Duration = .seconds(60)
    static let renderingAgain: Duration = .seconds(5)

    init(day: String) {
        self.day = day
    }

    var rendering: Bool { page?.state == .rendering }

    func isOpen(_ key: String, folded: Bool) -> Bool {
        folded == toggled.contains(key)
    }

    static func folded(_ key: String, in page: HomeLink.Pages.Day) -> Bool {
        if key == DayReading.also { return page.also?.folded ?? false }
        if let chapter = page.chapters.first(where: { $0.key == key }) { return chapter.folded }
        return page.chapters.lazy.flatMap(\.blocks).first { $0.key == key }?.folded ?? false
    }

    func open(_ keys: Set<String>, in page: HomeLink.Pages.Day) {
        for key in keys {
            if Self.folded(key, in: page) { toggled.insert(key) } else { toggled.remove(key) }
        }
    }

    func named(_ spots: Set<String>) {
        guard !spots.isEmpty else { return }
        naming.formUnion(spots)
        namingTurns += 1
    }

    static func namingWait(after reads: Int) -> Duration {
        reads < namingQuickReads ? namingQuick : namingSlow
    }

    func readPage(_ shelf: PageShelf = AppRuntime.shared.pages) async {
        pageReads += 1
        let this = pageReads
        let begun = AppRuntime.shared.life.revision
        var state = PageShelf.State.missing
        for await each in shelf.reading(HomeLink.Pages.Day.self, DayReading.key(day)) {
            guard this == pageReads else { return }
            state = each.state
            drawn = each
            guard let answer = each.page else { continue }
            if answer != page { page = answer }
            settle(answer)
        }
        guard this == pageReads else { return }
        failure = PageReading<HomeLink.Pages.Day>.failure(state, begun: begun)
        guard page == nil, let failure else { return }
        phase = .failed(failure)
    }

    private func settle(_ answer: HomeLink.Pages.Day) {
        let next: Phase = switch answer.state {
        case .ready: .shown
        case .empty: .unwritten
        case .rendering, .unknown: .loading
        }
        if next != phase { phase = next }
        if !naming.isEmpty, !DayReading.waits(on: naming, in: answer) { naming = [] }
    }

    func release() {
        pageReads += 1
        page = nil
        drawn = nil
        failure = nil
        phase = .loading
    }
}
