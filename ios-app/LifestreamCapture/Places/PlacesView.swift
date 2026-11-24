import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct PlacesView: View {
    @ObservedObject var model: PlacesModel
    @StateObject private var years = YearPages(PlacesWords.thisYear())
    @ObservedObject private var home = HomeToday.shared
    @ObservedObject private var needs = PhoneNeeds.shared
    @EnvironmentObject private var capture: CaptureAppModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.rootBarFoot) private var foot

    enum Shown: Hashable { case places, cities, trips }

    @State private var shown = Shown.places
    @State private var opened: String?
    @State private var query = ""
    @FocusState private var searching: Bool
    @State private var year = PlacesWords.thisYear()
    @State private var onScreen = OnScreen()
    @State private var rest: SheetRest = {
        AppRuntime.asked("--ui-test-rest-low") ? .low : AppRuntime.asked("--ui-test-rest-high") || AppRuntime.asked("--ui-test-trips") ? .high : .middle
    }()
    @State private var covered: CGFloat = 0
    @State private var focus: PlacesMap.Focus?
    @State private var naming: NamingStart?
    @ScaledMetric(relativeTo: .subheadline) private var legend = MapMarks.legend

    var body: some View {
        GeometryReader { page in
            ZStack(alignment: .top) {
                PlacesMap(marks: marks, focus: focus,
                          insets: EdgeInsets(top: page.safeAreaInsets.top, leading: 0, bottom: covered, trailing: 0), open: open)
                    .ignoresSafeArea()
                    .accessibilityIdentifier("places.map")
                if let foot { foot.cockpitShadow(Cockpit.Shadow.float) }
                MapSheet(rest: $rest, page: Opening(shown: shown, city: opened), bar: page.safeAreaInsets.bottom,
                         onCover: { if rest != .high { covered = $0 } }) {
                    title
                } head: {
                    head
                } content: {
                    content
                        .environment(\.cockpitRowsBare, true)
                }
                .ignoresSafeArea(.container, edges: .bottom)
                .ignoresSafeArea(.keyboard)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("places.list")
            }
        }
        .background(Cockpit.Color.raised)
        .navigationTitle("Places")
        .navigationBarTitleDisplayMode(.inline)
        .floatingControls {
            if model.here != nil {
                Button(action: showHere) {
                    Icon(.location, size: .lg, label: "Where you are").foregroundStyle(Cockpit.Color.text).barSlot()
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("places.here")
            }
            SearchControl()
            StreamsControl(slot: true)
        }
        .fullScreenCover(item: $naming) { start in NamingWalk(model: model, start: start) }
        .tracked(onScreen)
        .task {
            await read()
            if AppRuntime.asked("--ui-test-naming") { naming = NamingStart(key: nil) }
            if AppRuntime.asked("--ui-test-trips") { shown = .trips }
        }
        .readsAgain(failed: { shown == .trips ? years.failure : model.list.failure }) {
            await read()
        }
        .onChange(of: placed, initial: true) { _, placed in
            if placed, focus == nil { refocus() }
        }
        .onChange(of: Opening(shown: shown, city: opened)) { refocus() }
        .onChange(of: shown) { _, view in if view == .trips { Task { await readTrips() } } }
        .onChange(of: searching) { _, focused in if focused { rest = .high } }
        .onChange(of: year) { _, stepped in Task { await years.read(stepped) } }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, onScreen.shown { Task { await read() } }
        }
    }


    @ViewBuilder private var title: some View {
        if let city = openedCity {
            VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                Button { opened = nil } label: {
                    HStack(spacing: 2) {
                        Icon(.back, size: .sm)
                        Text("Cities").cockpit(.subhead)
                    }
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("places.city.back")
                VStack(alignment: .leading, spacing: 2) {
                    Text(city.title)
                        .cockpit(.title1)
                        .foregroundStyle(Cockpit.Color.text)
                        .lineLimit(1)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("places.city.title")
                    Text(PlacesWords.head(city))
                        .cockpit(.subhead)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .accessibilityIdentifier("places.city.line")
                }
            }
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .capCentre, spacing: Cockpit.Space.s3) {
                    placesTitle
                    Spacer(minLength: 0)
                    invitation
                }
                VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                    placesTitle
                    invitation
                }
            }
        }
    }

    private var placesTitle: some View {
        RootTitle("Places").capCentre(.display)
    }

    @ViewBuilder private var invitation: some View {
        let left = model.reading ? 0 : model.spotsToName.count
        if left > 0 {
            InvitationPill(count: left, words: "to name", label: "\(Words.count(left)) \(left == 1 ? "place" : "places") to name",
                           action: { naming = NamingStart(key: nil) }) {
                SpotRing(diameter: legend)
            }
            .accessibilityIdentifier("places.invite")
        }
    }

    @ViewBuilder private var head: some View {
        if !placedNothing {
            VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                SearchField(text: $query.timed(.searchKeystroke),
                            placeholder: openedCity.map { "Search in \($0.title)" } ?? "Search places", focus: $searching)
                if openedCity == nil {
                    let trips = years.page?.trips.count
                    Views("Places", options: [
                        ViewOption("Places", id: Shown.places, count: model.rows.count, reading: model.reading,
                                   identifier: "places.view.places"),
                        ViewOption("Cities", id: Shown.cities, count: model.cities.count, reading: model.reading,
                                   identifier: "places.view.cities"),
                        ViewOption("Trips", id: Shown.trips, count: trips,
                                   reading: shown == .trips && years.loading,
                                   identifier: "places.view.trips"),
                    ], selection: $shown)
                }
            }
        }
    }


    private var content: some View {
        LazyVStack(alignment: .leading, spacing: Cockpit.Space.s6) {
            if !onTrips { PageNote(drawn: model.list.drawn) }
            if !typed.isEmpty {
                found
            } else if let city = openedCity {
                group(city, heading: false)
            } else {
                switch shown {
                case .places: list
                case .cities: cities
                case .trips:
                    TripsView(year: $year, pages: years) {
                        Task { await years.read(year) }
                    }
                }
            }
        }
        .animation(.easeOut(duration: Cockpit.Duration.fast), value: model.reading)
    }

    private var onTrips: Bool { typed.isEmpty && openedCity == nil && shown == .trips }

    @ViewBuilder private var list: some View {
        if model.snapshot.unpaired {
            InPlaceLine("Lifestream is not taking this phone's edits.")
                .accessibilityIdentifier("places.unpaired")
        }
        if let error = model.lastError {
            InPlaceLine(error)
        }
        if model.page == nil, let failure = model.list.failure, let words = PlacesWords.failure(failure) {
            InPlaceLine(words)
        }
        if model.reading {
            PlaceRow.reading
        } else if model.page != nil {
            if model.rows.isEmpty && model.spotsToName.isEmpty {
                NothingYet(location: location) { Task { await needs.permissions.ask("location", start: capture.start) } }
            }
            ForEach(model.cities, id: \.key) { city in
                group(city, heading: true).padding(.top, city.key == model.cities.first?.key ? 0 : -Cockpit.Space.s4)
            }
            if !model.hidden.isEmpty {
                SectionLabel("Hidden", count: model.hidden.count, open: { AppNavigation.shared.push(.hiddenSpots) })
                    .padding(.top, -11)
                    .accessibilityIdentifier("places.hidden")
            }
            if !model.rows.isEmpty { GeographyCredit() }
        }
    }

    private func group(_ city: PlacesModel.City, heading: Bool) -> some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s6) {
            Card(heading ? city.title : nil, count: heading ? PlacesWords.count(city) : nil,
                 open: heading ? { self.open(city: city.title) } : nil, group: true, flat: true) {
                rows(city.places, last: true)
                if city.places.isEmpty { rows(city.once, last: true) }
            }
            .environment(\.cockpitHeadStrong, heading)
            if !city.places.isEmpty, !city.once.isEmpty {
                SectionLabel("Visited once", count: city.once.count, open: { AppNavigation.shared.push(.placesOnce(city.title)) })
                    .padding(.top, -11)
                    .padding(.bottom, 18)
                    .accessibilityIdentifier("places.once.\(city.title)")
            }
        }
    }

    private func rows(_ places: [PlacesModel.Row], last: Bool) -> some View {
        let now = AppClock.now, here = model.hereSlug, counting = model.page?.counting ?? false
        return LazyVStack(spacing: 0) {
            ForEach(places, id: \.slug) { place in
                PlaceRow(place: place, line: PlacesWords.line(place, now: now), counting: counting,
                         here: here == place.slug, separator: !(last && place.slug == places.last?.slug))
            }
        }
    }

    @ViewBuilder private var cities: some View {
        if model.reading {
            PlaceRow.reading
        } else if !model.cities.isEmpty {
            Card(group: true, flat: true) {
                ForEach(model.cities, id: \.key) { city in
                    ListRow(city.title, here: holdsHere(city), meta: PlacesWords.line(city), mono: true, chevron: true,
                            separator: city.key != model.cities.last?.key, action: { open(city: city.title) })
                        .accessibilityIdentifier("places.city.\(city.title)")
                }
            }
            GeographyCredit()
        }
    }

    @ViewBuilder private var found: some View {
        let places = (openedCity.map { $0.places + $0.once } ?? model.rows).filter { PageFilter.shows($0.find, typed: typed) }
        if places.isEmpty {
            NoneLine("No place called \u{201C}\(typed)\u{201D}.")
        } else {
            Card("\(Words.count(places.count)) found", group: true, flat: true) {
                rows(places, last: true)
            }
        }
    }


    private var marks: [PlacesMap.Mark] {
        var marks: [PlacesMap.Mark] = []
        if shown == .cities, opened == nil {
            for city in model.cities {
                marks.append(.init(id: "city:" + city.title, kind: .city(city.title, places: PlacesWords.count(city), strong: holdsHere(city),
                                                                          faded: false),
                                   centre: city.centre, name: city.title))
            }
        } else {
            marks += model.rows.flatMap { PlacesMap.Mark.places($0) }
            marks += model.spotsToName.map { PlacesMap.Mark.spot($0) }
        }
        if let here = model.here { marks.append(.here(here)) }
        return marks
    }

    private func open(_ mark: PlacesMap.Mark) {
        switch mark.kind {
        case .place(let slug, _, _, _): AppNavigation.shared.push(.place(slug))
        case .spot(let id, _): if let spot = model.spotsToName.first(where: { $0.id == id }) { naming = NamingStart(key: spot.key) }
        case .city(let name, _, _, _): open(city: name)
        case .here: if let slug = model.hereSlug { AppNavigation.shared.push(.place(slug)) }
        case .stay: break
        }
    }

    private func open(city: String) {
        shown = .cities
        opened = city
        query = ""
        if rest == .low { rest = .middle }
    }

    private struct Opening: Hashable {
        let shown: Shown
        let city: String?
    }

    private func refocus() {
        if let city = openedCity {
            focusOn((city.places + city.once).map(\.centre) + model.spotsToName.filter { $0.city == city.title }.map(\.centre),
                    span: PlacesMap.Focus.streets)
        } else if shown == .cities {
            focusOn(model.cities.map(\.centre), span: PlacesMap.Focus.city)
        } else if shown == .places, let page = model.page?.frame {
            focusOn([PlaceCoordinate(latitude: page.north, longitude: page.west), PlaceCoordinate(latitude: page.south, longitude: page.east)],
                    span: PlacesMap.Focus.streets)
        }
    }

    private func focusOn(_ points: [PlaceCoordinate], span: Double) {
        guard !points.isEmpty else { return }
        focus = PlacesMap.Focus(id: UUID(), points: points, span: span)
    }

    private func showHere() {
        guard let here = model.here else { return }
        focus = PlacesMap.Focus(id: UUID(), points: [here.centre], span: PlacesMap.Focus.streets)
    }


    private var typed: String { query.trimmingCharacters(in: .whitespaces) }

    private var openedCity: PlacesModel.City? {
        opened.flatMap { name in model.cities.first { $0.title == name } }
    }

    private func holdsHere(_ city: PlacesModel.City) -> Bool {
        guard let slug = model.hereSlug else { return false }
        return (city.places + city.once).contains { $0.slug == slug }
    }

    private var placed: Bool {
        !model.reading && !(model.rows.isEmpty && model.spotsToName.isEmpty)
    }

    private var placedNothing: Bool {
        !model.reading && model.page != nil && model.rows.isEmpty && model.spotsToName.isEmpty
    }

    private var location: Bool {
        needs.permissions.rows.first { $0.id == "location" }?.state == .granted
    }


    private func read() async {
        async let places: Void = model.refresh()
        if shown == .trips { await readTrips() }
        await places
    }

    private func readTrips() async {
        await years.read(year)
    }
}

