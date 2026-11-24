import SwiftUI

public struct FaceRow: View {
    public struct Face: Identifiable {
        public let id: String
        let name: String?
        let photo: Image?
        let loading: Bool
        let open: (() -> Void)?

        public init(id: String, name: String?, photo: Image? = nil, loading: Bool = false, open: (() -> Void)? = nil) {
            self.id = id
            self.name = name
            self.photo = photo
            self.loading = loading
            self.open = open
        }
    }

    let faces: [Face]
    @State private var whole = false
    @Environment(\.cockpitPlatform) private var platform

    private static let places = 6
    private static let widest: CGFloat = 340

    public init(_ faces: [Face]) {
        self.faces = faces
    }

    public var body: some View {
        if !faces.isEmpty {
            let folded = !whole && faces.count > Self.places
            let shown = folded ? Array(faces.prefix(Self.places - 1)) : faces
            let layout = platform == .ios ? AnyLayout(VStackLayout(alignment: .leading, spacing: 0)) : AnyLayout(FaceFlow(gap: Cockpit.Space.s4))
            layout {
                ForEach(shown) { face($0) }
                if folded { more(faces.count - shown.count) }
            }
            .padding(.bottom, platform == .ios ? -6 : 0)
        }
    }

    @ViewBuilder private func face(_ face: Face) -> some View {
        let said = face.name ?? "No name yet"
        let drawn = HStack(spacing: platform == .ios ? Cockpit.Space.s3 : Cockpit.Space.s2) {
            PersonFace(face.name, photo: face.photo, size: platform == .ios ? .row : .md, loading: face.loading)
            Text(said)
                .cockpit(platform == .ios ? .body : .subhead)
                .foregroundStyle(face.name == nil ? Cockpit.Color.textSecondary : Cockpit.Color.text)
                .lineLimit(1)
        }
        .frame(maxWidth: Self.widest, alignment: .leading)
        .frame(height: platform == .ios ? 56 : Cockpit.Size.target)
        if let open = face.open {
            Button(action: open) { drawn.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityLabel(said)
                .accessibilityHint("Opens this person")
                .accessibilityIdentifier("inspector.person.\(face.id)")
        } else {
            drawn
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(said)
        }
    }

    private func more(_ count: Int) -> some View {
        Button { withAnimation(.easeOut(duration: Cockpit.Duration.base)) { whole = true } } label: {
            Text("+\(count)")
                .cockpit(.subhead)
                .monospacedDigit()
                .foregroundStyle(Cockpit.Color.textSecondary)
                .padding(.horizontal, Cockpit.Space.s3)
                .frame(height: Monogram.Size.md.side)
                .background(Capsule().fill(Cockpit.Color.raised))
                .frame(height: Cockpit.Size.target)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(count) more")
        .accessibilityIdentifier("inspector.people.more")
    }
}

private struct FaceFlow: Layout {
    let gap: CGFloat

    private func places(_ width: CGFloat, _ subviews: Subviews) -> (points: [CGPoint], size: CGSize) {
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        var points: [CGPoint] = []
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        if width.isFinite, let column = sizes.map(\.width).max(), column > 0 {
            let columns = max(1, Int((width + gap) / (column + gap)))
            let step = columns == 1 ? width : (width + gap) / CGFloat(columns)
            for index in sizes.indices {
                points.append(CGPoint(x: CGFloat(index % columns) * step, y: CGFloat(index / columns) * (sizes[index].height)))
            }
            let rows = (sizes.count + columns - 1) / columns
            return (points, CGSize(width: width, height: CGFloat(rows) * (sizes.first?.height ?? 0)))
        }
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += line
                line = 0
            }
            points.append(CGPoint(x: x, y: y))
            widest = max(widest, x + size.width)
            x += size.width + gap
            line = max(line, size.height)
        }
        return (points, CGSize(width: widest, height: y + line))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        places(proposal.width ?? .infinity, subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let points = places(bounds.width, subviews).points
        for (view, point) in zip(subviews, points) {
            view.place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y), proposal: .unspecified)
        }
    }
}
