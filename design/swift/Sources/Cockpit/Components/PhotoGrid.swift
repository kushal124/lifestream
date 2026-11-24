import SwiftUI

public struct PhotoGrid<Item: Identifiable, Picture: View>: View {
    let items: [Item]
    let columns: Int?
    let filled: Bool
    let label: (Item) -> String
    let video: (Item) -> Bool
    let open: (Item) -> Void
    let picture: (Item) -> Picture
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.cockpitPhotosRoom) private var room

    public init(_ items: [Item], columns: Int? = nil, filled: Bool = false, label: @escaping (Item) -> String,
                video: @escaping (Item) -> Bool = { _ in false }, open: @escaping (Item) -> Void,
                @ViewBuilder picture: @escaping (Item) -> Picture) {
        self.items = items
        self.columns = columns
        self.filled = filled
        self.label = label
        self.video = video
        self.open = open
        self.picture = picture
    }

    public var body: some View {
        if filled {
            FilledRows(spacing: Cockpit.Space.s2, room: room) {
                ForEach(Array(items.prefix(FilledRows.most))) { item in tile(item, square: false) }
            }
        } else {
            grid
        }
    }

    private var grid: some View {
        let across = columns ?? (platform == .ios ? 3 : 4)
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Cockpit.Space.s2), count: across),
                  spacing: Cockpit.Space.s2) {
            ForEach(columns == nil ? Array(items.prefix(across)) : items) { item in tile(item, square: true) }
        }
    }

    private func tile(_ item: Item, square: Bool) -> some View {
        Button { open(item) } label: { picture(item) }
            .buttonStyle(PhotoTileStyle(square: square, video: video(item)))
            .accessibilityLabel(label(item))
            .accessibilityAddTraits(.isImage)
    }
}

public struct PhotosRoom: Equatable {
    let height: CGFloat
    let under: CGFloat
    let followed: Bool

    public init(height: CGFloat, under: CGFloat = 0, followed: Bool) {
        self.height = height
        self.under = under
        self.followed = followed
    }
}

extension EnvironmentValues {
    @Entry public var cockpitPhotosRoom: PhotosRoom?
}

struct FilledRows: Layout {
    static let most = 6
    let spacing: CGFloat
    var room: PhotosRoom?

    static func rows(_ count: Int) -> [Int] {
        switch min(count, most) {
        case 0: []
        case 4: [2, 2]
        case let n where n <= 3: [n]
        case let n: [3, n - 3]
        }
    }

    private func side(_ width: CGFloat) -> CGFloat { max(0, (width - spacing * 2) / 3) }

    private func rest(_ count: Int, _ width: CGFloat) -> (top: CGFloat, height: CGFloat, after: CGFloat) {
        let side = side(width)
        guard let room, count > 0 else { return (0, side, 0) }
        let rows = CGFloat(count), gaps = spacing * (rows - 1)
        let air = room.followed ? spacing : Cockpit.Gap.group
        if room.height >= side * rows + gaps + air { return (0, side, 0) }
        let least = side / 2
        let shorter = (room.height - gaps - air) / rows
        if shorter >= least { return (0, shorter, 0) }
        if count > 1, room.height - spacing >= least { return (0, room.height - spacing, room.under) }
        return (max(0, room.height + room.under), side, 0)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 300
        let rows = Self.rows(subviews.count).count
        let rest = rest(rows, width)
        return CGSize(width: width, height: rows == 0 ? 0 : rest.top + rest.height * CGFloat(rows) + spacing * CGFloat(rows - 1)
                        + (rows > 1 ? rest.after : 0))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rest = rest(Self.rows(subviews.count).count, bounds.width)
        let height = rest.height
        var index = 0
        var first = true
        var y = bounds.minY + rest.top
        for across in Self.rows(subviews.count) {
            let width = (bounds.width - spacing * CGFloat(across - 1)) / CGFloat(across)
            for column in 0..<across {
                subviews[index].place(at: CGPoint(x: bounds.minX + CGFloat(column) * (width + spacing), y: y), anchor: .topLeading,
                                      proposal: ProposedViewSize(width: width, height: height))
                index += 1
            }
            y += height + spacing + (first ? rest.after : 0)
            first = false
        }
    }
}

struct PhotoTileStyle: ButtonStyle {
    var square = true
    var video = false
    var forced: RowHighlight?

    func makeBody(configuration: Configuration) -> some View {
        PhotoTile(label: configuration.label, square: square, video: video, pressed: configuration.isPressed, forced: forced)
    }
}

private struct PhotoTile<Label: View>: View {
    let label: Label
    let square: Bool
    let video: Bool
    let pressed: Bool
    let forced: RowHighlight?
    @State private var hovering = false
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.skeletonTone) private var tone

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.sm, style: .continuous)
        if redaction.skeleton {
            shape.fill(tone).squared(square)
        } else {
            let live: RowHighlight? = pressed ? .pressed : hovering && platform == .mac ? .hover : nil
            shape.fill(Cockpit.Color.raised)
                .squared(square)
                .overlay { Icon(video ? .video : .photo).foregroundStyle(Cockpit.Color.textTertiary) }
                .overlay { label.frame(maxWidth: .infinity, maxHeight: .infinity) }
                .clipShape(shape)
                .overlay {
                    shape.strokeBorder(Cockpit.Color.rule, lineWidth: Cockpit.Stroke.border)
                    if let highlight = forced ?? live { shape.fill(RowChrome<EmptyView>.color(highlight)) }
                }
                .overlay { FocusRing(radius: Cockpit.Radius.sm) }
                .contentShape(shape)
                .animation(.easeOut(duration: Cockpit.Duration.instant), value: live)
                .onHover { hovering = $0 }
        }
    }
}

private extension View {
    @ViewBuilder func squared(_ square: Bool) -> some View {
        if square { aspectRatio(1, contentMode: .fit) } else { frame(maxWidth: .infinity, maxHeight: .infinity) }
    }
}
