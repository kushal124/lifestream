import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct NamingStart: Identifiable {
    let key: String?
    var id: String { key ?? "first" }
}

struct NamingWalk: View {
    @ObservedObject var model: PlacesModel
    let start: NamingStart
    var closed: (Set<String>) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var still: Bool { reduceMotion || AppRuntime.runsStill }
    @State private var queue: [PlacesModel.SpotRow] = []
    @State private var index = 0
    @State private var named: [Named] = []
    @State private var started = AppClock.now
    @State private var last = AppClock.now
    @State private var added: Named?

    struct Named: Equatable {
        let place: PlacesSnapshot.Place
        let spot: String
        let city: String?
        let day: String
        var before: PlacesSnapshot.Place? = nil
    }

    var body: some View {
        ZStack {
            Cockpit.Color.canvas.ignoresSafeArea()
            if index < queue.count {
                let spot = queue[index]
                NamingCard(position: index + 1, of: queue.count, close: { dismiss() }) {
                    ZStack {
                        NamingSpotPage(model: model, spot: spot, added: added.map(undo),
                                       moved: { Task { await moved(spot) } }, next: { next(after: spot, named: $0) })
                            .id(spot.id + " " + spot.key)
                            .transition(still ? .opacity
                                : .asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
                    }
                }
                .transition(.opacity)
            } else if !named.isEmpty {
                finish
                    .transition(.opacity)
            }
        }
        .task {
            guard queue.isEmpty else { return }
            if model.page == nil { await model.list.read() }
            let spots = model.spotsToName
            if let key = start.key {
                queue = spots.filter { $0.key == key } + spots.filter { $0.key != key }
            } else {
                queue = spots
            }
            started = AppClock.now
            index = Self.asked(from: 0, in: queue, still: model.spotsToName)
            if index >= queue.count { dismiss() }
        }
        .onDisappear { closed(Set(named.map(\.spot))) }
    }

    private static func asked(from index: Int, in queue: [PlacesModel.SpotRow], still spots: [PlacesModel.SpotRow]) -> Int {
        let open = Set(spots.map(\.id))
        return queue.indices.dropFirst(index).first { open.contains(queue[$0].id) } ?? queue.count
    }

    private func next(after spot: PlacesModel.SpotRow, named place: Named?) {
        guard index < queue.count, queue[index].id == spot.id else { return }
        if let place {
            named.append(place)
            last = AppClock.now
            if place.before != nil {
                added = place
                Task {
                    try? await Task.sleep(for: PlacesModel.undoFor)
                    if added == place { added = nil }
                }
            }
        }
        let after = index + 1
        withAnimation(still ? nil : .spring(duration: 0.4, bounce: 0.08)) {
            index = Self.asked(from: after, in: queue, still: model.spotsToName)
        }
        if index >= queue.count, named.isEmpty { dismiss() }
    }

    private func moved(_ spot: PlacesModel.SpotRow) async {
        guard index < queue.count, queue[index].id == spot.id else { return }
        await model.refresh(settled: true)
        guard let at = queue.firstIndex(where: { $0.id == spot.id }) else { return }
        if let fresh = model.spotsToName.first(where: { $0.id == spot.id }) {
            if fresh.key != spot.key { queue[at] = fresh }
            return
        }
        guard at == index else { return }
        withAnimation(still ? nil : .spring(duration: 0.4, bounce: 0.08)) {
            index = Self.asked(from: at, in: queue, still: model.spotsToName)
        }
        if index >= queue.count, named.isEmpty { dismiss() }
    }

    private func undo(_ place: Named) -> NamingAdded {
        NamingAdded("Added to " + place.place.name) {
            guard let before = place.before else { return }
            added = nil
            named.removeAll { $0 == place }
            Task { await model.restore(before, in: PlaceAttempt()) }
            if index >= queue.count, named.isEmpty { dismiss() }
        }
    }

    private var finish: some View {
        NamingFinish(count: named.count, line: PlacesWords.finish(took: last.timeIntervalSince(started), cities: named.compactMap(\.city)),
                     named: named.map { NamedPlace(id: $0.place.id, name: $0.place.name, day: $0.day) }, added: added.map(undo),
                     done: { dismiss() }) {
            let lit = Set(named.map(\.place.id))
            let marks = model.snapshot.places.flatMap { place in
                lit.contains(place.id) ? PlacesMap.Mark.places(place, lit: true) : PlacesMap.Mark.places(place, named: false, back: true)
            }
            PlacesMap(marks: marks, focus: PlacesMap.Focus(id: "finish", points: named.map(\.place.centre), span: PlacesMap.Focus.streets),
                      insets: EdgeInsets(top: 44, leading: 0, bottom: 24, trailing: 0))
        }
    }
}

private struct NamingSpotPage: View {
    @ObservedObject var model: PlacesModel
    let spot: PlacesModel.SpotRow
    let added: NamingAdded?
    let moved: () -> Void
    let next: (NamingWalk.Named?) -> Void

