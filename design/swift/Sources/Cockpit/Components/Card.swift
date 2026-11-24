import SwiftUI

public struct Card<Content: View>: View {
    let label: String?
    let count: Int?
    let open: (() -> Void)?
    let action: String?
    let perform: (() -> Void)?
    let flush: Bool
    let group: Bool
    let flat: Bool
    let content: Content
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast

    public init(_ label: String? = nil, count: Int? = nil, open: (() -> Void)? = nil, action: String? = nil, perform: (() -> Void)? = nil,
                flush: Bool = false, group: Bool = false, flat: Bool = false, @ViewBuilder content: () -> Content) {
        self.label = label
        self.count = count
        self.open = open
        self.action = action
        self.perform = perform
        self.flush = flush || group
        self.group = group
        self.flat = flat
        self.content = content()
    }

    @Environment(\.cockpitInSheet) private var inSheet

    public var body: some View {
        if platform == .ios { phone } else if group { panel } else { card }
    }

    private var phone: some View {
        VStack(alignment: .leading, spacing: flat ? 0 : Cockpit.Space.s3) {
            if let label { SectionLabel(label, count: count, action: action, perform: perform, open: open) }
            if flat {
                VStack(alignment: .leading, spacing: 0) { content }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, -platform.rowInset)
                    .environment(\.cockpitRowsFlat, true)
            } else {
                VStack(alignment: .leading, spacing: group || flush ? 0 : Cockpit.Space.s3) { content }
                    .padding(group || flush ? 0 : platform.cardPadding)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: platform.cardRadius, style: .continuous)
                        .fill(inSheet ? Cockpit.Color.raised : Cockpit.Color.surface))
                    .clipShape(RoundedRectangle(cornerRadius: platform.cardRadius, style: .continuous))
                    .environment(\.cockpitOnRaised, inSheet)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var card: some View {
        let shape = RoundedRectangle(cornerRadius: platform.cardRadius, style: .continuous)
        return VStack(alignment: .leading, spacing: flush ? 0 : Cockpit.Space.s3) {
            if let label {
                SectionLabel(label, count: count, action: action, perform: perform, open: open)
                    .padding(.horizontal, flush ? platform.cardPadding - inset : 0)
                    .padding(.top, flush ? platform.cardPadding - inset : 0)
                    .padding(.bottom, flush ? Cockpit.Space.s1 : 0)
            }
            content
        }
        .padding(flush ? inset : platform.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(shape.fill(Cockpit.Color.surface))
        .clipShape(shape)
        .cockpitShadow(Cockpit.Shadow.edge, in: shape)
    }

    private var panel: some View {
        let shape = RoundedRectangle(cornerRadius: platform.cardRadius, style: .continuous)
        return VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
            if let label { SectionLabel(label, count: count, action: action, perform: perform, open: open) }
            VStack(alignment: .leading, spacing: 0) { content }
                .padding(inset)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(shape.fill(scheme == .dark ? Color.clear : Cockpit.Color.surface))
                .clipShape(shape)
                .overlay {
                    shape.strokeBorder(contrast == .increased ? Cockpit.Color.border : Cockpit.Color.rule, lineWidth: Cockpit.Stroke.border)
                }
        }
    }

    private var inset: CGFloat { platform == .ios ? 0 : Cockpit.Space.s2 }
}

extension EnvironmentValues {
    @Entry public var cockpitInSheet = false
    @Entry public var cockpitHeadStrong = false
    @Entry public var cockpitBarCovered = false
    @Entry public var cockpitButtonHeight: CGFloat?
    @Entry public var cockpitOnRaised = false
    @Entry public var cockpitRowsFlat = false
    @Entry public var cockpitRowsFaces: CGFloat?
    @Entry public var cockpitRowsClose = false
    @Entry public var cockpitSheetScale: CGFloat = 1
}

public extension View {
    func cockpitSheet() -> some View { environment(\.cockpitInSheet, true).environment(\.cockpitRowsClose, true) }

    func groundColor(_ color: Color) -> some View { background { color.ignoresSafeArea() } }
}

