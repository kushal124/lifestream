import Cockpit
import HomeLink
import LifestreamCaptureCore
import MapKit
import SwiftUI

struct PlaceScreen: View {
    let slug: String
    @EnvironmentObject private var model: PlacesModel
    @StateObject private var read: PageReading<HomeLink.Pages.Place>
    @ObservedObject private var home = HomeToday.shared
    @Environment(\.dismiss) private var dismiss
    @State private var editing: PlacesSnapshot.Place?
    @State private var opening: PhotoViewer.Opening?
    @State private var attempt = PlaceAttempt()

    init(slug: String) {
        self.slug = slug
        _read = StateObject(wrappedValue: PlaceScreen.reading(slug))
    }

    static let newest = 6

    static func reading(_ slug: String) -> PageReading<HomeLink.Pages.Place> {
        PageReading(HomeLink.PageKey(HomeLink.Pages.Place.route, ["slug": slug]))
    }

    var body: some View {
        let place = model.place(id: slug)
        Group {
            if place == nil, !model.reading {
                EmptyState(.place, "This place is not among your places now.")
            } else {
                content(place)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .groundColor(Cockpit.Color.canvas)
        .toolbar {
            if let place {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") { editing = place }
                        .onAppear { if AppRuntime.asked("--ui-test-edit") { editing = place } }
                        .accessibilityIdentifier("place.edit")
                }
            }
        }
        .task(id: model.place(id: slug)) {
            if model.place(id: slug) == nil { await model.refreshBook() }
            guard model.place(id: slug) != nil else { return }
            await read.read()
        }
        .readsAgain(failed: { read.failure }) { await read.read() }
        .sheet(item: $editing, onDismiss: { if model.place(id: slug) == nil { dismiss() } }) { place in
            PlaceNamingSheet(model: model, place: place, landed: { Task { await read.read(settled: true) } }).drawerRest(.large)
        }
        .photoViewer($opening) { AppNavigation.shared.push($0) }
    }

    private func line(_ page: HomeLink.Pages.Place?) -> [PartLine.Part] {
        guard let page else { return [PartLine.Part("Synthetic Town"), PartLine.Part("since Mar 2025")] }
        return PlacesWords.line(page).map { PartLine.Part($0, here: $0 == PlacesWords.here) }
    }

    private func content(_ place: PlacesSnapshot.Place?) -> some View {
        OnePage(read.page?.head.name ?? place?.name ?? "") {
            VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                OneHead(read.page?.head.name ?? place?.name ?? "Synthetic Gym", parts: line(read.page), identifier: "page.title")
                    .reading(read.page == nil)
            }
            .padding(.bottom, -Cockpit.Space.s2)
            VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                if let place {
                    PlaceMap(place: place, places: model.snapshot.places, here: model.here)
                        .frame(height: PlaceMap.height)
                } else {
                    MapBox(height: PlaceMap.height)
                }
                rhythm(place)
            }
            if let place, let ask = read.page?.askHome, place.home == nil {
                QuestionCard("Is this home?", line: PlacesWords.ask(ask), yes: "Yes, it’s home") { home in
                    Task {
                        await model.answerHome(place, home: home, in: attempt)
                        await model.refresh()
                        await read.read(settled: true)
                    }
                }
                .accessibilityIdentifier("place.home")
            }
            if let page = read.page, !page.counting {
                PlaceParts(slug: slug, place: page) { opening = PhotoViewer.Opening(photos: page.photos.first, at: $0) }
                    .onAppear {
                        let blobs = page.photos.first
                        let tall = AppRuntime.asked("--ui-test-viewer-tall")
                            ? blobs.firstIndex { CannedHome.scene(of: $0) == .dusk } : nil
                        if AppRuntime.asked("--ui-test-viewer") || tall != nil, opening == nil, !blobs.isEmpty {
                            opening = PhotoViewer.Opening(photos: blobs, at: tall ?? 0)
                        }
                    }
            } else if read.page == nil, let failure = read.failure {
                ReadLack(failure, lacks: "This place isn't on this iPhone yet.", words: PlacesWords.failure(failure)) {
                    Task { await read.read() }
                }
            } else if let place {
                reading(place)
            }
        }
        .animation(.easeOut(duration: Cockpit.Duration.fast), value: read.page == nil)
    }

    @ViewBuilder private func rhythm(_ place: PlacesSnapshot.Place?) -> some View {
        if let page = read.page, let rhythm = page.rhythm, !page.counting {
            Rhythm(clauses: rhythm.components(separatedBy: " · "))
                .accessibilityIdentifier("place.rhythm")
        } else if read.page?.counting == true || (read.page == nil && read.failure == nil && (place?.days ?? 0) >= 4) {
            Rhythm(clauses: ["85 days here since Mar 2025", "usually Tue and Thu evenings"])
                .reading(true)
        }
    }

    private func reading(_ place: PlacesSnapshot.Place) -> some View {
        let count = min(Self.newest, max(1, place.stays))
        return VStack(alignment: .leading, spacing: 0) {
            Card("Visits", group: true) {
                VStack(spacing: 0) {
                    ForEach(0..<count, id: \.self) { index in
                        VisitRow(day: "Wed 14 Oct", span: "09:12–17:40", length: "8h 28m", faces: false,
                                 separator: index < count - 1, action: {})
                    }
                }
                .reading(true)
            }
            WaitLine()
        }
        .waiting(true)
    }
}