    @StateObject private var names = StayNames()
    @StateObject private var haptics = PlaceHaptics()
    @State private var typed = ""
    @State private var home: Bool?
    @State private var failure: String?
    @State private var saving = false
    @State private var attempt = PlaceAttempt()
    @State private var opening: PhotoViewer.Opening?
    @Environment(\.dismiss) private var dismiss
    @State private var circle: CircleEditing
    @StateObject private var edit: PageReading<HomeLink.Pages.PlaceEdit>
    @FocusState private var focused: Bool

    init(model: PlacesModel, spot: PlacesModel.SpotRow, added: NamingAdded?, moved: @escaping () -> Void,
         next: @escaping (NamingWalk.Named?) -> Void) {
        self.model = model
        self.spot = spot
        self.added = added
        self.moved = moved
        self.next = next
        let key = spot.key
        _circle = State(initialValue: CircleEditing([PlaceCircle(centre: spot.centre, radiusMeters: PlaceRules.newPlaceRadiusMeters)], slug: key,
                                                    place: { [weak model] slug in model?.place(id: slug) }, aside: Cockpit.namingCircleAside))
        _edit = StateObject(wrappedValue: PageReading(HomeLink.PageKey(HomeLink.Pages.PlaceEdit.route, ["spot": key])))
    }

    private var shown: [String] { Array(spot.photos.prefix(6)) }
    private var stay: Date? { PlacesWords.date(spot.when) }

    var body: some View {
        NamingPage(witnessed: spot.line, last: spot.when.map { "Last time " + PlacesWords.when($0) },
                   more: max(0, spot.photosTotal - shown.count),
                   takes: circle.line, skip: skip, hide: hide, note: failure ?? names.need?.words, added: added) {
            CircleEdit(editing: circle)
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Map around the place")
                .accessibilityIdentifier("naming.map")
        } reach: {
            CircleReach(editing: circle, identifier: "naming.reach")
        } photos: {
            if !shown.isEmpty {
                PhotoGrid(shown.enumerated().map { Shot(id: $0.offset, hash: $0.element) }, filled: true,
                          label: { _ in "Photo" }, open: { opening = PhotoViewer.Opening(photos: shown, at: $0.id) }) { shot in
                    PlaceShot.Picture(hash: shot.hash)
                        .accessibilityIdentifier("naming.photo.\(shot.id)")
                }
            }
        } names: {
            if let ask = spot.ask {
                NamingHomeQuestion(why: PlacesWords.ask(ask), home: $home) { yes in
                    if yes, typed.trimmingCharacters(in: .whitespaces).isEmpty { typed = "Home" }
                }
            }
            VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                NameField("Type a name", text: $typed, act: "Save", focus: $focused) {
                    pick(StayNames.typed(typed, among: names.names))
                }
                StayNameRows(names: names.names, typed: names.typed, stay: stay ?? AppClock.now, pick: pick, identifier: "naming.name")
            }
        }
        .disabled(saving)
        .scrollDismissesKeyboard(.interactively)
        .task { await edit.read() }
        .onChange(of: edit.page) { _, page in if let page { circle.know(page) } }
        .task {
            names.moved = moved
            await names.read(.spot(key: spot.key, centre: spot.centre))
            names.type(typed)
        }
        .onChange(of: typed) { _, words in names.type(words) }
        .onChange(of: focused) { _, value in if !value { circle.listen() } }
        .photoViewer($opening) { route in
            dismiss()
            AppNavigation.shared.push(route)
        }
    }

    private struct Shot: Identifiable {
        let id: Int
        let hash: String
    }

    private func pick(_ name: HomeLink.Suggestion) {
        guard !name.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !saving else { return }
        saving = true
        focused = false
        haptics.tap()
        Task {
            let naming = await model.name(name, circle: PlaceCircle(centre: circle.centre, radiusMeters: circle.radius), home: home, in: attempt)
            saving = false
            guard let naming else {
                failure = model.lastError
                haptics.error()
                return
            }
            failure = nil
            haptics.success()
            next(NamingWalk.Named(place: naming.place, spot: spot.id, city: spot.city, day: stay.map { Words.shortDate($0) } ?? "",
                                  before: naming.before))
        }
    }

    private func skip() {
        guard !saving else { return }
        haptics.tap()
        next(nil)
    }

    private func hide() {
        guard !saving else { return }
        saving = true
        haptics.tap()
        Task {
            await model.hide(spot.centre, in: attempt)
            saving = false
            next(nil)
        }
    }
}

private struct NamingHomeQuestion: View {
    let why: String
    @Binding var home: Bool?
    let answered: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
            Text("Is this home?")
                .cockpit(.subhead)
                .fontWeight(.medium)
                .foregroundStyle(Cockpit.Color.text)
            if !why.isEmpty {
                Text(why)
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: Cockpit.Space.s3) {
                answer("Yes, it’s home", true)
                answer("No", false)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("naming.home")
    }

    private func answer(_ words: String, _ value: Bool) -> some View {
        Button {
            home = home == value ? nil : value
            if home == value { answered(value) }
        } label: {
            HStack(spacing: 6) {
                if home == value { Icon(.done, size: .sm) }
                Text(words)
            }
        }
        .buttonStyle(.cockpit(home == value ? .primary : .secondary, size: .small))
        .accessibilityAddTraits(home == value ? .isSelected : [])
        .accessibilityIdentifier(value ? "naming.home.yes" : "naming.home.no")
    }
}