struct PlacesOnceScreen: View {
    let city: String
    @EnvironmentObject private var model: PlacesModel

    var body: some View {
        let places = model.cities.first { $0.title == city }?.once ?? []
        let now = AppClock.now
        OnePage("Visited once", inBar: true) {
            VStack(spacing: Cockpit.Space.s3) {
                ForEach(places, id: \.slug) { place in
                    HiddenSpotCard(id: place.slug, known: place.name, hidden: visited(place, now: now), unhide: nil,
                                   open: { AppNavigation.shared.push(.place(place.slug)) }) {
                        PlacesMap(marks: marks(place), focus: PlacesMap.Focus(id: place.slug, points: [place.centre], span: 260), moves: false)
                            .accessibilityHidden(true)
                    }
                    .accessibilityIdentifier("places.row.\(place.slug)")
                }
            }
        }
    }

    private func visited(_ place: PlacesModel.Row, now: Date) -> String {
        guard case .at(let ms)? = place.when else { return PlacesWords.line(place, now: now) }
        return "Visited " + Words.shortDate(Words.date(ms: Int64(ms)), now: now)
    }

    private func marks(_ place: PlacesModel.Row) -> [PlacesMap.Mark] {
        model.rows.filter { $0.distance(to: place.centre) < 600 }
            .flatMap { PlacesMap.Mark.places($0, named: $0.slug != place.slug, reach: $0.slug == place.slug, back: $0.slug != place.slug) }
    }
}

