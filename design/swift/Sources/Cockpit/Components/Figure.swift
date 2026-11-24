import SwiftUI

public struct Figure: View {
    public enum Size: Sendable { case xl, l, m }

    let value: String
    let label: String
    let size: Size
    let selected: Bool
    let action: (() -> Void)?
    var forced: ButtonState?

    public init(_ value: String, label: String, size: Size = .l, selected: Bool = false, action: (() -> Void)? = nil) {
        self.value = value
        self.label = label
        self.size = size
        self.selected = selected
        self.action = action
    }

    public var body: some View {
        if let action {
            Button(action: action) { face(nil) }
                .buttonStyle(FigureButtonStyle(figure: self))
                .accessibilityAddTraits(selected ? .isSelected : [])
        } else {
            face(forced).accessibilityElement(children: .combine)
        }
    }

    func face(_ state: ButtonState?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .cockpit(size == .xl ? .figureXL : size == .l ? .figureL : .figureM)
                .foregroundStyle(Cockpit.Color.text)
            Text(label)
                .cockpit(.caption)
                .foregroundStyle(selected ? Cockpit.Color.text : Cockpit.Color.textTertiary)
        }
        .lineLimit(1)
        .padding(.horizontal, action == nil ? 0 : Cockpit.Space.s2)
        .padding(.vertical, action == nil ? 0 : Cockpit.Space.s1 + 2)
        .background {
            let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.xs, style: .continuous)
            if selected { shape.fill(Cockpit.Color.selection) }
            if let state { shape.fill(state == .hover ? Cockpit.Color.hover : Cockpit.Color.pressed) }
        }
        .contentShape(Rectangle())
    }
}

private struct FigureButtonStyle: ButtonStyle {
    let figure: Figure
    func makeBody(configuration: Configuration) -> some View {
        FigureButtonBody(configuration: configuration, figure: figure)
    }
}

private struct FigureButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let figure: Figure
    @State private var hovering = false
    @Environment(\.cockpitPlatform) private var platform
    var body: some View {
        figure.face(figure.forced ?? (configuration.isPressed ? .pressed : hovering && platform == .mac ? .hover : nil))
            .onHover { hovering = $0 }
    }
}

public struct FigureStrip<Content: View>: View {
    let content: Content
    @Environment(\.cockpitPlatform) private var platform

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        if platform == .ios {
            ViewThatFits(in: .horizontal) {
                FigureColumns(spacing: Cockpit.Space.s3) { content }
                FlowLayout(spacing: Cockpit.Space.s5, lineSpacing: Cockpit.Space.s3) { content }
            }
        } else {
            FlowLayout(spacing: Cockpit.Space.s6, lineSpacing: Cockpit.Space.s3) { content }
        }
    }
}

private struct FigureColumns: Layout {
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let least = (sizes.map(\.width).max() ?? 0) * CGFloat(subviews.count) + spacing * CGFloat(max(0, subviews.count - 1))
        return CGSize(width: max(least, proposal.width ?? 0), height: sizes.map(\.height).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let widest = subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0
        let thirds = CGFloat(max(3, subviews.count))
        let fits = widest + spacing <= bounds.width / thirds
        let column = bounds.width / (fits ? thirds : CGFloat(max(1, subviews.count)))
        for (index, subview) in subviews.enumerated() {
            subview.place(at: CGPoint(x: bounds.minX + column * CGFloat(index), y: bounds.minY), proposal: .unspecified)
        }
    }
}