private struct Rhythm: View {
    let clauses: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(clauses.enumerated()), id: \.offset) { index, clause in
                Text(clause)
                    .cockpit(index == 0 ? .headline : .subhead)
                    .foregroundStyle(index == 0 ? Cockpit.Color.text : Cockpit.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(clauses.joined(separator: " · "))
        .accessibilityAddTraits(.isStaticText)
    }
}

private struct PlaceParts: View {
    let slug: String
    let place: HomeLink.Pages.Place
    private let drawn = HomePictures.shared
    let open: (Int) -> Void

    var body: some View {
        if place.photos.total > 0 {
            VStack(alignment: .leading, spacing: Cockpit.Gap.group) {
                let more = place.photos.total > place.photos.first.count
                SectionLabel("Photos", count: more ? nil : place.photos.total,
                             action: more ? place.photos.line.map { "View all " + $0 } : nil,
                             perform: { AppNavigation.shared.push(.placePhotos(slug)) })
                PhotoGrid(place.photos.first.enumerated().map { PageShot(id: $0.offset, hash: $0.element) },
                          label: { "Photo, \($0.id + 1) of \(Words.count(place.photos.total))" }, open: { open($0.id) }) { shot in
                    PlaceShot.Picture(hash: shot.hash)
                        .accessibilityIdentifier("place.photo.\(shot.id)")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("place.photos")
        }
        if !place.people.isEmpty {
            Card("People here", group: true, flat: true) {
                ForEach(place.people, id: \.id) { person in
                    ListRow(person.name, meta: person.line, leading: .monogram(person.name, photo: drawn.face(person.photo)),
                            separator: person.id != place.people.last?.id,
                            action: { AppNavigation.shared.push(.person(person.id)) })
                        .readsFace(person.photo, size: .row)
                        .accessibilityIdentifier("place.person.\(person.id)")
                }
            }
            .environment(\.cockpitRowsFaces, Cockpit.Size.lead)
        }
        if !place.visits.rows.isEmpty {
            let shown = Array(place.visits.rows.prefix(PlaceScreen.newest))
            VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                Card(place.visits.count == 1 ? "Visit" : "Visits", count: place.visits.count == 1 ? nil : place.visits.count, group: true) {
                    let faces = shown.contains { !$0.people.isEmpty }
                    let people = PlaceVisitRow.people(place, drawn)
                    ForEach(Array(shown.enumerated()), id: \.element.key) { index, visit in
                        PlaceVisitRow(visit: visit, open: index == 0 && place.here, people: people, faces: faces,
                                      separator: index < shown.count - 1)
                            .accessibilityIdentifier("place.visit.\(index)")
                    }
                }
                if place.visits.rows.count > shown.count {
                    Button("Show all \(Words.count(place.visits.count))") { AppNavigation.shared.push(.placeVisits(slug)) }
                        .buttonStyle(.cockpit(.secondary, size: .small))
                        .accessibilityIdentifier("place.visits.all")
                }
            }
        }
        if !place.inside.isEmpty {
            Card("Inside", group: true) {
                ForEach(Array(place.inside.enumerated()), id: \.element.slug) { index, inner in
                    ListRow(inner.name, chevron: true, separator: index < place.inside.count - 1,
                            action: { AppNavigation.shared.push(.place(inner.slug)) })
                        .accessibilityIdentifier("place.inside.\(inner.slug)")
                }
            }
        }
    }

    private struct PageShot: Identifiable {
        let id: Int
        let hash: String
    }
}

struct PlaceShot: Identifiable {
    let id: Int
    let photo: HomeLink.PlacePhoto

