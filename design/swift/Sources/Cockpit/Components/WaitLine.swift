import SwiftUI

public struct WaitLine: View {
    let words: String?
    var forced = false
    @Environment(\.readingWaited) private var waited
    @Environment(\.reachLacks) private var lacks

    public init(words: String? = nil) {
        self.words = words
    }

    public var body: some View {
        if (waited != nil || forced) && !lacks {
            Text(words ?? "Waiting for Lifestream.")
                .cockpit(.body)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, Cockpit.Space.s3)
                .opacity(waited == true || forced ? 1 : 0)
                .unredacted()
                .accessibilityHidden(true)
        }
    }
}

public extension View {
    func waiting(_ active: Bool) -> some View {
        modifier(Waiting(active: active))
    }
}

struct Waiting: ViewModifier {
    let active: Bool
    @State private var waited = false

    func body(content: Content) -> some View {
        content
            .transformEnvironment(\.readingWaited) { if active { $0 = waited } }
            .task(id: active) {
                waited = false
                guard active else { return }
                try? await Task.sleep(for: .seconds(Cockpit.Duration.patience))
                guard !Task.isCancelled else { return }
                withAnimation(.easeOut(duration: Cockpit.Duration.fast)) { waited = true }
            }
    }
}

extension EnvironmentValues {
    @Entry var readingWaited: Bool?
}
