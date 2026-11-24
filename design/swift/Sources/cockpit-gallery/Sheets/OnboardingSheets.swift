#if os(macOS)
import AppKit
import CoreText
import SwiftUI
@testable import Cockpit


@MainActor let dragPanelSheet = Sheet("drag-panel", mac: 320, platforms: [.mac]) {
    Specimen("Screen Recording, beside its pane") {
        withGeist(DragPanelFace(title: "Turn on Screen Recording for Lifestream", steps: grantSteps,
                            after: "When macOS asks, choose **Quit & Reopen**. Lifestream comes back right here.",
                            icon: mark, name: "Lifestream"))
    }
    Specimen("Full Disk Access, beside its pane") {
        withGeist(DragPanelFace(title: "Turn on Full Disk Access for Lifestream", steps: grantSteps,
                            after: "If macOS offers to quit Lifestream, choose **Later**.",
                            icon: mark, name: "Lifestream"))
    }
}

private let grantSteps = ["Find **Lifestream** in this list.", "Turn on its switch."]

@MainActor private var mark: Image {
    let renderer = ImageRenderer(content: LogoMark(side: 26).environment(\.colorScheme, .dark))
    renderer.scale = 2
    return renderer.nsImage.map(Image.init(nsImage:)) ?? Image(systemName: "app.fill")
}

@MainActor private func withGeist<V: View>(_ face: V) -> V {
    _ = Geist.registered
    return face
}

private enum Geist {
    static let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("river/geist.woff2")
    static let registered: Bool = CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil)
}

@MainActor let openRouterKeySheet = Sheet("openrouter-key", ios: 390, mac: 760, hosted: true) {
    Specimen("Empty") { openRouterCard("") }
    Specimen("A key typed") { openRouterCard("sk-or-example-0000") }
}

@MainActor private func openRouterCard(_ key: String) -> some View {
    Card {
        VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
            Text("Use an OpenRouter key").cockpit(.headline).foregroundStyle(Cockpit.Color.text)
            Text("Pay for each question from your own OpenRouter account.")
                .cockpit(.body)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            SecureKey(key: key)
        }
    }
}

private struct SecureKey: View {
    let key: String
    var body: some View {
        Field("OpenRouter key", text: .constant(key.isEmpty ? "" : String(repeating: "•", count: key.count)), placeholder: "sk-or-…")
    }
}
#endif
