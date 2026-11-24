import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit

struct PersonEdit: View {
    @ObservedObject var model: PersonModel
    @ObservedObject private var products = ProductsBook.shared
    @ObservedObject private var home = HomeToday.shared
    @State private var card: PersonCard
    @State private var acts = SheetActs()
    @State private var discarding = false
    @State private var confirmingHide = false
    @State private var birthdayOpen = false
    @State private var namesOpen = AppRuntime.asked("--ui-test-also-called")
    @State private var typed = ""
    @State private var finds: (words: String, found: [PersonCard.Added]) = ("", [])
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize

    private enum Field: Hashable {
        case name, full, relationship, work
    }

    init(model: PersonModel, page: HomeLink.Pages.Person, id: String) {
        self.model = model
        var card = PersonCard(page, id: id)
        if AppRuntime.asked("--ui-test-split"), let first = page.edit.joined.first { card.split(first) }
        _card = State(initialValue: card)
    }

    var body: some View {
        NavigationStack {
            List {
                Section { head.padding(.bottom, 5).editRow(top: 0, bottom: 0) }
                    .listSectionSpacing(Cockpit.Gap.section - 11)
                Section { fields }
                Section {
                    theirs
                } header: {
                    EditLabel("Numbers and emails")
                        .accessibilityIdentifier("person.edit.handles")
                }
                if !card.joined.isEmpty {
                    Section {
                        joinedIn
                    } header: {
                        EditLabel("Joined in")
                    }
                }
                if !card.isYou {
                    Section {
                        notAPerson
                        hide
                    }
                }
            }
            .editList()
            .scrollDismissesKeyboard(.interactively)
            .navigationDestination(isPresented: $namesOpen) { AlsoCalledList(card: $card) }
            .cockpitSheet()
            .barBand()
            .navigationTitle(card.isYou ? "Edit" : "Edit person")
            .navigationBarTitleDisplayMode(.inline)
            .sheetEditBar(SheetEdit(opened: PersonCard(card.page, id: card.id), now: card, ready: !model.acting, identifier: "person.edit",
                                    acts: acts, cancel: cancel, keep: save))
            .confirmationDialog("Discard changes?", isPresented: $discarding, titleVisibility: .visible) {
                Button("Discard Changes", role: .destructive) { dismiss() }
                Button("Keep Editing", role: .cancel) {}
            }
        }
        .tint(Cockpit.Color.text)
        .background(DismissAttempt { if card.changed, !acts.running { discarding = true } })
        .accessibilityIdentifier("person.edit")
        .onChange(of: focus) { _, field in if field != nil, birthdayOpen { withAnimation { birthdayOpen = false } } }
        .onChange(of: birthdayOpen) { _, open in if open { focus = nil } }
        .task(id: typed) { await find(typed) }
    }


    private var head: some View {
        let named = card.named || PersonCard.trimmed(card.fields.name) ?? PersonCard.trimmed(card.fields.full) != nil
        return VStack(spacing: Cockpit.Space.s3) {
            HeadFace(name: named ? card.shownName : nil, photo: (model.page ?? card.page).head.photo, held: true, model: model,
                     photos: model.photos, pushes: true)
        }
        .frame(maxWidth: .infinity)
    }


    @ViewBuilder private var fields: some View {
        Group {
            field("Name", \.name, .name, placeholder: card.isYou ? "What Lifestream calls you" : "What you call them", source: card.page.edit.nameFrom,
                  sourced: card.fields.name == card.opened.name, next: .full)
                .ruled()
            field("Full name", \.full, .full, placeholder: card.isYou ? "Your full name" : "Their full name",
                  source: card.fill.map(EditWords.fullSource), sourced: card.fullFilled, next: card.isYou ? .work : .relationship)
                .ruled()
            if !card.isYou {
                field("Relationship", \.relationship, .relationship, placeholder: "Friend from college", words: false, next: .work)
                    .ruled()
            }
            field("Work", \.work, .work, placeholder: card.isYou ? "What you do" : "What they do", source: card.workFill.map(EditWords.cardSource),
                  sourced: card.workFilled, next: nil)
                .ruled()
            DateRow("Birthday", day: birthday, empty: "Add birthday", open: $birthdayOpen, start: Self.today)
                .ruled()
            ForEach(card.guesses, id: \.id) { guess in
                let day = PersonCard.birthday(of: guess.value).map { DateRow.Day(month: $0.month, day: $0.day, year: $0.year).words }
                NameRow("\(day ?? guess.value)?", line: EditWords.guessSource(guess), lead: .key("Suggested"),
                        end: .add(card.ticked(guess)) { card.toggle(guess) }, label: "Birthday \(day ?? guess.value)?, \(EditWords.guessSource(guess))") {
                    card.toggle(guess)
                }
                    .accessibilityIdentifier("person.edit.guess.\(guess.id)")
                    .ruled()
            }
            FieldRow("Also called", value: card.alsoCalled.map(\.name).joined(separator: ", "), empty: "Add a name") {
                focus = nil
                namesOpen = true
            }
            .accessibilityIdentifier("person.edit.also")
            .ruled(false)
        }
        .cardRow()
    }

