import SwiftUI

public struct NameRow: View {
    public static let gap: CGFloat = 6
    public static let textEdge: CGFloat = Cockpit.Space.s4 + Cockpit.Space.s6 + Cockpit.Space.s4
    public static let cardEdge: CGFloat = Cockpit.Space.s3 + 32 + Cockpit.Space.s1

    static func height(_ platform: Cockpit.Platform) -> CGFloat { platform == .ios ? 68 : 52 }

    public enum Lead {
        case icon(Cockpit.Icon)
        case crop(Image?)
        case face(String?, photo: Image?)
        case ring(Cockpit.Icon)
        case key(String)
    }

    public enum End {
        case tick(Bool, toggle: () -> Void)
        case add(Bool, toggle: () -> Void)
        case remove(String, () -> Void)
        case caret
        case fixed
    }

    private enum Kind {
        case answer(Cockpit.Icon)
        case card(Lead, End, quiet: Bool, added: Bool, label: String?)
    }

    let name: String
    let line: String
    private let kind: Kind
    let lit: Bool
    let action: () -> Void
    var forced: RowHighlight?

    public init(_ name: String, source: String, icon: Cockpit.Icon, lit: Bool = false, action: @escaping () -> Void) {
        self.name = name
        self.line = source
        self.kind = .answer(icon)
        self.lit = lit
        self.action = action
    }

    public init(_ name: String, line: String, lead: Lead, end: End = .caret, lit: Bool = false, quiet: Bool = false,
                added: Bool = false, label: String? = nil, action: @escaping () -> Void) {
        self.name = name
        self.line = line
        self.kind = .card(lead, end, quiet: quiet, added: added, label: label)
        self.lit = lit
        self.action = action
    }

    public var body: some View {
        switch kind {
        case let .answer(icon):
            Button(action: action) {
                NameRowLabel(name: name, line: line, lit: lit) {
                    AnswerIcon(icon: icon, lit: lit)
                } end: {
                    if lit { ReturnKey() }
                }
            }
            .buttonStyle(Cockpit.Pressable(forced: forced) { label, state in
                NameRowChrome(label: label, lit: lit, card: false, highlight: state)
            })
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(name), \(line)")
            .accessibilityAddTraits(lit ? [.isButton, .isSelected] : .isButton)
        case let .card(lead, end, quiet, added, label):
            CardNameRow(row: self, lead: lead, end: end, quiet: quiet, added: added, label: label)
        }
    }
}

private struct CardNameRow: View {
    let row: NameRow
    let lead: NameRow.Lead
    let end: NameRow.End
    let quiet: Bool
    let added: Bool
    let label: String?
    @State private var hovering = false
    @FocusState private var focused: Bool
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        if platform == .ios, !redaction.skeleton, case .remove = end {
            NameRowChrome(label: label(lit: false) { EmptyView() }, lit: false, card: true, highlight: row.forced)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label ?? "\(row.name), \(row.line)")
        } else {
            button
        }
    }

    private var button: some View {
        let lit = row.lit || focused
        let end: NameRow.End = redaction.skeleton ? .caret : end
        let phone = platform == .ios
        return ZStack(alignment: .trailing) {
            Button(action: phoneToggle ?? row.action) {
                label(lit: lit) {
                    switch end {
                    case let .tick(on, _): Tick(on: on).opacity(phone ? 1 : 0)
                    case let .add(on, _): AddMark(on: on).opacity(phone ? 1 : 0)
                    case .remove: Icon(.close, size: .sm).hidden()
                    case .caret: if !redaction.skeleton { Icon(.forward, size: .xs).foregroundStyle(Cockpit.Color.textTertiary) }
                    case .fixed: EmptyView()
                    }
                }
            }
            .buttonStyle(Cockpit.Pressable(forced: row.forced) { label, state in
                NameRowChrome(label: label, lit: lit, card: true, highlight: lit ? nil : state)
            })
            .focused($focused)
            switch end {
            case .tick where phone, .add where phone:
                EmptyView()
            case let .add(on, toggle):
                Button(action: toggle) { AddMark(on: on) }
                    .buttonStyle(.plain)
                    .focusable(false)
                    .padding(.trailing, Cockpit.Space.s3)
            case let .tick(on, toggle):
                Button(action: toggle) {
                    Tick(on: on).frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .focusable(false)
                .padding(.trailing, Cockpit.Space.s3 - (28 - Tick.side(platform)) / 2)
            case let .remove(name, remove):
                IconButton(.close, label: name, size: .small, action: remove)
                    .focusable(false)
                    .padding(.trailing, Cockpit.Space.s3 - (closeSide - Cockpit.Size.iconSm) / 2)
                    .opacity(lit || hovering || row.forced == .hover ? 1 : 0)
                    .animation(.easeOut(duration: Cockpit.Duration.instant), value: lit || hovering)
            case .caret, .fixed:
                EmptyView()
            }
        }
        .onHover { hovering = $0 }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label ?? "\(row.name), \(row.line)")
        .accessibilityValue(ticked.map { $0 ? "Ticked" : "Not ticked" } ?? "")
        .accessibilityAddTraits(phoneToggle != nil ? .isToggle : lit ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { (phoneToggle ?? row.action)() }
        .modifier(EndAction(end: phoneToggle == nil ? self.end : .caret))
    }

    @ViewBuilder private func label(lit: Bool, @ViewBuilder end: () -> some View) -> some View {
        if case let .key(key) = lead, platform == .ios {
            NameRowKeyed(key: key, name: row.name, line: row.line, quiet: quiet, end: end)
        } else {
            NameRowLabel(name: row.name, line: row.line, lit: lit, card: true, quiet: quiet, added: added) {
                NameRowLead(lead: lead, lit: lit)
            } end: {
                end()
            }
        }
    }

    private var phoneToggle: (() -> Void)? {
        guard platform == .ios, !redaction.skeleton else { return nil }
        switch end {
        case let .tick(_, toggle), let .add(_, toggle): return toggle
        default: return nil
        }
    }

    private var closeSide: CGFloat { platform == .ios ? Cockpit.Size.controlSm : Cockpit.Size.controlMac }
    private var ticked: Bool? {
        switch end {
        case let .tick(on, _), let .add(on, _): on
        default: nil
        }
    }
}

