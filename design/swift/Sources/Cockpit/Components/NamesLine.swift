import SwiftUI

public struct NamesLine: View {
    let names: [String]
    let icons: [Cockpit.Icon]?
    let rail: DayRail
    let open: (Int) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    public init(_ names: [String], icons: [Cockpit.Icon]? = nil, rail: DayRail = .through, open: @escaping (Int) -> Void) {
        self.names = names
        self.icons = icons.flatMap { $0.count == names.count ? $0 : nil }
        self.rail = rail
        self.open = open
    }

    public var body: some View {
        if !names.isEmpty {
            let measure = DayMeasure(size: typeSize)
            NamesFlow(lines: measure.stacked ? 3 : 2, pitch: measure(20)) {
                ForEach(Array(names.enumerated()), id: \.offset) { index, name in
                    Offered {
                        NameButton(name: name, icon: icons?[index], comma: icons == nil && index < names.count - 1,
                                   gap: icons != nil && index < names.count - 1) { open(index) }
                    }
                }
                ForEach(1..<names.count, id: \.self) { left in
                    Offered {
                        Text("+\(ContactRun.number(left))")
                            .cockpit(Cockpit.Style.iosSubhead)
                            .foregroundStyle(Cockpit.Color.textTertiary)
                            .lineLimit(1)
                            .accessibilityLabel("\(left) more")
                    }
                }
            }
            .column(DayLattice.lead)
            .padding(.bottom, 14)
            .frame(maxWidth: .infinity)
            .dayRail(rail)
            .accessibilityElement(children: .contain)
        }
    }
}

private struct NameButton: View {
    let name: String
    let icon: Cockpit.Icon?
    let comma: Bool
    let gap: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 0) {
                if let icon {
                    Icon(icon, size: .xs)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .padding(.trailing, Cockpit.Space.s1)
                        .accessibilityHidden(true)
                }
                Text(name)
                    .cockpit(Cockpit.Style.iosSubhead)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                if comma {
                    Text(", ")
                        .cockpit(Cockpit.Style.iosSubhead)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .fixedSize()
                }
                if gap { Color.clear.frame(width: Cockpit.Space.s3, height: 1) }
            }
            .lineLimit(1)
        }
        .buttonStyle(NamePress(comma: comma || gap))
        .accessibilityLabel(name)
    }
}

private struct NamePress: ButtonStyle {
    let comma: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background {
                RoundedRectangle(cornerRadius: Cockpit.Radius.xs, style: .continuous)
                    .fill(configuration.isPressed ? Cockpit.Color.pressed : .clear)
                    .padding(.leading, -2)
                    .padding(.trailing, comma ? 2 : -2)
                    .padding(.vertical, -2)
            }
            .animation(.easeOut(duration: Cockpit.Duration.instant), value: configuration.isPressed)
            .contentShape(Rectangle())
    }
}

struct NamesFlow: Layout {
    let lines: Int
    let pitch: CGFloat

    private struct Placed {
        let index: Int
        let x: CGFloat
        let line: Int
        let width: CGFloat
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> [Placed] {
        let count = (subviews.count + 1) / 2
        let ideal = (0..<count).map { subviews[$0].sizeThatFits(.unspecified).width }
        let more = { (left: Int) in subviews[count + left - 1].sizeThatFits(.unspecified).width }

        func fit(_ kept: Int) -> [Placed]? {
            var placed: [Placed] = []
            var x: CGFloat = 0
            var line = 0
            for index in 0..<kept {
                let w = min(ideal[index], width)
                if x > 0, x + w > width { line += 1; x = 0 }
                if line >= lines { return nil }
                placed.append(Placed(index: index, x: x, line: line, width: w))
                x += w
            }
            if kept < count {
                let w = more(count - kept)
                if x + w > width { return nil }
                placed.append(Placed(index: count + count - kept - 1, x: x, line: line, width: w))
            }
            return placed
        }

        for kept in stride(from: count, through: 1, by: -1) {
            if let placed = fit(kept) { return placed }
        }
        let left = count - 1
        let room = left > 0 ? width - more(left) : width
        var placed = [Placed(index: 0, x: 0, line: 0, width: max(0, room))]
        if left > 0 { placed.append(Placed(index: count + left - 1, x: max(0, room), line: 0, width: more(left))) }
        return placed
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let placed = arrange(width, subviews)
        let used = placed.map { $0.x + $0.width }.max() ?? 0
        return CGSize(width: proposal.width ?? used, height: CGFloat((placed.map(\.line).max() ?? 0) + 1) * pitch)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let placed = arrange(bounds.width, subviews)
        for item in placed {
            let size = subviews[item.index].sizeThatFits(ProposedViewSize(width: item.width, height: nil))
            subviews[item.index].place(
                at: CGPoint(x: bounds.minX + item.x, y: bounds.minY + CGFloat(item.line) * pitch + (pitch - size.height) / 2),
                proposal: ProposedViewSize(width: item.width, height: nil))
        }
        let shown = Set(placed.map(\.index))
        for index in subviews.indices where !shown.contains(index) {
            subviews[index].place(at: bounds.origin, proposal: .zero)
        }
    }
}