private struct PlaceRow: View {
    let place: PlacesModel.Row
    let line: String
    let counting: Bool
    let here: Bool
    let separator: Bool

    var body: some View {
        ListRow(place.name, here: here, meta: counting ? "2h 12m today" : line, metaReading: counting, mono: true, separator: separator,
                action: { AppNavigation.shared.push(.place(place.slug)) })
            .accessibilityIdentifier("places.row.\(place.slug)")
    }

    static var reading: some View {
        let names = ["Home", "The Office", "Synthetic Gym", "Corner Cafe", "Park Club", "The Station"]
        let lines = ["2h 12m today", "Thursday", "Yesterday", "45m today", "12 Oct", "Monday"]
        return VStack(alignment: .leading, spacing: 0) {
            Card("Synthetic Town", group: true, flat: true) {
                ForEach(names.indices, id: \.self) { index in
                    ListRow(names[index], meta: lines[index], mono: true, separator: index < names.count - 1, action: {})
                }
            }
            WaitLine()
        }
        .reading(true)
    }
}

private struct NothingYet: View {
    let location: Bool
    let allow: () -> Void

    var body: some View {
        if location {
            EmptyState(.places, "A spot shows here after three days there, or an hour there in one day.")
        } else {
            Offer(icon: .location, name: "Location", line: "Where you go, from this iPhone.", button: "Allow", primary: true,
                  identifier: "places.allow", action: allow)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("places.empty")
        }
    }
}