private struct EndAction: ViewModifier {
    let end: NameRow.End

    func body(content: Content) -> some View {
        switch end {
        case let .tick(on, toggle): content.accessibilityAction(named: on ? "Untick" : "Tick", toggle)
        case let .add(on, toggle): content.accessibilityAction(named: on ? "Undo" : "Add", toggle)
        case let .remove(name, remove): content.accessibilityAction(named: name, remove)
        case .caret, .fixed: content
        }
    }
}

struct NameRowLead: View {
    let lead: NameRow.Lead
    let lit: Bool

    var body: some View {
        Group {
            switch lead {
            case let .icon(icon):
                Icon(icon, size: .md).foregroundStyle(lit ? Cockpit.Color.textSecondary : Cockpit.Color.textTertiary)
            case let .crop(photo):
                FaceCrop(photo, label: "")
            case let .face(name, photo):
                PersonFace(name, photo: photo, size: .md)
            case let .ring(icon):
                Icon(icon, size: .sm)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .frame(width: 32, height: 32)
                    .overlay(Circle().strokeBorder(Cockpit.Color.strokeControl, lineWidth: 1.5))
            case let .key(key):
                Text(key).cockpit(.footnote).foregroundStyle(Cockpit.Color.textTertiary).lineLimit(1).minimumScaleFactor(0.6)
            }
        }
        .frame(width: 32, height: 32)
        .accessibilityHidden(true)
    }
}

struct NameRowKeyed<End: View>: View {
    let key: String
    let name: String
    let line: String
    let quiet: Bool
    @ViewBuilder let end: End
    @Environment(\.isEnabled) private var enabled
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: Cockpit.Space.s3) {
            words
            end.opacity(enabled ? 1 : Cockpit.Opacity.disabled)
        }
        .padding(.horizontal, Cockpit.Space.s4)
        .padding(.vertical, Cockpit.Space.s2)
        .frame(maxWidth: .infinity, minHeight: Cockpit.Size.controlLg, alignment: .leading)
    }

    @ViewBuilder private var words: some View {
        let keyText = Text(key).cockpit(Cockpit.Style.iosSubhead).foregroundStyle(Cockpit.Color.textSecondary)
        let nameText = Text(name).cockpit(.body)
            .foregroundStyle(quiet || !enabled ? Cockpit.Color.textSecondary : Cockpit.Color.text)
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 2) {
                keyText.fixedSize(horizontal: false, vertical: true)
                nameText.fixedSize(horizontal: false, vertical: true)
                if !line.isEmpty { source(line) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                keyText.lineLimit(1).frame(width: FieldRow.labelColumn, alignment: .leading)
                nameText.lineLimit(1).truncationMode(.middle).layoutPriority(2)
                Spacer(minLength: Cockpit.Space.s3)
                if !line.isEmpty { inRoom(line).layoutPriority(1) }
            }
        }
    }

    private func source(_ words: String) -> some View {
        Text(words).cockpit(.subhead).foregroundStyle(Cockpit.Color.textTertiary).lineLimit(1)
    }

    private func inRoom(_ line: String) -> some View {
        let parts = line.components(separatedBy: " · ")
        return ViewThatFits(in: .horizontal) {
            ForEach((1...parts.count).reversed(), id: \.self) { count in
                source(parts.prefix(count).joined(separator: " · ")).fixedSize()
            }
            Color.clear.frame(width: 0, height: 0)
        }
    }
}

