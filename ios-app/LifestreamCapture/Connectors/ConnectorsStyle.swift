import Cockpit
import SwiftUI


let connectorsTop = "streams.top"

struct ConnectorsScreen<Head: View, Controls: View, Content: View>: View {
    let title: String
    let head: Head
    let controls: Controls
    let content: Content

    init(_ title: String, @ViewBuilder head: () -> Head, @ViewBuilder controls: () -> Controls, @ViewBuilder content: () -> Content) {
        self.title = title
        self.head = head()
        self.controls = controls()
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Cockpit.Space.s6) {
                head.id(connectorsTop)
                content
            }
            .padding(.horizontal, Cockpit.Gap.list)
            .padding(.top, Cockpit.Gap.group)
            .padding(.bottom, Cockpit.Space.s4)
        }
        .barTitleScroll(current: true)
        .rootBar(title, sheet: true, margin: Cockpit.Gap.list) {
            Text(title)
                .cockpit(.title1)
                .foregroundStyle(Cockpit.Color.text)
                .rootTitleLine()
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("root.title")
                .foldsOnRootLine()
        } controls: {
            controls
        }
        .groundColor(Cockpit.Color.surface)
        .tint(Cockpit.Color.text)
    }
}

extension View {
    func connectorsNote() -> some View {
        self
            .cockpit(Cockpit.Style.iosSubhead)
            .foregroundStyle(Cockpit.Color.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct OpenConnectorsAction: Sendable {
    let perform: @MainActor @Sendable (ConnectorsRoute) -> Void

    @MainActor func callAsFunction(_ route: ConnectorsRoute) { perform(route) }
}

extension EnvironmentValues {
    @Entry var openConnectors = OpenConnectorsAction { _ in }
}

struct SignalMark: Equatable {
    let kind: Cockpit.SignalKind?
    let word: String

    static let on = SignalMark(kind: nil, word: "On")
    static let notAsked = SignalMark(kind: .idle, word: "Not asked")
    static let off = SignalMark(kind: .idle, word: "Off")
    static let checking = SignalMark(kind: .idle, word: "Checking")
}

struct SignalWord: View {
    let mark: SignalMark

    init(_ mark: SignalMark) {
        self.mark = mark
    }

    var body: some View {
        if let kind = mark.kind {
            Signal(kind, mark.word)
        } else {
            Text(mark.word)
                .cockpit(.footnote)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .lineLimit(1)
        }
    }
}
