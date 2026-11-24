import Foundation
import HomeLink
import LifestreamCaptureCore

@MainActor
final class DaysModel: ObservableObject {
    static let shared = DaysModel()

    @Published private(set) var listing: DaysListing?
    @Published private(set) var turned = DayReading.Turned(HomeClock.current)
    @Published private(set) var unlisted: LifeReader.Failure?
    private var listGeneration = 0

    private var models: [String: DayModel] = [:]
    private var shownOrder: [String] = []
    var inFront: String?

    private static let held = 10
    private static let pageLimit = 1024

    private init() {
        HomeClock.current.onChange { Task { @MainActor in await DaysModel.shared.clockChanged() } }
    }

    var written: Set<String> { listing?.written ?? [] }
    var pages: [String] { listing?.days ?? [] }
    var totals: [String: Int] { listing?.totals ?? [:] }
    var first: String? { listing?.first }
    var today: String { turned.today }
    var drawnBy: Int { turned.revision }
    var opening: String { listing?.opening ?? today }

    private func clockChanged() async {
        let now = DayReading.Turned(HomeClock.current)
        if now != turned { turned = now }
        await readList()
    }

    func relative(_ day: String) -> String? {
        Words.relativeDay(day, today: today)
    }

    func model(_ day: String) -> DayModel {
        if let model = models[day] { return model }
        let model = DayModel(day: day)
        models[day] = model
        return model
    }

    func read(_ model: DayModel) async {
        await model.readPage()
        shownOrder.removeAll { $0 == model.day }
        guard model.page != nil else { return }
        shownOrder.append(model.day)
        while shownOrder.count > Self.held, let gone = shownOrder.firstIndex(where: { $0 != inFront }) {
            models[shownOrder.remove(at: gone)]?.release()
        }
    }

    func shed() {
        for day in shownOrder where day != inFront { models[day]?.release() }
        shownOrder.removeAll { $0 != inFront }
    }

    func readList(_ shelf: PageShelf = AppRuntime.shared.pages) async {
        listGeneration += 1
        let generation = listGeneration
        let begun = AppRuntime.shared.life.revision
        var answers: [HomeLink.Pages.Days] = []
        var after: String?
        repeat {
            var query = ["limit": String(Self.pageLimit)]
            if let after { query["after"] = after }
            var held: HomeLink.Pages.Days?
            var state = PageShelf.State.missing
            for await drawn in shelf.reading(HomeLink.Pages.Days.self, HomeLink.PageKey(HomeLink.Pages.Days.route, query)) {
                guard generation == listGeneration else { return }
                state = drawn.state
                guard let page = drawn.page else { continue }
                held = page
                listing = DaysListing(answers + [page])
            }
            guard generation == listGeneration else { return }
            guard let held else {
                unlisted = listing == nil ? PageReading<HomeLink.Pages.Days>.failure(state, begun: begun) : nil
                return
            }
            answers.append(held)
            after = held.next
        } while after != nil
        unlisted = nil
    }

    func forget() {
        listGeneration += 1
        listing = nil
        models = [:]
        shownOrder = []
        unlisted = nil
    }
}
