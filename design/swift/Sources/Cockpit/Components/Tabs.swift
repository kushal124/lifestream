import SwiftUI

public struct TabOption<ID: Hashable>: Identifiable {
    public let id: ID
    let label: String
    let needs: Bool
    let identifier: String?

    public init(_ label: String, id: ID, needs: Bool = false, identifier: String? = nil) {
        self.id = id
        self.label = label
        self.needs = needs
        self.identifier = identifier
    }
}

public struct Tabs<ID: Hashable>: View {
    let label: String
    let options: [TabOption<ID>]
    @Binding var selection: ID
    var forced: ID?
    @State private var chosen = 0
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static func inside(_ platform: Cockpit.Platform) -> CGFloat { platform == .ios ? 10 : Cockpit.Space.s3 }

    public init(_ label: String, options: [TabOption<ID>], selection: Binding<ID>) {
        self.label = label
        self.options = options
        self._selection = selection
    }

    public var body: some View {
        ScrollViewReader { scroll in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) { pills }
            }
            .scrollClipDisabled()
            .padding(.horizontal, -Self.inside(platform))
            .onAppear { scroll.scrollTo(selection) }
            .onChange(of: selection) { _, shown in
                withAnimation(reduceMotion ? nil : .easeOut(duration: Cockpit.Duration.fast)) { scroll.scrollTo(shown) }
            }
        }
        .sensoryFeedback(.selection, trigger: chosen)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
        .layoutValue(key: SheetStack.Heads.self, value: true)
    }

    private var pills: some View {
        ForEach(options) { option in pill(option) }
    }

    private func pill(_ option: TabOption<ID>) -> some View {
        let shown = option.id == selection
        let pressed: RowHighlight? = forced == option.id ? .touched(platform) : nil
        return Button {
            guard !shown else { return }
            if platform == .ios { chosen += 1 }
            selection = option.id
        } label: {
            TabPill(label: option.label, needs: option.needs)
        }
        .buttonStyle(Cockpit.Pressable(forced: pressed) { label, state in
            TabPillFace(label: label, state: state, shown: shown)
        })
        .id(option.id)
        .accessibilityLabel(option.label)
        .accessibilityValue(option.needs ? "needs you" : "")
        .accessibilityAddTraits(shown ? .isSelected : [])
        .accessibilityIdentifier(option.identifier ?? "")
    }
}

private struct TabPill: View {
    let label: String
    let needs: Bool
    @Environment(\.cockpitPlatform) private var platform

    var body: some View {
        HStack(spacing: 6) {
            Text(label).cockpit(platform == .ios ? Cockpit.Style.iosRowTitle : platform.style(.headline)).fixedSize()
            if needs {
                Circle().fill(Cockpit.Color.caution).frame(width: 6, height: 6)
            }
        }
        .lineLimit(1)
    }
}

private struct TabPillFace: View {
    let label: ButtonStyleConfiguration.Label
    let state: RowHighlight?
    let shown: Bool
    @Environment(\.cockpitPlatform) private var platform

    var body: some View {
        let shape = Capsule(style: .continuous)
        let fill: Color = shown ? Cockpit.Color.selection
            : state.map { $0 == .hover ? Cockpit.Color.hover : Cockpit.Color.pressed } ?? .clear
        let height: CGFloat = platform == .ios ? Cockpit.Size.controlSm : 28
        label
            .foregroundStyle(shown || state != nil ? Cockpit.Color.text : Cockpit.Color.textSecondary)
            .padding(.horizontal, Tabs<Int>.inside(platform))
            .frame(minHeight: height)
            .background(shape.fill(fill))
            .animation(.easeOut(duration: Cockpit.Duration.instant), value: state)
            .animation(.easeOut(duration: Cockpit.Duration.instant), value: shown)
            .overlay { FocusRing(radius: height / 2) }
            .contentShape(shape)
            .padding(.vertical, max(0, platform.hitSize - height) / 2)
            .contentShape(Rectangle())
            .padding(.vertical, -max(0, platform.hitSize - height) / 2)
    }
}
