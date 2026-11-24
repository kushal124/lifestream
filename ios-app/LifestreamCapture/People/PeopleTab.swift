import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

@MainActor
final class PeopleTabModel: ObservableObject {
    static let shared = PeopleTabModel()

    enum Listing: Hashable {
        case people, groups, organise
    }

    @Published var listing: Listing = .people
    @Published var quietOpen = false
    var top: String?
    let list = PageReading<HomeLink.Pages.People>(HomeLink.PageKey(HomeLink.Pages.People.route))

    func showQuietGroups() {
        listing = .groups
        quietOpen = true
        top = nil
        AppNavigation.shared.openRoot(of: .people)
    }

    func forget() {
        list.forget()
        listing = .people
        quietOpen = false
        top = nil
    }
}

struct PeopleTab: View {
    @ObservedObject private var model = PeopleTabModel.shared
    @ObservedObject private var list = PeopleTabModel.shared.list
    @ObservedObject private var home = HomeToday.shared
    @State private var query = ""
    @State private var found: PeopleListing.Found?
    @State private var headShown = true
    @State private var searchFromTop = false
    @State private var onScreen = OnScreen()
    @Environment(\.scenePhase) private var scenePhase

    private static let top = "people.top"

    var body: some View {
        let listing = list.page.map(PeopleListing.init)
        ScrollViewReader { scroll in
            ScrollView {
                VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                    VStack(alignment: .leading) {
                        head.id(Self.top)
                            .onScrollVisibilityChange(threshold: 0.01) { headShown = $0 }
                    }
                    .scrollTargetLayout()
                    LazyVStack(alignment: .leading, spacing: Cockpit.Space.s8) {
                        content(listing)
                    }
                }
                .padding(.horizontal, Cockpit.Space.s5)
                .padding(.bottom, Cockpit.Space.s6)
                .animation(.easeOut(duration: Cockpit.Duration.fast), value: listing == nil)
            }
            .scrollPosition(id: listed ? $model.top : .constant(nil), anchor: .top)
            .accessibilityIdentifier("people.list")
            .tabRoot("People")
            .onChange(of: typed.isEmpty) { _, empty in
                guard !empty, found == nil else { return }
                searchFromTop = headShown
                if headShown { model.top = Self.top }
            }
            .onChange(of: found == nil) { _, none in
                if !none || searchFromTop { scroll.scrollTo(Self.top, anchor: .top) }
            }
        }
        .scrollDismissesKeyboard(.immediately)
        .groundColor(Cockpit.Color.canvas)
        .refreshable {
            await list.read()
            Interaction.refresh.begin()
            Interaction.refresh.endAtCommit()
        }
        .tracked(onScreen)
        .task { await list.read() }
        .task { await ProductsBook.shared.need() }
        .readsAgain(failed: { list.failure }) { await list.read() }
        .task(id: Search(typed: typed, position: list.page?.position)) {
            guard !typed.isEmpty, let listing = list.page.map(PeopleListing.init) else {
                found = nil
                return
            }
            let local = listing.found(typed)
            found = local
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled, let atHome = try? await AppRuntime.shared.life.find(typed), !Task.isCancelled else { return }
            found = local.adding(atHome.rows)
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, onScreen.shown else { return }
            Task { await list.read() }
        }
    }

    private var head: some View {
        SearchField(text: $query.timed(.searchKeystroke), placeholder: "Search people")
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .padding(.top, Cockpit.Gap.edge)
    }

    private var listed: Bool { typed.isEmpty || found == nil }

    private struct Search: Equatable {
        let typed: String
        let position: String?
    }

    private var typed: String {
        query.trimmingCharacters(in: .whitespaces)
    }

    @ViewBuilder
    private func content(_ listing: PeopleListing?) -> some View {
        if let listing {
            PageNote(drawn: list.drawn)
            if listing.nobody {
                if let you = listing.page.you { YouRow(you: you) }
                NobodyYet()
            } else if !typed.isEmpty, let found {
                SearchResults(found: found, today: home.today)
                    .environment(\.cockpitRowsBare, true)
            } else {
                Listed(listing: listing, today: home.today, view: $model.listing, quietOpen: $model.quietOpen)
                    .environment(\.cockpitRowsBare, true)
            }
        } else {
            Views("People", options: [
                ViewOption("People", id: PeopleTabModel.Listing.people, reading: list.failure == nil, identifier: "people.view.people"),
                ViewOption("Groups", id: .groups, reading: list.failure == nil, identifier: "people.view.groups"),
            ], selection: $model.listing)
            if let failure = list.failure {
                ReadLack(failure, lacks: "Your people aren't on this iPhone yet.", words: PeopleWords.failure(failure)) {
                    Task { await list.read() }
                }
            } else {
                PeopleGroup.reading
            }
        }
    }
}

private struct Listed: View {
    let listing: PeopleListing
    let today: String
    @Binding var view: PeopleTabModel.Listing
    @Binding var quietOpen: Bool

    var body: some View {
        let page = listing.page
        let shown = view == .organise && page.organise.count == 0 ? .people : view
        Views("People", options: options(shown), selection: $view)
        switch shown {
        case .people:
            if let you = page.you { YouRow(you: you) }
            MostInTouch(most: listing.most)
            PeopleGroup(nil, id: "new", shown: listing.new.map(ShownRow.init))
            ForEach(listing.sections(today: today), id: \.key) { section in
                PeopleGroup(section.heading, id: section.key, shown: ShownRow.of(section.rows, today: today, grouped: true),
                            counting: page.counting)
            }
            PeopleGroup(PeopleListing.aiHeading, id: "ai", shown: ShownRow.of(page.ai, today: today), counting: page.counting)
            OrganiseCard(count: page.organise.count, view: $view)
        case .groups:
            GroupsGroup("Your groups", groups: page.groups.yours, quiet: page.groups.quiet, quietOpen: $quietOpen, today: today)
        case .organise:
            PeopleGroup(page.organise.line, id: "organise", shown: ShownRow.of(listing.organise, today: today), counting: page.counting)
        }
    }

    private func options(_ shown: PeopleTabModel.Listing) -> [ViewOption<PeopleTabModel.Listing>] {
        let page = listing.page
        var options = [ViewOption("People", id: PeopleTabModel.Listing.people, count: page.counts.people, identifier: "people.view.people"),
                       ViewOption("Groups", id: .groups, count: page.counts.groups, identifier: "people.view.groups")]
        if shown == .organise {
            options.append(ViewOption("Organise", id: .organise, count: page.organise.count, identifier: "people.view.organise"))
        }
        return options
    }
}

private struct SearchResults: View {
    let found: PeopleListing.Found
    let today: String

    var body: some View {
        if found.people.isEmpty, found.groups.isEmpty {
            Quiet(PeopleWords.nobodyCalled(found.typed))
                .accessibilityIdentifier("people.search.none")
        }
        PeopleGroup(Words.count(found.people.count) + " found", id: "found", shown: ShownRow.of(found.people, today: today))
        GroupsGroup("Groups", groups: found.groups, today: today)
    }
}

private struct Quiet: View {
    let words: String

    init(_ words: String) {
        self.words = words
    }

    var body: some View {
        Text(words)
            .cockpit(.body)
            .foregroundStyle(Cockpit.Color.textSecondary)
    }
}
