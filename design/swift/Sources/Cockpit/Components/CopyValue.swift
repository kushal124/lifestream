import SwiftUI

public struct CopyValue: View {
    public static let copied: Duration = .milliseconds(1500)

    let value: String?
    let shape: String
    let label: String
    let line: Bool
    let copy: (String) -> Void
    @State private var checked = false
    @State private var resting: Task<Void, Never>?

    public init(_ value: String?, shape: String, label: String, line: Bool = false, copy: @escaping (String) -> Void) {
        self.value = value
        self.shape = shape
        self.label = label
        self.line = line
        self.copy = copy
    }

    public var body: some View {
        HStack(alignment: line ? .firstTextBaseline : .center, spacing: Cockpit.Space.s2) {
            shown
                .foregroundStyle(value == nil ? Cockpit.Color.textTertiary : Cockpit.Color.text)
                .textSelection(.enabled)
                .accessibilityLabel(label)
                .accessibilityValue(value ?? "")
                .accessibilityHidden(value == nil)
            IconButton(checked ? .done : .copy, label: checked ? "Copied" : "Copy \(label.lowercased())", style: .plain) {
                guard let value else { return }
                copy(value)
                checked = true
                AccessibilityNotification.Announcement("Copied").post()
                resting?.cancel()
                resting = Task {
                    try? await Task.sleep(for: Self.copied)
                    guard !Task.isCancelled else { return }
                    checked = false
                }
            }
            .foregroundStyle(checked ? Cockpit.Color.engaged : Cockpit.Color.textSecondary)
            .opacity(value == nil ? 0 : 1)
            .disabled(value == nil)
            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 6 }
        }
    }

    @ViewBuilder private var shown: some View {
        if line {
            Text(value ?? shape)
                .cockpit(.body)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(value ?? shape)
                .font(.system(size: 24, weight: .medium, design: .monospaced))
                .tracking(3)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
    }
}