struct AddMark: View {
    let on: Bool

    var body: some View {
        if on {
            Tick(on: true)
        } else {
            Text("Add")
                .cockpit(.subhead)
                .fontWeight(.semibold)
                .foregroundStyle(Cockpit.Color.text)
                .padding(.horizontal, Cockpit.Space.s3)
                .frame(height: 28)
                .background(Capsule().fill(Cockpit.Color.pressed))
        }
    }
}

private struct AnswerIcon: View {
    let icon: Cockpit.Icon
    let lit: Bool
    @Environment(\.cockpitPlatform) private var platform
    @ScaledMetric(relativeTo: .subheadline) private var slot: CGFloat = 24

    var body: some View {
        Icon(icon, size: platform == .ios ? .md : .sm)
            .foregroundStyle(lit ? Cockpit.Color.textSecondary : Cockpit.Color.textTertiary)
            .frame(width: slot)
    }
}

struct ReturnKey: View {
    var body: some View {
        Text("⏎")
            .cockpit(.subhead)
            .fontWeight(.medium)
            .foregroundStyle(Cockpit.Color.text.opacity(0.6))
            .accessibilityHidden(true)
    }
}

struct NameRowLabel<Lead: View, End: View>: View {
    let name: String
    let line: String
    let lit: Bool
    var card = false
    var quiet = false
    var added = false
    @ViewBuilder let lead: Lead
    @ViewBuilder let end: End
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        HStack(spacing: platform == .ios ? (card ? Cockpit.Space.s1 : Cockpit.Space.s4) : card ? Cockpit.Space.s3 : 10) {
            lead.opacity(enabled ? 1 : Cockpit.Opacity.disabled)
            VStack(alignment: .leading, spacing: card ? 1 : 2) {
                Text(name)
                    .cockpit(.rowTitle)
                    .foregroundStyle((quiet && !lit) || !enabled ? Cockpit.Color.textSecondary : Cockpit.Color.text)
                    .cockpitLines(1)
                Text(line)
                    .cockpit(.subhead)
                    .foregroundStyle(added || !enabled ? Cockpit.Color.textTertiary : Cockpit.Color.textSecondary)
                    .cockpitLines(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            end.opacity(enabled ? 1 : Cockpit.Opacity.disabled)
        }
        .padding(.leading, card ? (platform == .ios ? Cockpit.Space.s3 : Cockpit.Space.s4) : platform == .ios ? Cockpit.Space.s4 : 10)
        .padding(.trailing, card ? Cockpit.Space.s3 : Cockpit.Space.s4)
        .padding(.vertical, Cockpit.Space.s2)
        .frame(maxWidth: .infinity, minHeight: NameRow.height(platform), alignment: .leading)
    }
}

private struct NameRowChrome<Label: View>: View {
    let label: Label
    let lit: Bool
    let card: Bool
    let highlight: RowHighlight?
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.cockpitRowInCard) private var inCard
    @Environment(\.cockpitInSheet) private var inSheet

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: inCard ? 0 : Cockpit.Radius.sm, style: .continuous)
        label
            .background {
                ZStack {
                    if platform == .ios, !inCard { shape.fill(inSheet ? Cockpit.Color.raised : Cockpit.Color.surface) }
                    if lit { shape.fill(Cockpit.Color.selection) }
                    if let highlight { shape.fill(RowChrome<EmptyView>.color(highlight)) }
                }
                .animation(.easeOut(duration: Cockpit.Duration.instant), value: highlight)
            }
            .overlay {
                if lit || platform == .mac {
                    shape.strokeBorder(lit ? Cockpit.Color.text.opacity(contrast == .increased ? 0.5 : 0.24) : Cockpit.Color.border,
                                       lineWidth: Cockpit.Stroke.border)
                }
            }
            .overlay { if !card { FocusRing(radius: Cockpit.Radius.sm) } }
            .contentShape(shape)
    }
}