    static func of(_ photos: [HomeLink.PlacePhoto]) -> [PlaceShot] {
        photos.enumerated().map { PlaceShot(id: $0.offset, photo: $0.element) }
    }

    struct Picture: View {
        let hash: String
        @Environment(\.displayScale) private var scale
        @State private var box: CGSize = .zero
        @State private var image: UIImage?
        @State private var drawn = false

        var body: some View {
            Color.clear
                .overlay {
                    if let image {
                        Image(uiImage: image).resizable().scaledToFill()
                    }
                }
                .onGeometryChange(for: CGSize.self) { $0.size } action: { box = $0 }
                .accessibilityValue(AppRuntime.isUITesting && drawn ? "drawn" : "")
                .task(id: asked) {
                    guard let want = asked.want, let decoded = try? await HomePictures.shared.read(hash, want.size, side: want.side) else { return }
                    image = decoded
                    drawn = true
                }
        }

        private var asked: Asked {
            Asked(hash: hash, want: box == .zero ? nil : HomePictures.want(box, scale: scale, fill: true))
        }

        private struct Asked: Equatable {
            let hash: String
            let want: HomePictures.Want?
        }
    }
}

struct PlaceVisitRow: View {
    let visit: HomeLink.Pages.PlaceVisit
    let open: Bool
    let people: [String: FaceStack.Face]
    let faces: Bool
    let separator: Bool

    var body: some View {
        VisitRow(day: PlacesWords.title(visit), span: PlacesWords.span(visit, open: open), length: PlacesWords.length(visit, open: open),
                 here: open, people: visit.people.map { people[$0] ?? FaceStack.Face(nil) }, faces: faces, separator: separator,
                 action: { Self.open(visit) })
    }

    static func people(_ place: HomeLink.Pages.Place, _ faces: Pictures<UIImage>) -> [String: FaceStack.Face] {
        Dictionary(place.people.map { ($0.id, FaceStack.Face($0.name, photo: faces.face($0.photo))) }) { first, _ in first }
    }

    static func open(_ visit: HomeLink.Pages.PlaceVisit) {
        AppNavigation.shared.push(.day(visit.day, focus: visit.focus))
    }
}

struct PlaceVisitsScreen: View {
    let slug: String
    @StateObject private var read: PageReading<HomeLink.Pages.Place>
    private let drawn = HomePictures.shared

    init(slug: String) {
        self.slug = slug
        _read = StateObject(wrappedValue: PlaceScreen.reading(slug))
    }

    var body: some View {
        ScrollView {
            if let place = read.page, !place.counting {
                let people = PlaceVisitRow.people(place, drawn)
                let faces = place.visits.rows.contains { !$0.people.isEmpty }
                Card("Visits", count: place.visits.count, group: true) {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(place.visits.rows.enumerated()), id: \.element.key) { index, visit in
                            PlaceVisitRow(visit: visit, open: index == 0 && place.here, people: people, faces: faces,
                                          separator: index < place.visits.rows.count - 1)
                                .accessibilityIdentifier("place.visit.\(index)")
                        }
                    }
                }
                .padding(Cockpit.Space.s4)
            } else if let failure = read.failure, failure != .unpaired {
                ReadLack(failure, lacks: "Its visits aren't on this iPhone yet.",
                            words: PlacesWords.failure(failure)) { Task { await read.read() } }
                    .padding(Cockpit.Space.s4)
            } else {
                Loading(size: .page)
            }
        }
        .groundColor(Cockpit.Color.canvas)
        .navigationTitle(read.page?.head.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .task { await read.read() }
        .readsAgain(failed: { read.failure }) { await read.read() }
        .background {
            ForEach(read.page?.people ?? [], id: \.id) { person in
                Color.clear.readsFace(person.photo, size: .sm)
            }
        }
    }
}