    private func field(_ label: String, _ path: WritableKeyPath<PersonCard.Fields, String>, _ which: Field, placeholder: String,
                       source: String? = nil, sourced: Bool = true, words: Bool = true, next: Field?) -> some View {
        FieldRow(label, text: Binding(get: { card.fields[keyPath: path] }, set: { card.fields[keyPath: path] = $0 }),
                 placeholder: placeholder, source: source, sourced: sourced, focus: focused(which), capitalizesWords: words)
            .submitLabel(next == nil ? .done : .next)
            .onSubmit { focus = next }
            .accessibilityIdentifier("person.edit.field.\(which)")
    }

    private func focused(_ field: Field) -> FocusState<Bool>.Binding {
        switch field {
        case .name: $focusName
        case .full: $focusFull
        case .relationship: $focusRelationship
        case .work: $focusWork
        }
    }

    @FocusState private var focusName: Bool
    @FocusState private var focusFull: Bool
    @FocusState private var focusRelationship: Bool
    @FocusState private var focusWork: Bool

    private var focus: Field? {
        get { focusName ? .name : focusFull ? .full : focusRelationship ? .relationship : focusWork ? .work : nil }
        nonmutating set {
            focusName = newValue == .name
            focusFull = newValue == .full
            focusRelationship = newValue == .relationship
            focusWork = newValue == .work
        }
    }

    private static var today: DateRow.Day {
        let parts = Calendar(identifier: .gregorian).dateComponents([.month, .day], from: AppClock.now)
        return DateRow.Day(month: parts.month ?? 1, day: parts.day ?? 1)
    }

    private var birthday: Binding<DateRow.Day?> {
        Binding(get: { card.birthday.map { DateRow.Day(month: $0.month, day: $0.day, year: $0.year) } },
                set: { card.birthday = $0.map { PersonCard.Birthday(month: $0.month, day: $0.day, year: $0.year) } })
    }


