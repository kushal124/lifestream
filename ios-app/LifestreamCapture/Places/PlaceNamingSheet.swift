import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit

struct PlaceNamingSheet: View {
    @ObservedObject var model: PlacesModel
    let landed: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var name: String
    @State private var editing: CircleEditing
    @StateObject private var reading: PageReading<HomeLink.Pages.PlaceEdit>
    @StateObject private var haptics = PlaceHaptics()
    @State private var acts = SheetActs()
    @State private var attempt = PlaceAttempt()
    @State private var opened: PlacesSnapshot.Place
    @State private var confirmingRemove = false
    @FocusState private var focused: Bool

    init(model: PlacesModel, place: PlacesSnapshot.Place, landed: @escaping () -> Void) {
        self.model = model
        self.landed = landed
        _opened = State(initialValue: place)
        _name = State(initialValue: place.name)
        _editing = State(initialValue: Self.editing(place, model: model))
        _reading = StateObject(wrappedValue: PageReading(HomeLink.PageKey(HomeLink.Pages.PlaceEdit.route, ["slug": place.id])))
    }

    private static func editing(_ place: PlacesSnapshot.Place, model: PlacesModel) -> CircleEditing {
        CircleEditing(place.circles, slug: place.id, place: { [weak model] slug in model?.place(id: slug) }, aside: CircleSheetHead<EmptyView>.aside)
    }

    private var edit: SheetEdit {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        return SheetEdit(opened: Edited(name: opened.name, circles: false), now: Edited(name: trimmed, circles: editing.changed),
                         ready: !trimmed.isEmpty, identifier: "places.sheet", acts: acts, cancel: { haptics.tap(); dismiss() }, keep: save)
    }

    private struct Edited: Equatable {
        let name: String
        let circles: Bool
    }
    var body: some View {
        NavigationStack {
            ScrollViewReader { scroll in
                ScrollView {
                    CircleSheetHead(editing: editing, identifier: "places.sheet") {
                        nameField
                        circles { add(scroll) }
                        remove
                    }
                    .id(Self.top)
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .groundColor(Cockpit.Color.surface)
            .cockpitSheet()
            .barBand()
            .navigationTitle("Edit place")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .sheetEditBar(edit)
        }
        .tint(Cockpit.Color.text)
        .onChange(of: focused) { _, value in if value { haptics.tap() } else { editing.listen() } }
        .task { await reading.read() }
        .onChange(of: reading.page) { _, page in if let page { editing.know(page) } }
        .onAppear { haptics.prepare() }
    }


    private static let top = "top"

    private func circles(add: @escaping () -> Void) -> some View {
        let rows = editing.rows, several = rows.count > 1
        return Card(several ? "Circles" : "Circle", count: several ? rows.count : nil, group: true) {
            ForEach(rows) { row in
                let beside = several && (row.selected || rows.first { $0.number == row.number + 1 }?.selected == true)
                CircleRow(number: several ? row.number : nil, reach: PlaceReach.words(row.circle.radiusMeters), line: row.line,
                          selected: row.selected, separator: !beside, identifier: "places.sheet.circle.\(row.number - 1)", select: { editing.select(id: row.id) },
                          remove: several ? { editing.remove(id: row.id) } : nil) { EmptyView() }
            }
            AddCircleRow(full: editing.canAdd ? nil : "\(CircleEditing.most) circles, the most a place holds",
                         identifier: "places.sheet.circle.add", alone: !several, add: add)
        }
        .animation(reduceMotion ? nil : .easeOut(duration: Cockpit.Duration.base), value: rows.map { [$0.id, $0.selected ? 1 : 0] })
    }

    private func add(_ scroll: ScrollViewProxy) {
        focused = false
        withAnimation(reduceMotion ? nil : .easeOut(duration: Cockpit.Duration.base)) { scroll.scrollTo(Self.top, anchor: .top) }
        editing.add()
    }


    private var nameField: some View {
        Card(group: true) {
            FieldRow("Name", text: $name, focus: $focused)
                .environment(\.cockpitRowInCard, true)
                .submitLabel(.done)
                .onSubmit { if acts.canKeep(edit) { Task { await acts.run(SheetActs.keep, save) } } }
                .accessibilityIdentifier("places.sheet.name")
        }
    }


    private var remove: some View {
        Card(group: true) {
            ListRow("Remove this place", separator: false, action: { haptics.warning(); confirmingRemove = true })
                .environment(\.cockpitRowWarns, true)
                .accessibilityIdentifier("places.sheet.remove")
                .confirmationDialog("Remove \(opened.name)?", isPresented: $confirmingRemove, titleVisibility: .visible) {
                    Button("Remove", role: .destructive) {
                        Task {
                            await acts.run("remove") {
                                try kept(await model.remove(opened, in: attempt))
                                return .close
                            }
                        }
                    }
                } message: {
                    Text("Its stays read as an unnamed spot again, on every device and in every day. Lifestream keeps its history.")
                }
        }
    }


    private func save() async throws -> SheetEdit.Kept {
        focused = false
        haptics.tap()
        let all = editing.standing.map { PlaceCircle(centre: $0.centre, radiusMeters: $0.radiusMeters.rounded()) }
        try kept(await model.save(name: name, centre: all[0].centre, radiusMeters: all[0].radiusMeters, also: Array(all.dropFirst()),
                                  ids: opened.ids, editing: opened, in: attempt))
        return .close
    }

    private func kept(_ saved: PlacesModel.Saved) throws {
        switch saved {
        case .saved:
            haptics.success()
            landed()
        case .changed:
            haptics.error()
            if let standing = model.place(id: opened.id) {
                opened = standing
                name = standing.name
                editing = Self.editing(standing, model: model)
                if let page = reading.page { editing.know(page) }
                Task { await reading.read() }
            }
            throw SheetEdit.Failed(.refused(PlacesWords.changed))
        case .failed(let said):
            haptics.error()
            throw SheetEdit.Failed(InPlaceLine.Said(said))
        }
    }
}
