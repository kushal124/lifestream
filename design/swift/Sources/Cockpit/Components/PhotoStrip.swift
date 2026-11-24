import SwiftUI

public struct PhotoStrip<Item: Identifiable, Picture: View>: View {
    let items: [Item]
    let rail: DayRail
    let label: (Item) -> String
    let video: (Item) -> Bool
    let open: (Item) -> Void
    let picture: (Item) -> Picture

    public static var most: Int { 4 }
    static var side: CGFloat { 66 }

    public init(_ items: [Item], rail: DayRail = .through, label: @escaping (Item) -> String,
                video: @escaping (Item) -> Bool = { _ in false }, open: @escaping (Item) -> Void,
                @ViewBuilder picture: @escaping (Item) -> Picture) {
        self.items = items
        self.rail = rail
        self.label = label
        self.video = video
        self.open = open
        self.picture = picture
    }

    public var body: some View {
        let shown = Array(items.prefix(Self.most))
        let rest = items.count > Self.most ? items.count - (Self.most - 1) : 0
        HStack(spacing: 6) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, item in
                let door = rest > 0 && index == shown.count - 1
                Button { open(item) } label: {
                    picture(item).overlay {
                        if door {
                            ZStack {
                                Cockpit.Color.photoScrim
                                Text("+\(ContactRun.number(rest))")
                                    .cockpit(Cockpit.Style.iosHeadline)
                                    .foregroundStyle(Cockpit.Color.knob)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
                .buttonStyle(PhotoTileStyle(video: video(item)))
                .frame(maxWidth: Self.side)
                .accessibilityLabel(door ? "\(label(item)), and \(rest - 1) more" : label(item))
                .accessibilityAddTraits(.isImage)
            }
            Spacer(minLength: 0)
        }
        .column(DayLattice.lead)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity)
        .dayRail(rail)
    }
}
