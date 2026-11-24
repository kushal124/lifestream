import SwiftUI

public struct QuestionCard: View {
    let question: String
    let line: String?
    let yes: String
    let no: String
    let answer: (Bool) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.cockpitPlatform) private var platform

    public init(_ question: String, line: String? = nil, yes: String, no: String = "No", answer: @escaping (Bool) -> Void) {
        self.question = question
        self.line = line
        self.yes = yes
        self.no = no
        self.answer = answer
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous)
        let size: CockpitButtonStyle.Size = platform == .ios ? .large : .regular
        VStack(alignment: .leading, spacing: Cockpit.Space.s4) {
            VStack(alignment: .leading, spacing: 2) {
                Text(question)
                    .cockpit(.title2)
                    .foregroundStyle(Cockpit.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if let line {
                    Text(line)
                        .cockpit(.subhead)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: Cockpit.Space.s2))
                : AnyLayout(Answers(spacing: Cockpit.Space.s2))
            layout {
                Button(yes) { answer(true) }
                    .buttonStyle(.cockpit(.primary, size: size, fullWidth: true))
                Button(no) { answer(false) }
                    .buttonStyle(.cockpit(.secondary, size: size, fullWidth: true))
            }
        }
        .padding(Cockpit.Space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay { shape.strokeBorder(Cockpit.Color.border, lineWidth: Cockpit.Stroke.border) }
        .accessibilityElement(children: .contain)
    }
}

private struct Answers: Layout {
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let height = subviews.map { $0.sizeThatFits(.unspecified).height }.max() ?? 0
        let ideal = subviews.reduce(spacing * CGFloat(max(0, subviews.count - 1))) { $0 + $1.sizeThatFits(.unspecified).width }
        return CGSize(width: proposal.width ?? ideal, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let width = max(0, bounds.width - spacing * CGFloat(max(0, subviews.count - 1)))
        var x = bounds.minX
        for (index, subview) in subviews.enumerated() {
            let share = subviews.count == 2 ? (index == 0 ? width * 2 / 3 : width / 3) : width / CGFloat(subviews.count)
            subview.place(at: CGPoint(x: x, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(width: share, height: nil))
            x += share + spacing
        }
    }
}
