import SwiftUI

public struct DiskBar: View {
    public enum Tone: String, Sendable, CaseIterable {
        case s1, s2, s3, s4, s5, other, own, uncounted, disk, free

        public var color: SwiftUI.Color {
            switch self {
            case .s1: Cockpit.Color.storage1
            case .s2: Cockpit.Color.storage2
            case .s3: Cockpit.Color.storage3
            case .s4: Cockpit.Color.storage4
            case .s5: Cockpit.Color.storage5
            case .other: Cockpit.Color.storageOther
            case .own: Cockpit.Color.storageOwn
            case .uncounted, .disk: Cockpit.Color.storageDisk
            case .free: Cockpit.Color.raised
            }
        }

        var striped: Bool { self == .uncounted || self == .disk }
    }

    public struct Part: Identifiable, Equatable, Sendable {
        public let id: String
        public let name: String
        public let tone: Tone
        public let share: Double
        public let size: String

        public init(id: String, name: String, tone: Tone, share: Double, size: String) {
            self.id = id
            self.name = name
            self.tone = tone
            self.share = share
            self.size = size
        }
    }

    public struct Key: Equatable, Sendable {
        public let id: String
        public let name: String
        public let tone: Tone

        public init(id: String, name: String, tone: Tone) {
            self.id = id
            self.name = name
            self.tone = tone
        }
    }

    let label: String
    let parts: [Part]
    let key: [Key]
    let time: String?
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ label: String, parts: [Part], key: [Key], time: String? = nil) {
        self.label = label
        self.parts = parts
        self.key = key
        self.time = time
    }

    static let height: CGFloat = 28
    static let gap: CGFloat = 2
    static let least: CGFloat = 3

    public var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
            bar
            if !key.isEmpty || time != nil { keyed }
        }
    }

    private var bar: some View {
        DiskParts(shares: parts.map { $0.tone == .free ? nil : max(0, $0.share) / 100 }) {
            ForEach(parts.indices, id: \.self) { index in
                DiskPartFill(tone: parts[index].tone)
            }
        }
        .frame(height: Self.height)
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .animation(reduceMotion ? nil : .easeOut(duration: Cockpit.Duration.draw), value: parts)
        .accessibilityElement()
        .accessibilityAddTraits(.isImage)
        .accessibilityLabel(label)
    }

    private var keyed: some View {
        FlowLayout(spacing: Cockpit.Space.s4, lineSpacing: 6) {
            ForEach(key.indices, id: \.self) { index in
                HStack(spacing: 6) {
                    DiskDot(tone: key[index].tone)
                    Text(key[index].name).lineLimit(1)
                }
            }
            if let time {
                Text(time).monospacedDigit().foregroundStyle(Cockpit.Color.textTertiary).lineLimit(1)
            }
        }
        .cockpit(platform == .ios ? Cockpit.Style.iosFootnote : platform.style(.subhead))
        .foregroundStyle(Cockpit.Color.textSecondary)
        .accessibilityHidden(true)
    }
}

private struct DiskParts: Layout {
    let shares: [Double?]

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        CGSize(width: proposal.width ?? 0, height: proposal.height ?? DiskBar.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let room = max(0, bounds.width - DiskBar.gap * CGFloat(max(0, subviews.count - 1)))
        let fixed = shares.map { $0.map { max(DiskBar.least, room * $0) } }
        let flexible = shares.filter { $0 == nil }.count
        let left = max(0, room - fixed.compactMap { $0 }.reduce(0, +))
        var x = bounds.minX
        for (index, subview) in subviews.enumerated() {
            let width = fixed.indices.contains(index) ? fixed[index] ?? max(DiskBar.least, left / CGFloat(max(1, flexible))) : 0
            subview.place(at: CGPoint(x: x, y: bounds.minY), proposal: ProposedViewSize(width: width, height: bounds.height))
            x += width + DiskBar.gap
        }
    }
}

private struct DiskPartFill: View {
    let tone: DiskBar.Tone

    var body: some View {
        if tone.striped {
            Stripes(spacing: 6, width: 3).fill(tone.color)
        } else {
            Rectangle().fill(tone.color)
        }
    }
}

struct DiskDot: View {
    let tone: DiskBar.Tone

    var body: some View {
        Group {
            if tone.striped {
                Stripes(spacing: 3, width: 1.5).fill(Cockpit.Color.textTertiary)
                    .clipShape(Circle())
                    .overlay(Circle().strokeBorder(Cockpit.Color.textTertiary, lineWidth: 1))
            } else {
                Circle().fill(tone.color)
            }
        }
        .frame(width: 8, height: 8)
        .accessibilityHidden(true)
    }
}

private struct Stripes: Shape {
    let spacing: CGFloat
    let width: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        var x = rect.minX - rect.height
        while x < rect.maxX {
            path.move(to: CGPoint(x: x, y: rect.maxY))
            path.addLine(to: CGPoint(x: x + rect.height, y: rect.minY))
            path.addLine(to: CGPoint(x: x + rect.height + width, y: rect.minY))
            path.addLine(to: CGPoint(x: x + width, y: rect.maxY))
            path.closeSubpath()
            x += spacing
        }
        return path.intersection(Path(rect))
    }
}
