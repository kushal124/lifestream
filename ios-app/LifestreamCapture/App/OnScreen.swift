import SwiftUI

private struct RepeatWhileActive: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    let interval: Duration
    let action: @MainActor () async -> Void

    func body(content: Content) -> some View {
        content.task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await action()
                try? await Task.sleep(for: interval)
            }
        }
    }
}

extension View {
    func repeatWhileActive(every interval: Duration, _ action: @escaping @MainActor () async -> Void) -> some View {
        modifier(RepeatWhileActive(interval: interval, action: action))
    }
}

@MainActor
final class OnScreen {
    fileprivate(set) var shown = false
}

extension View {
    func tracked(_ onScreen: OnScreen) -> some View {
        onAppear { onScreen.shown = true }.onDisappear { onScreen.shown = false }
    }
}