struct PlacePhotosScreen: View {
    let slug: String
    @StateObject private var read: PageReading<HomeLink.Pages.Place>
    @StateObject private var photos: PlacePhotosModel
    @State private var opening: PhotoViewer.Opening?

    init(slug: String) {
        self.slug = slug
        _read = StateObject(wrappedValue: PlaceScreen.reading(slug))
        _photos = StateObject(wrappedValue: PlacePhotosModel(slug: slug))
    }

    private struct Blank: Identifiable {
        let id: Int
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Cockpit.Gap.group) {
                SectionLabel("Photos", count: read.page?.photos.total)
                if photos.reading {
                    PhotoGrid((0..<9).map(Blank.init), columns: 3, label: { _ in "Photo" }, open: { _ in }) { _ in Color.clear }
                        .reading(true)
                } else {
                    let shots = PlaceShot.of(photos.photos)
                    PhotoGrid(shots, columns: 3, label: { PlacesWords.photo($0.photo) },
                              open: { opening = PhotoViewer.Opening(photos: shots.map(\.photo.blob), at: $0.id) }) { shot in
                        PlaceShot.Picture(hash: shot.photo.blob)
                            .accessibilityIdentifier("place.photo.\(shot.id)")
                            .onAppear { if shot.id >= shots.count - 6 { Task { await photos.more() } } }
                    }
                }
                if let failure = photos.failure {
                    ReadLack(failure, lacks: "Its photos aren't on this iPhone yet.",
                                words: PlacesWords.failure(failure)) {
                        Task { await photos.photos.isEmpty ? photos.read() : photos.more() }
                    }
                }
            }
            .padding(Cockpit.Space.s4)
        }
        .groundColor(Cockpit.Color.canvas)
        .navigationTitle(read.page?.head.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .task { await read.read() }
        .task { await photos.read() }
        .readsAgain(failed: { photos.failure }) {
            await photos.photos.isEmpty ? photos.read() : photos.more()
        }
        .photoViewer($opening) { AppNavigation.shared.push($0) }
    }
}

private struct PlaceMap: View {
    let place: PlacesSnapshot.Place
    let places: [PlacesSnapshot.Place]
    let here: Here?

    static let height: CGFloat = 220

    var body: some View {
        let span = max(place.radiusMeters * 2.2, 200)
        PlacesMap(marks: marks(within: 3 * span),
                  focus: PlacesMap.Focus(id: place.circles.flatMap { [$0.centre.latitude, $0.centre.longitude, $0.radiusMeters] },
                                         points: Self.edges(place), span: span)) { mark in
            if case .place(let slug, _, _, _) = mark.kind, slug != place.id { AppNavigation.shared.push(.place(slug)) }
        }
        .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Map of \(place.name)")
        .accessibilityIdentifier("place.map")
    }

    private func marks(within metres: Double) -> [PlacesMap.Mark] {
        let near = { (point: PlaceCoordinate) in place.distance(to: point) < metres }
        var marks = places.filter { other in other.id != place.id && other.circles.contains { near($0.centre) } }
            .flatMap { PlacesMap.Mark.places($0) }
        marks += PlacesMap.Mark.places(place, named: false, reach: true)
        if let here, near(here.centre) { marks.append(.here(here)) }
        return marks
    }

    private static func edges(_ place: PlacesSnapshot.Place) -> [PlaceCoordinate] {
        place.circles.flatMap { circle in
            let north = circle.radiusMeters / PlaceCoordinate.metresPerDegreeOfLatitude
            let east = north / max(cos(circle.centre.latitude * .pi / 180), 0.01)
            let (latitude, longitude) = (circle.centre.latitude, circle.centre.longitude)
            return [circle.centre,
                    PlaceCoordinate(latitude: latitude + north, longitude: longitude), PlaceCoordinate(latitude: latitude - north, longitude: longitude),
                    PlaceCoordinate(latitude: latitude, longitude: longitude + east), PlaceCoordinate(latitude: latitude, longitude: longitude - east)]
        }
    }
}
