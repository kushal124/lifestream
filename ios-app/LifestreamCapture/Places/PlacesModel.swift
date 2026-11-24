import Combine
import Foundation
import HomeLink
import LifestreamCaptureCore
import SwiftUI

@MainActor
final class PlacesModel: ObservableObject {
    typealias City = HomeLink.Pages.Places.City
    typealias Row = HomeLink.Pages.PlaceRow
    typealias SpotRow = HomeLink.Pages.SpotRow
    typealias HiddenRow = HomeLink.Pages.HiddenRow

    @Published private(set) var snapshot: PlacesSnapshot = .empty
    @Published private(set) var here: Here?
    @Published private(set) var lastError: String?
    let list: PageReading<HomeLink.Pages.Places>

    static let undoFor: Duration = .seconds(10)

    private let book: PlacesBook
    private let fixes: @Sendable (Date) async -> [PlaceFix]
    private var forwarding: AnyCancellable?

    init(book: PlacesBook, fixes: @escaping @Sendable (Date) async -> [PlaceFix],
         list: PageReading<HomeLink.Pages.Places> = PageReading(HomeLink.PageKey(HomeLink.Pages.Places.route))) {
        self.book = book
        self.fixes = fixes
        self.list = list
        forwarding = list.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
    }

    static func live() -> PlacesModel {
        if AppRuntime.isUITesting {
            return PlacesModel(book: AppRuntime.shared.placesBook, fixes: CannedHome.fixes)
        }
        let store = AppRuntime.shared.captureStore
        return PlacesModel(book: AppRuntime.shared.placesBook, fixes: { since in
            (try? await store.placeFixes(since: since)) ?? []
        })
    }


    func refresh(settled: Bool = false) async {
        async let listed: Void = list.read(settled: settled)
        await book.refresh()
        await reload()
        await listed
    }

    func refreshBook() async {
        await book.refresh()
        await reload()
    }

    var page: HomeLink.Pages.Places? { list.page }
    var cities: [City] { page?.cities ?? [] }
    var rows: [Row] { cities.flatMap { $0.places + $0.once } }
    var spotsToName: [SpotRow] { page?.toName ?? [] }
    var hidden: [HiddenRow] { page?.hidden ?? [] }
    var reading: Bool { page == nil && list.failure == nil }

    var hereSlug: String? {
        guard let here else { return page?.here }
        let circles = rows.flatMap { row in
            ([PlaceCircle(centre: row.centre, radiusMeters: row.radiusM)] + row.also.map(\.circle)).map { KeyedCircle(slug: row.slug, circle: $0) }
        }
        return PlaceTakes.winning(here.centre, among: circles)?.slug
    }

    func city(holding slug: String) -> City? {
        cities.first { city in (city.places + city.once).contains { $0.slug == slug } }
    }

    func reload(now: Date = AppClock.now) async {
        let recent = await fixes(now.addingTimeInterval(-PlaceRules.dwellWindow))
        let read = await book.snapshot
        let dwelling = await Task.detached { Here.dwelling(fixes: recent, now: now) }.value
        if snapshot != read { snapshot = read }
        if here != dwelling { here = dwelling }
    }

    func place(id: String) -> PlacesSnapshot.Place? {
        snapshot.places.first { $0.id == id }
    }

    var toName: [PlacesSnapshot.Spot] {
        snapshot.spots.filter(\.worth)
    }


    enum Saved: Equatable {
        case saved(PlacesSnapshot.Place?)
        case changed
        case failed(HomeLink.ActSaid)

        var place: PlacesSnapshot.Place? {
            if case .saved(let place) = self { place } else { nil }
        }
    }

    @discardableResult
    func save(name: String, centre: PlaceCoordinate, radiusMeters: Double, also: [PlaceCircle]? = nil, ids: [String] = [],
              home: Bool? = nil, editing existing: PlacesSnapshot.Place? = nil, in attempt: PlaceAttempt) async -> Saved {
        guard let content = PlaceContent(name: name, centre: centre, radiusMeters: radiusMeters.rounded(),
                                         also: also ?? existing?.also ?? [], ids: ids, home: existing?.home ?? home)
        else { return .failed(.refused("Not saved: a place needs its name and a circle.")) }
        guard let existing else {
            return await act(.create(name: content.name, Self.circle(content.centre, content.radiusMeters), ids: content.ids, home: content.home),
                             in: attempt)
        }
        let fields = Self.fields(from: existing, to: content)
        guard !fields.isEmpty else { return .saved(existing) }
        return await act(.edit(slug: existing.id, fields), in: attempt)
    }

