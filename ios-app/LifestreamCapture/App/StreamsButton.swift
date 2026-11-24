import Cockpit
import SwiftUI

extension View {
    func streamsButton() -> some View {
        toolbar {
            ToolbarItem(placement: .topBarTrailing) { StreamsControl() }
        }
    }

    func tabRoot(_ name: String, captures: Bool = false) -> some View {
        barTitleScroll(current: true).rootBar(name) { RootTitle(name) } controls: {
            SearchControl()
            StreamsControl(slot: true)
            if captures { CaptureMenu(slot: true) }
        }
    }

    func chatBar(conversation: Bool = false, title: String? = nil) -> some View {
        barTitleScroll(current: true).floatingBar(title ?? "Chat", title: title.flatMap { $0.isEmpty ? nil : $0 }) {
            ConversationsControl()
        } trailing: {
            if conversation {
                NewConversationControl()
            } else {
                HStack(spacing: 0) {
                    SearchControl()
                    StreamsControl(slot: true)
                }
            }
        }
    }
}

struct StreamsControl: View {
    var slot = false
    @ObservedObject private var needs = PhoneNeeds.shared
    @ObservedObject private var agents = AppRuntime.shared.agents
    @ObservedObject private var home = AppRuntime.shared.homeStreams

    private var count: Int {
        let badge = home.answer?.page.badge
        return (badge?.needs ?? 0) + needs.needs.count + (badge?.asks ?? 0)
    }

    private var heard: [String] { needs.home.map(PhoneNeeds.key) + agents.asks.map(\.id) }

    private var mark: Color? {
        guard count > 0 else { return nil }
        return needs.stopped ? Cockpit.Color.warning : Cockpit.Color.caution
    }

    var body: some View {
        let mark = mark
        let icon = Icon(.streams, size: .lg, label: StreamsWords.page)
            .overlay(alignment: .topTrailing) {
                if let mark {
                    Circle()
                        .fill(mark)
                        .frame(width: 7, height: 7)
                        .offset(x: 3, y: -3)
                        .accessibilityHidden(true)
                }
            }
        Button { AppNavigation.shared.present(.streams) } label: {
            if slot { icon.foregroundStyle(Cockpit.Color.text).barSlot() } else { icon.foregroundStyle(Cockpit.Color.text).padding(5) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(count > 0 ? "\(StreamsWords.page), \(count) need you" : StreamsWords.page)
        .accessibilityIdentifier("streams.open")
        .task(id: heard) {
            if AppRuntime.shared.shipping.shipper.paired { await home.read() }
        }
    }
}

struct SearchControl: View {
    var body: some View {
        Button { AppNavigation.shared.present(.search) } label: {
            Icon(.search, size: .lg, label: "Search").foregroundStyle(Cockpit.Color.text).barSlot()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Search")
        .accessibilityIdentifier("search.open")
    }
}

struct ConversationsControl: View {
    var body: some View {
        Button { AppNavigation.shared.conversationsOpen = true } label: {
            Icon(.conversations, size: .lg, label: "Conversations").foregroundStyle(Cockpit.Color.text).barSlot()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Conversations")
        .accessibilityIdentifier("ask.conversations.open")
    }
}

struct NewConversationControl: View {
    var body: some View {
        Button { AppNavigation.shared.newChat() } label: {
            Icon(.compose, size: .lg, label: "New conversation").foregroundStyle(Cockpit.Color.text).barSlot()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("New conversation")
        .accessibilityIdentifier("ask.new")
    }
}
