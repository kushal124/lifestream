import SwiftUI

extension Cockpit {
    struct Pressable<Face: View>: ButtonStyle {
        var selected = false
        var forced: RowHighlight?
        let face: @MainActor (ButtonStyleConfiguration.Label, RowHighlight?) -> Face

        func makeBody(configuration: Configuration) -> some View {
            PressableBody(configuration: configuration, selected: selected, forced: forced, face: face)
        }
    }
}

extension Cockpit.Pressable where Face == RowChrome<ButtonStyleConfiguration.Label> {
    static func row(_ platform: Cockpit.Platform, selected: Bool = false, forced: RowHighlight?) -> Self {
        Self(selected: selected, forced: forced) { label, state in RowChrome(radius: platform.rowRadius, highlight: state) { label } }
    }
}

extension RowHighlight {
    static func touched(_ platform: Cockpit.Platform) -> RowHighlight { platform == .mac ? .hover : .pressed }
}

private struct PressableBody<Face: View>: View {
    let configuration: ButtonStyleConfiguration
    let selected: Bool
    let forced: RowHighlight?
    let face: @MainActor (ButtonStyleConfiguration.Label, RowHighlight?) -> Face
    @State private var hovering = false
    @Environment(\.cockpitPlatform) private var platform

    var body: some View {
        let live: RowHighlight? = selected ? .selected : configuration.isPressed ? .pressed : hovering && platform == .mac ? .hover : nil
        face(configuration.label, forced ?? live)
            .onHover { hovering = $0 }
    }
}
