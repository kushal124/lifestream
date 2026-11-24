#if os(macOS)
import AppKit
import Cockpit

MainActor.assumeIsolated {
    _ = NSApplication.shared
    NSApplication.shared.setActivationPolicy(.prohibited)
    IncreaseContrast.install()
    let folder = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent(".build/shots")
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let wanted = Set(CommandLine.arguments.dropFirst())
    for sheet in Sheets.all where wanted.isEmpty || wanted.contains(sheet.name) {
        for platform in sheet.platforms {
            do { try Renderer.write(sheet, platform: platform, to: folder) } catch { print("cockpit-gallery: \(sheet.name): \(error)") }
        }
        print("cockpit-gallery: \(sheet.name)")
    }
    print("cockpit-gallery: wrote \(folder.path)")
}
#else
print("cockpit-gallery draws on macOS only.")
#endif
