import Cockpit
import Foundation
import LifestreamCaptureCore
import OSLog
import SwiftUI
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let status = UIHostingController(rootView: ShareStatus(words: "Sending to Lifestream"))

    override func viewDidLoad() {
        super.viewDidLoad()
        addChild(status)
        status.view.frame = view.bounds
        status.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(status.view)
        status.didMove(toParent: self)
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        Task { @MainActor in
            let kept = await Self.publish(providers)
            status.rootView = ShareStatus(words: Self.words(kept))
            try? await Task.sleep(for: .milliseconds(600))
            extensionContext?.completeRequest(returningItems: nil)
        }
    }

    private static func words(_ kept: (saved: Int, full: Int)) -> String {
        let sent = kept.saved == 0 ? nil : "Sent \(Words.count(kept.saved, "file")) to Lifestream."
        guard kept.full > 0 else { return sent ?? "Nothing here is a file Lifestream can keep." }
        let full = "There isn't room on your iPhone for \(Words.count(kept.full, "file")). Free some space and share again."
        return [sent, full].compactMap { $0 }.joined(separator: " ")
    }

    private static func publish(_ providers: [NSItemProvider]) async -> (saved: Int, full: Int) {
        guard let inbox = UploadInbox.shared(appGroup: AppGroup.identifier) else { return (0, 0) }
        var saved = 0
        var full = 0
        for provider in providers {
            guard let type = fileType(of: provider) else { continue }
            let suggested = provider.suggestedName
            do {
                try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
                    _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                        do {
                            guard let url else { throw error ?? CocoaError(.fileReadUnknown) }
                            try inbox.publish(file: url, name: name(suggested: suggested, file: url, type: type),
                                              mediaType: type.preferredMIMEType ?? "application/octet-stream")
                            done.resume()
                        } catch {
                            done.resume(throwing: error)
                        }
                    }
                }
                saved += 1
            } catch CaptureError.full {
                full += 1
            } catch {
                Logger(subsystem: "org.lifestreamprotocol.phone", category: "share")
                    .error("A shared file could not be kept: \(error.localizedDescription, privacy: .private)")
            }
        }
        return (saved, full)
    }

    private static func fileType(of provider: NSItemProvider) -> UTType? {
        provider.registeredTypeIdentifiers.compactMap(UTType.init)
            .first { $0.conforms(to: .data) && !$0.conforms(to: .url) }
    }

    nonisolated private static func name(suggested: String?, file: URL, type: UTType) -> String {
        guard let suggested, !suggested.isEmpty else { return file.lastPathComponent }
        guard (suggested as NSString).pathExtension.isEmpty, let ext = type.preferredFilenameExtension else { return suggested }
        return "\(suggested).\(ext)"
    }
}

private struct ShareStatus: View {
    let words: String

    var body: some View {
        Text(words)
            .cockpit(.body)
            .foregroundStyle(Cockpit.Color.text)
            .multilineTextAlignment(.center)
            .padding(.horizontal, Cockpit.Space.s6)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .groundColor(Cockpit.Color.surface)
    }
}
