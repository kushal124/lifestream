import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct AskConversations: View {
    @ObservedObject private var book = AskBook.shared
    @ObservedObject private var home = HomeToday.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var search = ""
    @FocusState private var searching: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Cockpit.Space.s3 - 2) {
                SearchField(text: $search, placeholder: "Search", focus: $searching)
                Button { AppNavigation.shared.newChat() } label: {
                    Circle().fill(Cockpit.Color.raised)
                        .overlay { Icon(.compose, size: .md).foregroundStyle(Cockpit.Color.text) }
                        .frame(width: Cockpit.Size.target, height: Cockpit.Size.target)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("New conversation")
                .accessibilityIdentifier("ask.drawer.new")
            }
            .padding(.horizontal, Cockpit.Space.s4)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    list
                }
                .padding(.bottom, Cockpit.Space.s6)
                .animation(.easeOut(duration: Cockpit.Duration.fast), value: book.listed == nil)
            }
            .scrollDismissesKeyboard(.immediately)
            .refreshable { await book.read() }
            .accessibilityIdentifier("ask.conversations")
        }
        .groundColor(Cockpit.Color.canvas)
        .task { await book.read() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await book.read() } }
        }
        .readsAgain(failed: { book.failure }) { await book.read() }
    }

    private var open: String? {
        guard case .chat(let key) = AppNavigation.shared.path(.ask).wrappedValue.last else { return nil }
        return book.conversation(key).chat ?? key
    }

    @ViewBuilder
    private var list: some View {
        let words = search.trimmingCharacters(in: .whitespaces)
        let rows = book.conversations.filter { words.isEmpty || $0.title.localizedCaseInsensitiveContains(words) }
        if book.listed == nil, book.conversations.isEmpty {
            if let failure = book.failure {
                ReadLack(failure, lacks: "Your conversations aren't on this iPhone yet.", words: PeopleWords.failure(failure)) {
                    Task { await book.read() }
                }
                .padding(.horizontal, Cockpit.Space.s5)
                .padding(.top, Cockpit.Space.s4)
            } else {
                Self.reading
            }
        } else if book.conversations.isEmpty {
            EmptyState(.chat, title: "No conversations yet").centred()
                .padding(.top, Cockpit.Space.s10)
                .accessibilityIdentifier("ask.empty")
        } else if rows.isEmpty {
            EmptyState(.search, "Nothing matches “\(words)”.").centred()
                .padding(.top, Cockpit.Space.s10)
                .accessibilityIdentifier("ask.unmatched")
        } else {
            let open = open
            ForEach(AskWords.byWhen(rows, today: home.today), id: \.label) { group in
                ChatLabel(group.label)
                ForEach(group.rows) { row in
                    ChatRow(row.title, selected: row.key == open, running: row.running) {
                        AppNavigation.shared.openChat(row.key)
                    }
                    .accessibilityIdentifier("ask.chat")
                }
            }
        }
    }

    private static var reading: some View {
        let titles = ["Dinner with Person A on Friday", "Sleep this week", "When the booking was made",
                      "Walks along the ridge", "The visa guide", "Who did I see most"]
        return VStack(alignment: .leading, spacing: 0) {
            ChatLabel("Today")
            ForEach(titles.indices, id: \.self) { index in
                ChatRow(titles[index]) {}
            }
            WaitLine()
        }
        .reading(true)
    }
}
