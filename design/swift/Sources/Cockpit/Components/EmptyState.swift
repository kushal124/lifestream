import SwiftUI

public struct EmptyState: View {
    public func centred(foot: CGFloat = 0) -> some View { modifier(FreeCentre(foot: foot)) }

    let icon: Cockpit.Icon
    let sentence: String
    let title: String?
    let action: String?
    let perform: () -> Void

    public init(_ icon: Cockpit.Icon, _ sentence: String, action: String? = nil, perform: @escaping () -> Void = {}) {
        self.icon = icon
        self.sentence = sentence
        self.title = nil
        self.action = action
        self.perform = perform
    }

    public init(_ icon: Cockpit.Icon, title: String, line: String = "", action: String? = nil, perform: @escaping () -> Void = {}) {
        self.icon = icon
        self.sentence = line
        self.title = title
        self.action = action
        self.perform = perform
    }

    public var body: some View {
        if let title { stack(title) } else { plain }
    }

    private func stack(_ title: String) -> some View {
        VStack(spacing: 0) {
            Icon(icon, size: .lg).foregroundStyle(Cockpit.Color.textTertiary)
            Text(title)
                .cockpit(Cockpit.Style.iosHeadline)
                .foregroundStyle(Cockpit.Color.text)
                .multilineTextAlignment(.center)
                .padding(.top, Cockpit.Space.s3)
            if !sentence.isEmpty {
                Text(sentence)
                    .cockpit(Cockpit.Style.iosSubhead)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.top, Cockpit.Space.s1)
            }
            if let action {
                Button(action, action: perform).buttonStyle(.cockpit(.secondary, size: .large, fullWidth: true)).padding(.top, Cockpit.Space.s5)
            }
        }
        .frame(maxWidth: 280)
        .frame(maxWidth: .infinity)
    }

    private var plain: some View {
        VStack(spacing: Cockpit.Space.s4) {
            Icon(icon, size: .xl).foregroundStyle(Cockpit.Color.textTertiary)
            Text(sentence)
                .cockpit(.body)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
            if let action {
                Button(action, action: perform).buttonStyle(.cockpit(.secondary))
            }
        }
        .padding(.vertical, Cockpit.Space.s10)
        .frame(maxWidth: .infinity)
    }
}

private struct FreeCentre: ViewModifier {
    let foot: CGFloat
    @State private var top: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .containerRelativeFrame(.vertical, alignment: .center) { height, _ in max(0, height - top - foot) }
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .scrollView(axis: .vertical)).minY } action: { top = $0 }
    }
}
