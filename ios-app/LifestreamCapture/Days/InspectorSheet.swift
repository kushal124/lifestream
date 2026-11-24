import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct InspectorSheet: View {
    let day: String
    let focus: String
    var marks: [String]? = nil
    @StateObject private var reads = InspectorReads()
    private let navigation = AppNavigation.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            MomentInspector(day: day, focus: focus, marks: marks)
                .toolbar(.hidden, for: .navigationBar)
                .containerBackground(Cockpit.Color.surface, for: .navigation)
        }
        .environmentObject(reads)
        .environment(\.inspectorGo, InspectorGo { route in
            dismiss()
            navigation.open(route, in: navigation.selectedTab)
        })
        .tint(Cockpit.Color.text)
        .drawerRest()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inspector")
    }
}

struct MomentPage: View {
    let day: String
    let focus: String
    @StateObject private var reads = InspectorReads()

    var body: some View {
        MomentInspector(day: day, focus: focus)
            .environmentObject(reads)
            .environment(\.inspectorGo, InspectorGo { AppNavigation.shared.push($0) })
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .groundColor(Cockpit.Color.surface)
            .tint(Cockpit.Color.text)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("inspector")
    }
}

struct InspectorGo {
    let open: @MainActor (LifeRoute) -> Void

    @MainActor func callAsFunction(_ route: LifeRoute) { open(route) }
}

extension EnvironmentValues {
    @Entry var inspectorGo = InspectorGo { _ in }
}

extension Inspector {
    static func out(_ open: HomeLink.Open) -> InspectorOut? {
        URL(string: open.href).map { InspectorOut(open.label, url: $0) }
    }
}

extension Inspector {
    struct Head {
        let icon: Cockpit.Icon
        let title: String
        let meta: String
    }

    struct ReadingFrame<Content: View>: View {
        let head: Head?
        @ViewBuilder let content: Content

        var body: some View {
            InspectorFrame(head?.title ?? "A moment of your life", icon: head?.icon ?? .info,
                           when: head?.meta ?? "Fri 16 Oct · 09:14–09:28 · Messages", reading: head == nil, identifier: nil) {
                VStack(alignment: .leading, spacing: 0) {
                    content
                    WaitLine()
                }
                .reading(true)
            }
            .frame(maxHeight: .infinity, alignment: .top)
        }
    }

    struct Bubbles: View {
        private static let messages: [(words: String, mine: Bool)] = [
            ("Are we still on for tonight?", false), ("The usual place, the one with the long tables by the window", false),
            ("Yes, see you there at eight", true), ("Great", false), ("Bring the synthetic book if you have it", false),
            ("Will do", true),
        ]

        var body: some View {
            VStack(spacing: 2) {
                ForEach(Self.messages.indices, id: \.self) { index in
                    let message = Self.messages[index]
                    MessageBubble(message.words, mine: message.mine)
                        .padding(.top, index > 0 && Self.messages[index - 1].mine != message.mine ? Cockpit.Space.s2 : 0)
                }
            }
        }
    }
}