    @ViewBuilder private var notAPerson: some View {
        if !card.suspicions.isEmpty {
            ForEach(Array(card.suspicions.enumerated()), id: \.element.id) { index, suspicion in
                let words = EditWords.suspicion(suspicion)
                NameRow(words.label + "?", line: words.why, lead: .key("Suggested"), end: .add(card.ticked(suspicion)) { card.toggle(suspicion) },
                        label: "\(words.label)?, \(words.why)") {
                    card.toggle(suspicion)
                }
                .accessibilityIdentifier("person.edit.suspicion.\(suspicion.id)")
                .ruled()
                .cardRow()
            }
        } else if let said = card.said {
            let whose = EditWords.whose(card)
            HStack(spacing: Cockpit.Space.s3) {
                CardChip(EditWords.kind(said), kind: .tag) { card.said = nil }
                    .accessibilityLabel("\(EditWords.kind(said)), \(whose.lowercased())")
                    .accessibilityIdentifier("person.edit.said")
                Text(whose)
                    .cockpit(.subhead)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .lineLimit(1)
                    .accessibilityHidden(true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Cockpit.Space.s4)
            .frame(minHeight: 52)
            .ruled()
            .cardRow()
        } else {
            MenuRow("Mark as not a person", selection: Binding(get: { card.said }, set: { card.said = $0 }),
                    options: EditWords.kinds.map { .init(Optional($0.value), $0.words) }, prompt: "Mark as not a person", flush: .whole)
                .accessibilityIdentifier("person.edit.kind")
                .padding(.horizontal, Cockpit.Space.s4)
                .frame(minHeight: 52)
                .ruled()
                .cardRow()
        }
    }


    @ViewBuilder private var theirs: some View {
        ForEach(card.handles.filter(\.own) + card.handles.filter { !$0.own }, id: \.id) { handle in
            let words = EditWords.handle(handle)
            NameRow(words.value, line: EditWords.handleSource(handle) ?? "", lead: .key(words.key),
                    end: handle.own ? .fixed : .remove("Remove") { withAnimation { card.remove(handle) } },
                    label: [words.key, words.value, EditWords.handleSource(handle)].compactMap { $0 }.joined(separator: ", ")) {}
                .accessibilityIdentifier("person.edit.handle.\(handle.id)")
                .removable(handle.own ? nil : "Remove") { card.remove(handle) }
        }
        ForEach(card.profiles, id: \.self) { profile in
            let words = EditWords.profile(profile, line: "")
            NameRow(words.name, line: "", lead: .key(EditWords.network(profile.network)), end: .remove("Remove") { withAnimation { card.remove(profile) } },
                    label: EditWords.network(profile.network) + ", " + words.name) {}
                .accessibilityIdentifier("person.edit.profile.\(PersonCard.key(profile))")
                .removable { card.remove(profile) }
        }
        ForEach(card.offered, id: \.id) { suggestion in
            let words = EditWords.offered(suggestion, of: card)
            NameRow(words.name, line: words.line, lead: .key(words.key), end: .add(card.ticked(suggestion)) { card.toggle(suggestion) },
                    label: [words.key, words.name, words.line].joined(separator: ", ")) {
                card.toggle(suggestion)
            }
            .accessibilityIdentifier("person.edit.offered.\(suggestion.id)")
            .ruled()
            .cardRow()
        }
        ForEach(card.added) { added in
            let words = EditWords.added(added)
            NameRow(words.name, line: "", lead: .key(words.key), end: .add(true) { withAnimation { card.drop(added) } },
                    label: words.key + ", " + words.name) {
                withAnimation { card.drop(added) }
            }
            .accessibilityIdentifier("person.edit.added.\(added.id)")
            .ruled()
            .cardRow()
        }
        AddRow("Add a number, email or link", text: $typed, field: true, keyed: true, add: addFirst)
            .accessibilityIdentifier("person.edit.add")
            .ruled(!offering.isEmpty)
            .cardRow()
        ForEach(offering) { find in
            let words = EditWords.found(find, today: home.today)
            NameRow(words.name, line: words.line, lead: words.lead, end: .tick(false) { add(find) }) { add(find) }
                .accessibilityIdentifier("person.edit.find.\(find.id)")
                .ruled(find.id != offering.last?.id, edge: NameRow.cardEdge)
                .cardRow()
        }
    }


    private var joinedIn: some View {
        ForEach(card.joined, id: \.id) { joined in
            NameRow(joined.name, line: EditWords.brought(joined), lead: .face(joined.name, photo: HomePictures.shared.face(joined.photo)),
                    end: .remove("Split off") { withAnimation { card.split(joined) } }) {}
                .accessibilityIdentifier("person.edit.joined.\(joined.id)")
                .removable("Split off", ruled: joined.id != card.joined.last?.id, edge: NameRow.cardEdge) { card.split(joined) }
        }
    }


    private var hide: some View {
        let hidden = card.hidden
        return Button {
            if card.changed { confirmingHide = true } else { hideNow() }
        } label: {
            HStack(spacing: Cockpit.Space.s3) {
                Text(hidden ? "Show in People" : "Hide from People")
                    .cockpit(.body)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .cockpitLines(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if acts.running("hide") { Spinner() }
            }
            .padding(.horizontal, Cockpit.Space.s4)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.acting)
        .accessibilityIdentifier("person.edit.hide")
        .confirmationDialog(hidden ? "Show in People?" : "Hide from People?", isPresented: $confirmingHide, titleVisibility: .visible) {
            Button(hidden ? "Show and Discard Changes" : "Hide and Discard Changes", role: .destructive, action: hideNow)
            Button("Keep Editing", role: .cancel) {}
        } message: {
            Text("Your other changes aren't saved.")
        }
        .cardRow()
    }


    private func cancel() {
        if card.changed { discarding = true } else { dismiss() }
    }

    private func save() async throws -> SheetEdit.Kept {
        let confirm = card.answer()
        focus = nil
        switch await model.save(confirm, words: EditWords.saved(card)) {
        case .saved:
            return .close
        case .failed(let said):
            throw SheetEdit.Failed(InPlaceLine.Said(said))
        case .reread(let words):
            if let page = model.page { card = PersonCard(page, id: model.target, keeping: card) }
            throw SheetEdit.Failed(.refused(words))
        }
    }

    private func hideNow() {
        let hidden = card.hidden
        var confirm = HomeLink.Confirm(id: card.id)
        confirm.hidden = !hidden
        focus = nil
        Task {
            await acts.run("hide") {
                switch await model.save(confirm, words: hidden ? "Shown" : "Hidden") {
                case .saved: return .close
                case .failed(let said): throw SheetEdit.Failed(InPlaceLine.Said(said))
                case .reread(let words): throw SheetEdit.Failed(.refused(words))
                }
            }
        }
    }


    private func find(_ typed: String) async {
        let words = Self.words(typed)
        guard !words.isEmpty else { return finds = ("", []) }
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        let found = try? await model.find(words)
        guard !Task.isCancelled else { return }
        finds = (words, (found?.profiles ?? []).map { .profile(PersonCard.profile($0)) } + (found?.rows ?? []).map(PersonCard.Added.person))
    }

    private var offering: [PersonCard.Added] {
        finds.words == Self.words(typed) ? finds.found.filter { !card.added.contains($0) } : []
    }

    private static func words(_ typed: String) -> String {
        typed.trimmingCharacters(in: .whitespaces)
    }

    private func add(_ find: PersonCard.Added) {
        withAnimation {
            card.add(find)
            typed = ""
        }
    }

    private func addFirst() {
        if let first = offering.first { add(first) }
    }
}

private struct WholePoints: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let size = subviews[0].sizeThatFits(proposal)
        return CGSize(width: size.width, height: size.height.rounded(.up))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews[0].place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}

private extension View {
    func editRow(top: CGFloat, bottom: CGFloat) -> some View {
        listRowInsets(EdgeInsets(top: top, leading: 0, bottom: bottom, trailing: 0))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    func cardRow() -> some View {
        environment(\.cockpitRowInCard, true)
            .listRowInsets(EdgeInsets())
            .listRowBackground(Cockpit.Color.raised)
            .listRowSeparator(.hidden)
    }

    func ruled(_ on: Bool = true, edge: CGFloat = Cockpit.Space.s4) -> some View {
        WholePoints { frame(minHeight: 52) }
            .overlay(alignment: .bottom) {
                if on {
                    Rectangle()
                        .fill(Cockpit.Color.rule)
                        .frame(height: Cockpit.pixelRule)
                        .padding(.leading, edge)
                        .padding(.trailing, Cockpit.Space.s4)
                }
            }
    }

    @ViewBuilder func removable(_ word: String? = "Remove", ruled: Bool = true, edge: CGFloat = Cockpit.Space.s4,
                                _ remove: @escaping () -> Void) -> some View {
        let row = self.ruled(ruled, edge: edge).cardRow()
        if let word {
            row.swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button(word, role: .destructive) { withAnimation { remove() } }
            }
        } else {
            row
        }
    }

