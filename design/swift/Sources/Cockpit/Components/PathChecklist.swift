import SwiftUI

public struct PathChecklist: View {
    public struct Link: Identifiable {
        public enum State: Sendable, Equatable { case passed, failed, unchecked }

        public let id: String
        let name: String
        let state: State
        let value: String
        let fix: String?
        let act: StatusStrip.Act?

        public init(_ id: String, name: String, state: State, value: String, fix: String? = nil, act: StatusStrip.Act? = nil) {
            self.id = id
            self.name = name
            self.state = state
            self.value = value
            self.fix = fix
            self.act = act
        }
    }

    let title: String
    let line: String?
    let links: [Link]
    let retry: StatusStrip.Act
    let close: (() -> Void)?
    let identifier: String
    @Environment(\.cockpitPlatform) private var platform

    public init(_ title: String, line: String? = nil, links: [Link], retry: StatusStrip.Act, close: (() -> Void)? = nil,
                identifier: String = "checklist") {
        self.identifier = identifier
        self.title = title
        self.line = line
        self.links = links
        self.retry = retry
        self.close = close
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: Cockpit.Space.s3) {
                VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
                    Text(title)
                        .cockpit(Cockpit.Style.iosTitle2)
                        .fontWeight(.bold)
                        .foregroundStyle(Cockpit.Color.text)
                        .accessibilityAddTraits(.isHeader)
                    if let line {
                        Text(line).cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                if let close { IconButton(.close, label: "Close", size: .small, action: close).accessibilityIdentifier(identifier + ".close") }
            }
            .padding(.horizontal, Cockpit.Space.s1)
            .padding(.bottom, Cockpit.Space.s4)
            VStack(spacing: 0) {
                ForEach(Array(links.enumerated()), id: \.element.id) { index, link in
                    row(link)
                    if index < links.count - 1 {
                        Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.Stroke.hairline)
                            .padding(.leading, Cockpit.Space.s4)
                    }
                }
            }
            .background { RoundedRectangle(cornerRadius: platform.cardRadius, style: .continuous).fill(Cockpit.Color.raised) }
            Spacer(minLength: Cockpit.Space.s6)
            Button(retry.label, action: retry.perform)
                .buttonStyle(.cockpit(.primary, size: .large, busy: retry.busy, fullWidth: true))
                .accessibilityIdentifier(identifier + ".retry")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private func row(_ link: Link) -> some View {
        HStack(alignment: link.fix == nil ? .center : .top, spacing: Cockpit.Space.s3) {
            mark(link.state)
                .padding(.top, link.fix == nil ? 0 : 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(link.name).cockpit(.body).foregroundStyle(Cockpit.Color.text)
                if let fix = link.fix {
                    Text(fix).cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            if let act = link.act {
                Button(act.label, action: act.perform)
                    .buttonStyle(.cockpit(.secondary, size: .small, busy: act.busy))
                    .environment(\.cockpitOnRaised, true)
            } else {
                Text(link.value)
                    .cockpit(.body)
                    .foregroundStyle(link.state == .failed ? Cockpit.Color.text : Cockpit.Color.textSecondary)
            }
        }
        .padding(.horizontal, Cockpit.Space.s4)
        .padding(.vertical, 14)
        .accessibilityElement(children: .combine)
        .accessibilityLabel([link.name, link.value, link.fix].compactMap { $0 }.joined(separator: ", "))
        .accessibilityIdentifier(identifier + "." + link.id)
    }

    @ViewBuilder private func mark(_ state: Link.State) -> some View {
        let size: CGFloat = 20
        switch state {
        case .passed: SeverityMark(.done, size: size)
        case .failed: SeverityMark(.stopped, size: size)
        case .unchecked:
            Circle().strokeBorder(Cockpit.Color.textTertiary, lineWidth: 1.6)
                .opacity(0.5)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }
}
