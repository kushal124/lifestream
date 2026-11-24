import SwiftUI

public struct Callout: View {
    public struct Act {
        let label: String
        let id: String
        let busy: Bool
        let words: Bool
        let perform: () -> Void

        public init(_ label: String, id: String = "", busy: Bool = false, words: Bool = false, perform: @escaping () -> Void = {}) {
            self.label = label
            self.id = id
            self.busy = busy
            self.words = words
            self.perform = perform
        }
    }

    let title: String
    let detail: String?
    let steps: [String]
    let signal: Cockpit.SignalKind?
    let acts: [Act]
    let primary: Bool
    let identifier: String?
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.cockpitInSheet) private var inSheet

    public init(_ title: String, detail: String? = nil, steps: [String] = [], signal: Cockpit.SignalKind? = nil,
                action: String? = nil, primary: Bool = false, busy: Bool = false, identifier: String? = nil,
                perform: @escaping () -> Void = {}) {
        self.init(title, detail: detail, steps: steps, signal: signal, acts: action.map { [Act($0, busy: busy, perform: perform)] } ?? [],
                  primary: primary, identifier: identifier)
    }

    public init(_ title: String, detail: String? = nil, steps: [String] = [], signal: Cockpit.SignalKind? = nil, acts: [Act],
                primary: Bool = false, identifier: String? = nil) {
        self.title = title
        self.detail = detail
        self.steps = steps
        self.signal = signal
        self.acts = acts
        self.primary = primary
        self.identifier = identifier
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: platform.cardRadius, style: .continuous)
        ViewThatFits(in: .horizontal) {
            if acts.count < 2 {
                HStack(alignment: .center, spacing: Cockpit.Space.s3) {
                    words.frame(maxWidth: .infinity, alignment: .leading)
                    act
                }
            }
            VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                words.frame(maxWidth: .infinity, alignment: .leading)
                act
            }
        }
        .padding(.horizontal, platform == .ios ? platform.rowInset : Cockpit.Space.s3)
        .padding(.vertical, Cockpit.Space.s3)
        .frame(minHeight: platform == .ios ? platform.rowHeight : nil)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { if platform == .ios { shape.fill(inSheet ? Cockpit.Color.raised : Cockpit.Color.surface) } }
        .environment(\.cockpitOnRaised, inSheet)
        .overlay {
            if platform == .mac {
                shape.strokeBorder(contrast == .increased ? Cockpit.Color.border : Cockpit.Color.rule, lineWidth: Cockpit.Stroke.border)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var words: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
                if let signal {
                    SignalShape(signal, size: platform == .ios ? 14 : 12)
                        .frame(width: platform == .ios && inSheet ? Cockpit.Space.s6 : nil)
                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + (platform == .ios ? 6 : 4.5) }
                }
                Text(title)
                    .cockpit(platform == .ios ? .body : .headline)
                    .foregroundStyle(platform == .mac ? signal.map { [.caution, .warning].contains($0) ? $0.color : Cockpit.Color.text } ?? Cockpit.Color.text : Cockpit.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let detail {
                Text(detail)
                    .cockpit(platform == .ios ? .subhead : .body)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !steps.isEmpty {
                VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                        HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s3) {
                            Text("\(index + 1)")
                                .cockpit(.monoData)
                                .foregroundStyle(Cockpit.Color.textTertiary)
                            Text(step)
                                .cockpit(.body)
                                .foregroundStyle(Cockpit.Color.text)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.top, Cockpit.Space.s2)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier ?? "")
    }

    @ViewBuilder private var act: some View {
        if !acts.isEmpty {
            let buttons = acts.filter { !$0.words }
            HStack(spacing: Cockpit.Space.s2) {
                ForEach(Array(buttons.enumerated()), id: \.offset) { index, act in
                    let choice = buttons.count > 1
                    Button(act.label, action: act.perform)
                        .buttonStyle(.cockpit((choice ? index == 0 : primary) ? .primary : .secondary, size: .small, busy: act.busy))
                        .accessibilityIdentifier(identifier.map { choice ? "\($0).act.\(act.id)" : "\($0).act" } ?? "")
                }
                ForEach(Array(acts.filter(\.words).enumerated()), id: \.offset) { _, act in
                    Button(act.label, action: act.perform)
                        .buttonStyle(.cockpit(.plain, size: .small))
                        .accessibilityIdentifier(identifier.map { "\($0).act.\(act.id)" } ?? "")
                }
            }
        }
    }
}
