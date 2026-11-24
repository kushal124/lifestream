import SwiftUI

public struct Monogram: View {
    public enum Size: Sendable { case xs, sm, chip, md, row, portrait, tile, head }

    let name: String?
    let size: Size
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.skeletonTone) private var tone
    @Environment(\.cockpitPlatform) private var platform

    public init(_ name: String?, size: Size = .row) {
        self.name = name
        self.size = size
    }

    static func initials(_ name: String) -> String {
        #if os(iOS)
        if name.contains("@") { return "" }
        #endif
        let words = name.split(whereSeparator: { $0.isWhitespace }).compactMap { $0.first(where: \.isLetter) }
        guard let first = words.first else { return "" }
        let last = words.count > 1 ? words.last.map(String.init) ?? "" : ""
        return (String(first) + last).uppercased()
    }

    private var measures: (side: CGFloat, font: CGFloat, glyph: Cockpit.IconSize) {
        switch size {
        case .xs: (size.side, 9, .xs)
        case .sm: (size.side, 10, .xs)
        case .chip: (size.side, 11, .sm)
        case .md: (size.side, 13, .sm)
        case .row: (size.side, 13, .sm)
        case .portrait: (size.side, 18, .lg)
        case .tile: (size.side, 19, .lg)
        case .head: (size.side, 24, .xl)
        }
    }

    public var body: some View {
        let (side, font, glyph) = measures
        ZStack {
            if redaction.skeleton {
                Circle().fill(tone)
            } else {
                face(font: font, glyph: glyph)
            }
        }
        .frame(width: side, height: side)
        .accessibilityElement()
        .accessibilityLabel(name ?? "No name yet")
    }

    @ViewBuilder private func face(font: CGFloat, glyph: Cockpit.IconSize) -> some View {
        let initials = name.map(Self.initials) ?? ""
        if name != nil { Circle().fill(Cockpit.Color.raised) }
        if name == nil || platform != .ios { Circle().strokeBorder(Cockpit.Color.border, lineWidth: Cockpit.Stroke.border) }
        if initials.isEmpty {
            Icon(.person, size: glyph)
                .foregroundStyle(name == nil ? Cockpit.Color.textTertiary : Cockpit.Color.text)
        } else {
            Text(initials)
                .font(.system(size: font, weight: .semibold))
                .tracking(initials.count > 1 ? -0.2 : 0)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
                .foregroundStyle(Cockpit.Color.text)
        }
    }
}

public extension Monogram.Size {
    var side: CGFloat {
        switch self {
        case .xs: 18
        case .sm: Cockpit.Size.avatarSm
        case .chip: Cockpit.Size.avatarChip
        case .md: Cockpit.Size.avatarMd
        case .row: Cockpit.Size.avatarRow
        case .portrait: Cockpit.Size.avatarPortrait
        case .tile: Cockpit.Size.avatarTile
        case .head: Cockpit.Size.avatarHead
        }
    }
}
