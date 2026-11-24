#if os(macOS)
import AppKit
import SwiftUI

public struct DragPanelFace: View {
    public static var width: CGFloat { 280 }

    let title: String
    let steps: [String]
    let after: String?
    let icon: Image
    let name: String
    let close: @MainActor () -> Void

    public init(title: String, steps: [String], after: String? = nil, icon: Image, name: String,
                close: @escaping @MainActor () -> Void = {}) {
        self.title = title
        self.steps = steps
        self.after = after
        self.icon = icon
        self.name = name
        self.close = close
    }

    private typealias Ob = Cockpit.Onboarding
    @Environment(\.colorScheme) private var scheme

    private var look: Look { scheme == .dark ? .night : .day }

    public var body: some View {
        let look = look
        let ground = RoundedRectangle(cornerRadius: 16, style: .continuous)
        let plate = RoundedRectangle(cornerRadius: 10, style: .continuous)
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(Ob.type(15, .medium)).tracking(-0.3).lineSpacing(Ob.leading(15, 1.3))
                .foregroundStyle(look.ink).fixedSize(horizontal: false, vertical: true)
                .padding(.trailing, 24)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 10) {
                icon.resizable().frame(width: 26, height: 26).accessibilityHidden(true)
                Text(name).font(Ob.type(13, .medium)).tracking(-0.13).foregroundStyle(look.ink).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(10)
            .background { plate.fill(look.tile) }
            .overlay { plate.strokeBorder(look.edge, lineWidth: 1) }
            .padding(.vertical, 14)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, line in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(index + 1)").font(Ob.type(11, .regular)).foregroundStyle(look.ink)
                            .frame(width: 20, height: 20).background(Circle().fill(look.disc))
                            .alignmentGuide(.firstTextBaseline) { $0[.firstTextBaseline] + 1 }
                        Text(Self.marked(line, size: 13, ink: look.ink)).font(Ob.type(13, .regular)).tracking(-0.13)
                            .foregroundStyle(look.step)
                            .lineSpacing(Ob.leading(13, 1.4)).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if let after {
                Text(Self.marked(after, size: 12.5, ink: look.ink)).font(Ob.type(12.5, .regular)).tracking(-0.125).foregroundStyle(look.soft)
                    .lineSpacing(Ob.leading(12.5, 1.45)).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 12)
                    .overlay(alignment: .top) { Rectangle().fill(look.rule).frame(height: 1) }
                    .padding(.top, 12)
            }
        }
        .padding(18)
        .frame(width: Self.width, alignment: .leading)
        .overlay(alignment: .topTrailing) {
            Button(action: close) {
                Image(systemName: "xmark").font(.system(size: 7.5, weight: .medium)).foregroundStyle(look.closeInk)
                    .frame(width: 22, height: 22).background(Circle().fill(look.closeDisc))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
            .padding(.top, 14).padding(.trailing, 12)
        }
        .background { ZStack { look.ground; look.wash } }
        .clipShape(ground)
        .cockpitShadow(look.shadow, in: ground)
    }

    static func marked(_ line: String, size: CGFloat, ink: Color) -> AttributedString {
        var text = (try? AttributedString(markdown: line, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(line)
        for run in text.runs where run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true {
            text[run.range].inlinePresentationIntent = nil
            text[run.range].font = Ob.type(size, .medium)
            text[run.range].foregroundColor = ink
        }
        return text
    }

    private struct Look {
        let ground, wash, ink, step, soft, tile, edge, rule, disc, closeDisc, closeInk: Color
        let shadow: Cockpit.ShadowSet

        static let night = Look(
            ground: Ob.Color.ground, wash: Ob.Color.panel, ink: Ob.Color.ink, step: Ob.Color.ink.opacity(0.82), soft: Ob.Color.soft,
            tile: .clear, edge: Ob.Color.line, rule: Ob.Color.hairline, disc: Ob.Color.raised,
            closeDisc: .black.opacity(0.35), closeInk: Ob.Color.ink.opacity(0.9), shadow: Ob.Shadow.glass)

        static let day = Look(
            ground: Cockpit.Color.overlay, wash: .clear, ink: Cockpit.Color.text, step: Cockpit.Color.textSecondary,
            soft: Cockpit.Color.textTertiary, tile: Cockpit.Color.well, edge: Cockpit.Color.hairline, rule: Cockpit.Color.hairline,
            disc: Cockpit.Color.raised, closeDisc: Cockpit.Color.raised, closeInk: Cockpit.Color.textSecondary,
            shadow: Cockpit.Shadow.glass)
    }
}

public extension Cockpit.Onboarding {
    static func type(_ size: CGFloat, _ weight: Font.Weight) -> Font {
        guard let font = geist(size, weight) else { return .system(size: size, weight: weight) }
        return Font(font as CTFont)
    }

    static func leading(_ size: CGFloat, _ height: CGFloat) -> CGFloat {
        let font = geist(size, .regular) ?? .systemFont(ofSize: size)
        return max(0, size * height - (font.ascender - font.descender + font.leading))
    }

    private static func geist(_ size: CGFloat, _ weight: Font.Weight) -> NSFont? {
        NSFont(name: weight == .medium ? "Geist-Medium" : "Geist-Regular", size: size)
    }
}
#endif