    func editList() -> some View {
        listStyle(.insetGrouped)
            .listSectionSpacing(Cockpit.Gap.section)
            .contentMargins(.horizontal, Cockpit.Gap.sheet, for: .scrollContent)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 0)
            .groundColor(Cockpit.Color.surface)
    }
}

private struct EditLabel: View {
    let words: String

    init(_ words: String) {
        self.words = words
    }

    var body: some View {
        SectionLabel(words).textCase(nil).listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: Cockpit.Space.s2, trailing: 0))
    }
}

private struct AlsoCalledList: View {
    @Binding var card: PersonCard
    @State private var typed = ""

    var body: some View {
        List {
            Section {
                ForEach(card.alsoCalled, id: \.name) { also in
                    NameRow(also.name, line: also.from, lead: .icon(.person), end: .remove("Remove") { withAnimation { card.removeName(also) } }) {}
                        .accessibilityIdentifier("person.edit.also.\(also.name)")
                        .removable(edge: NameRow.cardEdge) { card.removeName(also) }
                }
                AddRow("Add a name", text: $typed, field: true, add: add)
                    .disabled(!card.namesRoom)
                    .accessibilityIdentifier("person.edit.also.add")
                    .ruled(false)
                    .cardRow()
            } footer: {
                if !card.namesRoom {
                    Text("A person has at most \(PersonCard.namesAtMost) other names.")
                        .cockpit(.subhead)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .padding(.top, Cockpit.Space.s2)
                        .listRowInsets(EdgeInsets())
                }
            }
        }
        .editList()
        .navigationTitle("Also called")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("person.edit.alsoCalled")
    }

