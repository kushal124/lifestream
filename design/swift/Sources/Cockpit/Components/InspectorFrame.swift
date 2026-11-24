import SwiftUI

public struct InspectorFrame<Content: View, Foot: View>: View {
    let title: String
    let icon: Cockpit.Icon
    let when: String
    let place: String?
    let source: String?
    let links: [InspectorLink]
    let out: InspectorOut?
    let record: SourceFold?
    let close: (() -> Void)?
    let reading: Bool
    let identifier: String?
    let content: Content
    let foot: Foot
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.openURL) private var openURL

    public init(_ title: String, icon: Cockpit.Icon, when: String, where place: String? = nil, source: String? = nil,
                links: [InspectorLink] = [], out: InspectorOut? = nil, record: SourceFold? = nil, close: (() -> Void)? = nil,
                reading: Bool = false, identifier: String? = "inspector.head", @ViewBuilder content: () -> Content,
                @ViewBuilder foot: () -> Foot) {
        self.title = title
        self.icon = icon
        self.when = when
        self.place = place
        self.source = source
        self.links = links
        self.out = out
        self.record = record
        self.close = close
        self.reading = reading
        self.identifier = identifier
        self.content = content()
        self.foot = foot()
    }

    public var body: some View {
        if platform == .mac {
            let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous)
            scroll
                .frame(width: 360)
                .background(shape.fill(Cockpit.Color.surface))
                .clipShape(shape)
                .cockpitShadow(Cockpit.Shadow.edge, in: shape)
        } else {
            drawer
        }
    }

    private var drawer: some View {
        let placed = links.contains { $0.icon == .place }
        let free = place.flatMap { placed ? nil : $0 }
        let count = links.count + (free == nil ? 0 : 1)
        return Drawer(title, facts: [when, source ?? ""].filter { !$0.isEmpty }.joined(separator: " · "),
                      reading: reading, identifier: identifier) {
            content
            if count > 0 || out != nil {
                Card(group: true) {
                    KeyValueRows {
                        ForEach(Array(links.enumerated()), id: \.offset) { index, link in
                            KeyValueRow(key(link), link.title, separator: index + 1 < count || out != nil, action: link.action)
                                .accessibilityIdentifier(link.icon == .place ? "inspector.place" : "inspector.link")
                        }
                        if let free {
                            KeyValueRow("Where", free, separator: out != nil).accessibilityIdentifier("inspector.place")
                        }
                    }
                    if let out {
                        OutRow(out.label, separator: false) { openURL(out.url) }
                            .accessibilityIdentifier("inspector.out")
                    }
                }
                .layoutValue(key: SheetStack.Labelled.self, value: true)
            }
        } foot: {
            foot
        }
    }

    private func key(_ link: InspectorLink) -> String {
        if link.title == title { return "Open" }
        return switch link.icon {
        case .place: "Where"
        case .days: "When"
        default: "Open"
        }
    }

    private var scroll: some View {
        let mac = platform == .mac
        return ScrollView {
            VStack(alignment: .leading, spacing: Cockpit.Space.s6) {
                header
                content
                if let record {
                    record
                }
                foot
            }
            .padding(platform.cardPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .overlay(alignment: .topTrailing) {
            if let close {
                IconButton(.close, label: "Close", style: .raised, size: .small, action: close)
                .padding(mac ? Cockpit.Space.s3 : Cockpit.Space.s4)
            }
        }
    }

    private var header: some View {
        let mac = platform == .mac
        let tile = mac ? Cockpit.Size.controlSm : Cockpit.Size.target
        let meta = [when, source ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
        let placed = links.contains { $0.icon == .place }
        return VStack(alignment: .leading, spacing: mac ? Cockpit.Space.s3 : Cockpit.Space.s4) {
            HStack(alignment: .center, spacing: Cockpit.Space.s3) {
                IconTile(icon, side: tile, radius: Cockpit.Radius.xs)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .cockpit(.title2)
                        .foregroundStyle(Cockpit.Color.text)
                        .cockpitLines(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    if !meta.isEmpty {
                        Text(meta)
                            .cockpit(.subhead)
                            .monospacedDigit()
                            .foregroundStyle(Cockpit.Color.textSecondary)
                            .cockpitLines(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, close == nil ? 0 : (mac ? Cockpit.Size.controlMac : Cockpit.Size.controlSm))
            }
            .reading(reading)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(identifier ?? "")
            if !links.isEmpty || out != nil || (place != nil && !placed) {
                FlowLayout(spacing: Cockpit.Space.s2, lineSpacing: Cockpit.Space.s2) {
                    linkButtons
                    if let place, !placed {
                        QuietChip(icon: .place, title: place, opens: false, platform: platform)
                            .accessibilityIdentifier("inspector.place")
                    }
                    outLink
                }
                .padding(.leading, tile + Cockpit.Space.s3)
            }
        }
    }

    @ViewBuilder private var outLink: some View {
        if let out {
            Link(destination: out.url) {
                HStack(spacing: Cockpit.Space.s1) {
                    Text(out.label).cockpit(.footnote).lineLimit(1)
                    Icon(.openOut, size: .xs).foregroundStyle(Cockpit.Color.textTertiary)
                }
                .foregroundStyle(Cockpit.Color.textSecondary)
                .padding(.horizontal, platform == .mac ? Cockpit.Space.s1 : Cockpit.Space.s2)
                .frame(minHeight: platform == .mac ? 24 : Cockpit.Size.controlSm)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .hitArea(platform)
            .accessibilityIdentifier("inspector.out")
        }
    }

    private var linkButtons: some View {
        ForEach(Array(links.enumerated()), id: \.offset) { _, link in
            Button(action: link.action) {
                QuietChip(icon: link.icon, title: link.title, opens: true, platform: platform)
            }
            .buttonStyle(QuietLinkStyle(platform: platform))
            .accessibilityIdentifier(link.icon == .place ? "inspector.place" : "inspector.link")
        }
    }
}

struct PressedDim: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.6 : 1)
    }
}

private struct QuietChip: View {
    let icon: Cockpit.Icon
    let title: String
    let opens: Bool
    let platform: Cockpit.Platform

    var body: some View {
        HStack(alignment: .center, spacing: Cockpit.Space.s1) {
            Icon(icon, size: platform == .mac ? .xs : .sm)
            Text(title).cockpit(.footnote).lineLimit(2).multilineTextAlignment(.leading)
            if opens { Icon(.forward, size: .xs).foregroundStyle(Cockpit.Color.textTertiary) }
        }
        .foregroundStyle(Cockpit.Color.textSecondary)
        .padding(.horizontal, opens ? 0 : (platform == .mac ? Cockpit.Space.s2 : Cockpit.Space.s3))
        .padding(.vertical, opens ? 0 : (platform == .mac ? 3 : 6))
        .background {
            if !opens {
                if platform == .ios {
                    Capsule().fill(Cockpit.Color.raised)
                } else {
                    RoundedRectangle(cornerRadius: Cockpit.Radius.control, style: .continuous)
                        .strokeBorder(Cockpit.Color.border, lineWidth: Cockpit.Stroke.border)
                }
            }
        }
    }
}

public struct InspectorOut {
    let label: String
    let url: URL

    public init(_ label: String, url: URL) {
        self.label = label
        self.url = url
    }
}

public struct InspectorLink {
    let icon: Cockpit.Icon
    let title: String
    let action: () -> Void

    public init(_ icon: Cockpit.Icon, _ title: String, action: @escaping () -> Void) {
        self.icon = icon
        self.title = title
        self.action = action
    }
}

private struct QuietLinkStyle: ButtonStyle {
    let platform: Cockpit.Platform
    func makeBody(configuration: Configuration) -> some View {
        QuietLinkBody(configuration: configuration, platform: platform)
    }
}

private struct QuietLinkBody: View {
    let configuration: ButtonStyleConfiguration
    let platform: Cockpit.Platform
    @State private var hovering = false
    var body: some View {
        configuration.label
            .padding(.horizontal, platform == .mac ? Cockpit.Space.s2 : Cockpit.Space.s3)
            .padding(.vertical, platform == .mac ? 3 : 6)
            .background {
                let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.control, style: .continuous)
                shape.fill(Cockpit.Color.raised)
                if configuration.isPressed {
                    shape.fill(Cockpit.Color.pressed)
                } else if hovering && platform == .mac {
                    shape.fill(Cockpit.Color.hover)
                }
            }
            .hitArea(platform)
            .onHover { hovering = $0 }
    }
}

public struct SourceFold: View {
    let source: String
    let kind: String
    let key: String
    let time: String
    let unit: String?
    let tree: JSONTree
    var unfolded = false
    @State private var open: Bool?
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(source: String, kind: String, key: String, time: String, unit: String? = nil, json: Data) {
        self.source = source
        self.kind = kind
        self.key = key
        self.time = time
        self.unit = unit
        self.tree = JSONTree(json)
    }

    private var isOpen: Bool { open ?? unfolded }

    public var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
            Button {
                withAnimation(reduceMotion ? .easeInOut(duration: Cockpit.Duration.fast) : Cockpit.Ease.spring()) { open = !isOpen }
            } label: {
                HStack(spacing: Cockpit.Space.s2) {
                    Text("Source").cockpit(platform == .ios ? .body : .monoLabel)
                    Spacer(minLength: 0)
                    Icon(isOpen ? .collapse : .expand, size: .xs).padding(.trailing, platform == .ios ? -1.7 : 0)
                }
                .foregroundStyle(platform == .ios ? Cockpit.Color.textSecondary : Cockpit.Color.textTertiary)
                .frame(minHeight: platform == .ios ? platform.rowHeight : platform.hitSize)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(isOpen ? "Open" : "Folded")
            .overlay(alignment: .top) {
                Rectangle().fill(Cockpit.Color.rule).frame(height: platform.ruleHeight).accessibilityHidden(true)
            }
            if isOpen {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: Cockpit.Space.s3, verticalSpacing: Cockpit.Space.s1) {
                    field("Source", source)
                    field("Kind", kind)
                    field("Key", key)
                    field("Time", time)
                    if let unit { field("Unit", unit) }
                }
                tree
                    .padding(.top, Cockpit.Space.s2)
            }
        }
    }

    private func field(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label)
                .cockpit(.caption)
                .foregroundStyle(Cockpit.Color.textTertiary)
            Text(value)
                .cockpit(.monoData)
                .foregroundStyle(Cockpit.Color.text)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
}

public extension InspectorFrame where Foot == EmptyView {
    init(_ title: String, icon: Cockpit.Icon, when: String, where place: String? = nil, source: String? = nil,
         links: [InspectorLink] = [], out: InspectorOut? = nil, record: SourceFold? = nil, close: (() -> Void)? = nil,
         reading: Bool = false, identifier: String? = "inspector.head", @ViewBuilder content: () -> Content) {
        self.init(title, icon: icon, when: when, where: place, source: source, links: links, out: out, record: record, close: close,
                  reading: reading, identifier: identifier, content: content, foot: { EmptyView() })
    }
}
