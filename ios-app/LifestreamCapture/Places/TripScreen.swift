import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct TripScreen: View {
    let first: String

    @StateObject private var read: PageReading<HomeLink.Pages.Year>
    @ObservedObject private var home = HomeToday.shared

    init(first: String) {
        self.first = first
        _read = StateObject(wrappedValue: YearPages.reading(Int(first.prefix(4)) ?? PlacesWords.thisYear()))
    }

    var body: some View {
        let page = read.page
        let trip = page?.trips.first { $0.range.first == first }
        OnePage(trip?.title ?? "") {
            if let page, let trip {
                content(trip, in: page)
            } else if page != nil {
                EmptyState(.places, "This trip is not among your trips now.")
            } else if let failure = read.failure {
                ReadLack(failure, lacks: "This trip isn't on this iPhone yet.", words: PlacesWords.failure(failure)) { Task { await read.read() } }
            } else {
                reading
            }
        }
        .animation(.easeOut(duration: Cockpit.Duration.fast), value: page == nil)
        .accessibilityIdentifier("trip.screen")
        .task { await read.read() }
        .readsAgain(failed: { read.failure }) { await read.read() }
    }

    @ViewBuilder private func content(_ trip: HomeLink.Pages.Year.Trip, in year: HomeLink.Pages.Year) -> some View {
        OneHead(trip.title, line: PlacesWords.range(trip.range) + " " + trip.range.first.prefix(4) + Words.dot + trip.nights
                    + (trip.guessed ? Words.dot + "a guess from the days around" : ""),
                identifier: "page.title") {
            OneTile(icon: .transit)
        }
        let route = TripsMap.route(trip, in: year)
        if !route.isEmpty {
            TripsMap(cities: route, route: true, label: "The route of \(trip.title)")
                .frame(height: 240)
        }
        let today = home.today
        Card("Days", group: true) {
            ForEach(Array(trip.days.enumerated()), id: \.element.day) { index, day in
                ListRow(day.line, value: Words.rowDay(day.day, today: today),
                        chevron: true, separator: index < trip.days.count - 1,
                        action: { AppNavigation.shared.push(.day(day.day)) })
                    .accessibilityIdentifier("trip.day.\(day.day)")
            }
        }
    }

    @ViewBuilder private var reading: some View {
        OneHead("Synthetic City", line: "10–12 Oct 2026 · 3 nights", identifier: "page.title") {
            OneTile(icon: .transit)
        }
        .reading(true)
        MapBox(height: 240)
        VStack(alignment: .leading, spacing: 0) {
            Card("Days", group: true) {
                VStack(spacing: 0) {
                    ForEach(0..<6, id: \.self) { index in
                        ListRow("Synthetic City", meta: "The Station · Corner Cafe", value: "Sat 12 Sep", chevron: true,
                                separator: index < 5, action: {})
                    }
                }
                .reading(true)
            }
            WaitLine()
        }
        .waiting(true)
    }
}