    private func add() {
        withAnimation {
            if card.addName(typed) { typed = "" }
        }
    }
}

private struct DismissAttempt: UIViewControllerRepresentable {
    let attempted: () -> Void

    func makeUIViewController(context: Context) -> Hearing { Hearing() }

    func updateUIViewController(_ hearing: Hearing, context: Context) {
        hearing.attempted = attempted
    }

    final class Hearing: UIViewController, UIAdaptivePresentationControllerDelegate {
        var attempted: () -> Void = {}
        nonisolated(unsafe) private weak var original: UIAdaptivePresentationControllerDelegate?

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            var sheet: UIViewController = self
            while let parent = sheet.parent { sheet = parent }
            guard let presentation = sheet.presentationController, presentation.delegate !== self else { return }
            original = presentation.delegate
            presentation.delegate = self
        }

        func presentationControllerDidAttemptToDismiss(_ presentation: UIPresentationController) {
            original?.presentationControllerDidAttemptToDismiss?(presentation)
            attempted()
        }

        nonisolated override func responds(to selector: Selector!) -> Bool {
            super.responds(to: selector) || original?.responds(to: selector) == true
        }

        nonisolated override func forwardingTarget(for selector: Selector!) -> Any? {
            original?.responds(to: selector) == true ? original : super.forwardingTarget(for: selector)
        }
    }
}

@MainActor
enum EditWords {
    static let kinds: [(value: String, words: String, icon: Cockpit.Icon)] = [
        ("ai", "AI", .ai), ("business", "A business", .workMac), ("bot", "An automated sender", .codingAgent),
    ]

    static func kind(_ value: String) -> String {
        kinds.first { $0.value == value }?.words ?? value
    }

    static func whose(_ card: PersonCard) -> String {
        card.judged ? "Lifestream thinks so" : "You said so"
    }

    static let businessSigns: [(reason: String, why: String)] = [
        ("whatsapp", "Listed as a business on WhatsApp"), ("named", "Named like a business you hear from"),
        ("relay", "Mail signed by several people"), ("cards", "A company, no person\u{2019}s name"),
    ]

    @MainActor static func fullSource(_ suggestion: PersonCard.Suggestion) -> String {
        let seen = suggestion.reasons.map(\.reason).filter { $0 != "mail" && suggestion.reason($0) > 0 }.sorted().map(PeopleWords.network)
        return (seen + [counted(suggestion.reason("mail"), "mail")].compactMap { $0 }).joined(separator: Words.dot)
    }

    static func cardSource(_ suggestion: PersonCard.Suggestion) -> String {
        suggestion.reason("cards") > 1 ? Words.count(suggestion.reason("cards"), "contact card") : "Contact card"
    }

    static func guessSource(_ suggestion: PersonCard.Suggestion) -> String {
        if suggestion.reason("wished") > 0 { return "From your messages" }
        return suggestion.reason("cards") > 1 ? "From " + Words.count(suggestion.reason("cards"), "contact card") : "From a contact card"
    }

    static func suspicion(_ suggestion: PersonCard.Suggestion) -> (label: String, why: String, icon: Cockpit.Icon) {
        if suggestion.value == "ai" {
            let replies = suggestion.reason("replies"), quick = suggestion.reason("quick")
            let share = Int((100 * Double(quick) / Double(max(1, replies))).rounded())
            return ("AI", "Replies within 20\u{00A0}s\(Words.dot)\(share)% of \(Words.count(replies)) replies", .ai)
        }
        let kind = kinds.first { $0.value == suggestion.value }
        let sign = businessSigns.first { suggestion.reason($0.reason) > 0 }
        return (kind?.words ?? suggestion.value, sign?.why ?? businessSigns[3].why, kind?.icon ?? .workMac)
    }

    @MainActor static func handle(_ handle: PersonCard.Handle) -> (key: String, value: String) {
        let hidden = handle.words == "Hidden number"
        return switch handle.kind {
        case .phone: ("Phone", PeopleWords.dialled(handle.words))
        case .email: ("Email", handle.words)
        case .jid: (PeopleWords.network("whatsapp"), hidden ? "Number hidden" : PeopleWords.dialled(handle.words))
        default: (handle.network.map(PeopleWords.network) ?? "Account", hidden ? "Number hidden" : handle.words)
        }
    }

    static func handleSource(_ handle: PersonCard.Handle) -> String? {
        guard let from = handle.from, from != "You added" else { return nil }
        return from.hasPrefix("Your ") ? from : "From " + from
    }