    struct Naming: Equatable {
        let place: PlacesSnapshot.Place
        let before: PlacesSnapshot.Place?
    }

    func name(_ name: HomeLink.Suggestion, circle: PlaceCircle, home: Bool? = nil, in attempt: PlaceAttempt) async -> Naming? {
        let chosen = name.name.trimmingCharacters(in: .whitespacesAndNewlines)
        lastError = nil
        guard !chosen.isEmpty else { return nil }
        guard let slug = name.slug else {
            return said(await save(name: chosen, centre: circle.centre, radiusMeters: circle.radiusMeters, ids: StayNames.ids(name), home: home,
                                   in: attempt))
                .map { Naming(place: $0, before: nil) }
        }
        if place(id: slug) == nil { await refresh() }
        guard let own = place(id: slug) else {
            lastError = "\(chosen) is no longer one of your places"
            return nil
        }
        guard own.also.count < PlaceContent.alsoMaximum else {
            lastError = "\(own.name) holds \(PlaceContent.alsoMaximum + 1) circles, the most a place holds"
            return nil
        }
        let added = await act(.addCircle(slug: own.id, Self.circle(circle.centre, circle.radiusMeters.rounded())), in: attempt)
        return said(added).map { Naming(place: $0, before: own) }
    }

    func restore(_ before: PlacesSnapshot.Place, in attempt: PlaceAttempt) async {
        guard let now = place(id: before.id) else { return }
        let also = HomeLink.PlaceFields.Change(was: now.also.map(Self.wire), to: before.also.map(Self.wire))
        said(await act(.edit(slug: before.id, HomeLink.PlaceFields(also: also)), in: attempt))
    }

    func answerHome(_ place: PlacesSnapshot.Place, home: Bool, in attempt: PlaceAttempt) async {
        said(await act(.edit(slug: place.id, HomeLink.PlaceFields(home: .init(was: place.home, to: home))), in: attempt))
    }

    func hide(_ centre: PlaceCoordinate, in attempt: PlaceAttempt) async {
        said(await act(.hide(latitude: centre.latitude, longitude: centre.longitude), in: attempt))
    }

    func unhide(key: String, in attempt: PlaceAttempt) async {
        said(await act(.unhide(key: key), in: attempt))
    }

    func remove(_ place: PlacesSnapshot.Place, in attempt: PlaceAttempt) async -> Saved {
        await act(.remove(slug: place.id), in: attempt)
    }

    @discardableResult
    private func said(_ saved: Saved) -> PlacesSnapshot.Place? {
        switch saved {
        case .saved(let place):
            lastError = nil
            return place
        case .changed:
            lastError = PlacesWords.changed
            return nil
        case .failed(let said):
            lastError = PeopleBook.words(said)
            return nil
        }
    }

    @discardableResult
    private func act(_ change: HomeLink.PlaceAct, in attempt: PlaceAttempt) async -> Saved {
        let acted = await attempt.act(change, on: book)
        switch acted {
        case .answered(let answer):
            await reload()
            await list.read(settled: true)
            return .saved(answer.id.flatMap { id in id.hasPrefix("place:") ? place(id: String(id.dropFirst("place:".count))) : nil })
        case .refused(let refusal) where refusal.code == PlacesBook.changed:
            await reload()
            return .changed
        case .refused, .unanswered:
            return .failed(acted.said ?? .notSent)
        }
    }

    private static func circle(_ centre: PlaceCoordinate, _ radius: Double) -> HomeLink.Place.Circle {
        HomeLink.Place.Circle(latitude: centre.latitude, longitude: centre.longitude, radiusM: radius)
    }

    private static func wire(_ circle: PlaceCircle) -> HomeLink.Place.Circle {
        Self.circle(circle.centre, circle.radiusMeters)
    }

    private static func fields(from place: PlacesSnapshot.Place, to content: PlaceContent) -> HomeLink.PlaceFields {
        var fields = HomeLink.PlaceFields()
        if content.name != place.name { fields.name = .init(was: place.name, to: content.name) }
        if content.centre != place.centre || content.radiusMeters != place.radiusMeters {
            fields.circle = .init(was: circle(place.centre, place.radiusMeters), to: circle(content.centre, content.radiusMeters))
        }
        if content.also != place.also { fields.also = .init(was: place.also.map(wire), to: content.also.map(wire)) }
        return fields
    }
}
