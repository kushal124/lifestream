import Cockpit
import Foundation
import HomeLink
import LifestreamCaptureCore
import SwiftUI

@MainActor
final class PageReading<Page: PageAnswer>: ObservableObject {
    @Published private(set) var key: HomeLink.PageKey
    @Published private(set) var drawn: PageShelf.Drawn<Page>?
    @Published private(set) var failure: LifeReader.Failure?
    private let shelf: () -> PageShelf
    private let revision: () -> Int
    private var following: Task<Void, Never>?
    private var generation = 0

    init(_ key: HomeLink.PageKey, shelf: @escaping () -> PageShelf = { AppRuntime.shared.pages },
         revision: @escaping () -> Int = { AppRuntime.shared.life.revision }) {
        self.key = key
        self.shelf = shelf
        self.revision = revision
    }

    var page: Page? { drawn?.page }

    func read(settled: Bool = false) async {
        following?.cancel()
        generation += 1
        let generation = generation
        let stream = shelf().reading(Page.self, key, settled: settled)
        let task = Task { [weak self] in
            for await each in stream {
                guard let self, !Task.isCancelled, self.generation == generation else { return }
                self.take(each)
            }
        }
        following = task
        await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
    }

    func follow(_ next: HomeLink.PageKey) {
        guard next != key else { return }
        following?.cancel()
        following = nil
        generation += 1
        key = next
    }

    func forget() {
        following?.cancel()
        following = nil
        generation += 1
        drawn = nil
        failure = nil
    }

    private func take(_ each: PageShelf.Drawn<Page>) {
        if let became = each.page?.became, key.became(became) != key { key = key.became(became) }
        drawn = each
        failure = Self.failure(each.state, begun: revision())
    }

    static func failure(_ state: PageShelf.State, begun: Int) -> LifeReader.Failure? {
        switch state {
        case .kept, .fresh: nil
        case .offline: .reach(begun: begun)
        case .missing: .missing
        case .waiting(let line, let until): .busy(line, code: "NOT_NOW", until: until, begun: begun)
        case .refused(let words): .refused(words)
        case .failed(let words): .failed(words)
        }
    }
}

struct PageNote<Page: PageAnswer>: View {
    let drawn: PageShelf.Drawn<Page>?

    var body: some View {
        if let drawn, drawn.page != nil, let words = Self.words(drawn.state, asOf: drawn.asOf) {
            Text(words)
                .cockpit(.footnote)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("page.note")
        }
    }

    static func words(_ state: PageShelf.State, asOf: Date?, now: Date = AppClock.now) -> String? {
        switch state {
        case .kept, .fresh, .missing: nil
        case .offline: asOf.map { "As of " + Words.stamp($0, now: now) }
        case .waiting(let line, _): line
        case .refused(let words), .failed(let words): words
        }
    }
}