    @MainActor static func network(_ network: String) -> String {
        PeopleDetails.networkName(network) ?? PeopleWords.network(network)
    }

    static func profile(_ profile: PersonCard.Profile, line: String) -> (name: String, line: String, icon: Cockpit.Icon) {
        (PeopleDetails.profileWords(profile, path: true), line, Cockpit.Icon(rawValue: profile.network == "site" ? "web" : profile.network) ?? .link)
    }

    @MainActor static func offered(_ suggestion: PersonCard.Suggestion, of card: PersonCard) -> (key: String, name: String, line: String) {
        let value = suggestion.value
        if suggestion.kind == .profile, let profile = PersonCard.profile(of: value) {
            let words = self.profile(profile, line: "")
            return (network(profile.network), words.name, cardSource(suggestion))
        }
        if suggestion.kind == .same {
            let name = suggestion.other?.name ?? "Another record"
            let face = suggestion.other?.face == true
            if card.isYou, suggestion.reason("named") > 0, face {
                return ("Face", name, "Same person?" + Words.dot + "Both named \(name)")
            }
            if face {
                return ("Face", name, "A face you named" + Words.dot + "Same person?")
            }
            let theirs = card.page.edit.fullName ?? card.fill?.value ?? card.page.head.name
            let why = suggestion.reason("linked") > 0 ? "Your cards share a number or email"
                : suggestion.reason("named") > 0 ? "Both named \(theirs)" : "Seen by the name \(name)"
            return ("Same as", name, why)
        }
        let address = value.firstIndex(of: ":").map { String(value[value.index(after: $0)...]) } ?? value
        let mails = suggestion.reason("mails_from") + suggestion.reason("mails_to")
        let email = value.hasPrefix("email:")
        return (email ? "Email" : "Phone", email ? address : PeopleWords.dialled(address),
                [card.isYou ? "Mail in your name" : "Mail in their name", counted(mails, "mail")].compactMap { $0 }.joined(separator: Words.dot))
    }

    @MainActor static func added(_ added: PersonCard.Added) -> (key: String, name: String) {
        switch added {
        case .profile(let profile):
            return (network(profile.network), self.profile(profile, line: "").name)
        case .person(let row):
            let what = row.id.hasPrefix("email:") ? "Email" : row.id.hasPrefix("phone:") || row.id.hasPrefix("jid:") ? "Phone" : row.face ? "Face" : "Same as"
            return (what, what == "Phone" ? PeopleWords.dialled(row.name) : row.name)
        }
    }

    @MainActor static func found(_ find: PersonCard.Added, today: String, now: Date = AppClock.now) -> (name: String, line: String, lead: NameRow.Lead) {
        switch find {
        case .profile(let profile):
            let words = self.profile(profile, line: network(profile.network) + Words.dot + "A profile")
            return (words.name, words.line, .icon(words.icon))
        case .person(let row):
            return (row.name, PeopleListing.meta(row, today: today, now: now) ?? "",
                    .face(row.named ? row.name : nil, photo: HomePictures.shared.face(row.photo)))
        }
    }

    static func brought(_ joined: PersonCard.Joined) -> String {
        let numbers = joined.handles.filter { $0.hasPrefix("phone:") || $0.hasPrefix("jid:") }.count
        let emails = joined.handles.filter { $0.hasPrefix("email:") }.count
        let others = joined.handles.count - numbers - emails
        let things = [one(numbers, "number"), one(emails, "email"), one(others, "account")].compactMap { $0 }
        let what = things.isEmpty ? "Their faces" : list(things).prefix(1).uppercased() + list(things).dropFirst()
        return joined.with.isEmpty ? what : what + Words.dot + "with " + list(joined.with)
    }

    static func saved(_ card: PersonCard) -> String {
        let split = card.splitOff.map(\.name)
        return split.isEmpty ? "Saved" : list(split) + " split off"
    }

    private static func one(_ count: Int, _ noun: String) -> String? {
        count == 0 ? nil : count == 1 ? (noun.first.map { "aeiou".contains($0) } == true ? "an " : "a ") + noun : Words.count(count, noun)
    }

    private static func counted(_ count: Int, _ noun: String) -> String? {
        count > 0 ? Words.count(count, noun) : nil
    }

    private static func list(_ words: [String]) -> String {
        words.count < 2 ? words.joined() : words.dropLast().joined(separator: ", ") + " and " + (words.last ?? "")
    }
}
