import SwiftUI

public struct TimedRow<Detail: View>: View {
    let time: String
    let title: String
    let said: String?
    let end: String?
    let hidden: String?
    let quiet: Bool
    let fold: Bool
    let open: Bool
    let separator: Bool
    let toggle: (() -> Void)?
    let detail: Detail
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.cockpitRowsFlat) private var rowsFlat
    @Environment(\.cockpitPartsFlat) private var partsFlat
    @Environment(\.inSettingSection) private var inSection

    private var flat: Bool { rowsFlat || partsFlat && inSection }

    public init(_ title: String, said: String? = nil, time: String, end: String? = nil, hidden: String? = nil, quiet: Bool = false,
                fold: Bool = false, open: Bool = false, separator: Bool = true, toggle: (() -> Void)? = nil,
                @ViewBuilder detail: () -> Detail) {
        self.time = time
        self.title = title
        self.said = said
        self.end = end
        self.hidden = hidden
        self.quiet = quiet
        self.fold = fold
        self.open = open
        self.separator = separator
        self.toggle = toggle
        self.detail = detail()
    }

    private var column: CGFloat { platform == .ios ? 56 : 48 }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { toggle?() } label: {
                HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s4) {
                    Text(verbatim: time)
                        .cockpit(.body)
                        .monospacedDigit()
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .frame(width: column, alignment: .leading)
                    words
                        .cockpit(.body)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let hidden {
                        Icon(.hidden, size: .sm, label: hidden)
                            .foregroundStyle(Cockpit.Color.textTertiary)
                    }
                    if let end {
                        Text(verbatim: end)
                            .cockpit(.subhead)
                            .monospacedDigit()
                            .foregroundStyle(Cockpit.Color.textTertiary)
                            .fixedSize()
                    }
                    if fold {
                        Icon(.expand, size: .sm)
                            .foregroundStyle(Cockpit.Color.textTertiary)
                            .rotationEffect(.degrees(open ? 180 : 0))
                    }
                }
                .padding(.vertical, Cockpit.Space.s3)
                .frame(minHeight: platform.rowHeight)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .allowsHitTesting(toggle != nil)
            if open, !fold {
                VStack(alignment: .leading, spacing: Cockpit.Space.s2) { detail }
                    .padding(.leading, column + Cockpit.Space.s4)
                    .padding(.bottom, Cockpit.Space.s4)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, flat ? platform.rowInset : 0)
        .background {
            if open, !fold {
                RoundedRectangle(cornerRadius: Cockpit.Radius.md, style: .continuous)
                    .fill(Cockpit.Color.raised)
                    .padding(.horizontal, flat ? 0 : -Cockpit.Space.s3)
            }
        }
        .overlay(alignment: .bottom) {
            if separator, !open || fold {
                Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.Stroke.border)
                    .padding(.leading, column + Cockpit.Space.s4 + (flat ? platform.rowInset : 0))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(toggle == nil ? [] : .isButton)
    }

    private var words: Text {
        let lead = Text(verbatim: title).foregroundStyle(quiet || said != nil ? Cockpit.Color.textSecondary : Cockpit.Color.text)
        guard let said else { return lead }
        let theirs = Text(verbatim: said).foregroundStyle(Cockpit.Color.text)
        return Text("\(lead) \(theirs)")
    }
}

public extension TimedRow where Detail == EmptyView {
    init(_ title: String, said: String? = nil, time: String, end: String? = nil, hidden: String? = nil, quiet: Bool = false,
         fold: Bool = false, open: Bool = false, separator: Bool = true, toggle: (() -> Void)? = nil) {
        self.init(title, said: said, time: time, end: end, hidden: hidden, quiet: quiet, fold: fold, open: open, separator: separator,
                  toggle: toggle) { EmptyView() }
    }
}

public struct TimedHead: View {
    let title: String
    let line: String?
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.cockpitRowsFlat) private var flat

    public init(_ title: String, line: String? = nil) {
        self.title = title
        self.line = line
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
            Text(verbatim: title).cockpit(.headline).monospacedDigit().foregroundStyle(Cockpit.Color.text)
            if let line { Text(verbatim: line).cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary) }
        }
        .padding(.top, Cockpit.Space.s4)
        .padding(.bottom, Cockpit.Space.s1)
        .padding(.horizontal, flat ? platform.rowInset : 0)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}
