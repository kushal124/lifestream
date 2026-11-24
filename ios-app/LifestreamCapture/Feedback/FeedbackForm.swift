import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit

@MainActor enum FeedbackDesk {
    static let page = PageReading<HomeLink.Pages.Feedback>(HomeLink.PageKey(HomeLink.Pages.Feedback.route))
    static var typed: [HomeLink.Feedback.About: FeedbackForm.Typed] = [:]
}

struct FeedbackOpening: Identifiable {
    let id = UUID()
    let about: HomeLink.Feedback.About
    let name: String?
    let shot: FeedbackShot?

    @MainActor static func take(_ about: HomeLink.Feedback.About, name: String? = nil) -> FeedbackOpening {
        FeedbackOpening(about: about, name: name, shot: FeedbackShot.take())
    }
}

struct FeedbackShot {
    let image: UIImage
    let jpeg: Data

    static let longest: CGFloat = 2880
    static let most = 4 * 1024 * 1024
    static let quality: CGFloat = 0.85

    @MainActor static func take() -> FeedbackShot? {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else { return nil }
        let bounds = window.bounds
        let side = max(bounds.width, bounds.height)
        guard side > 0 else { return nil }
        var scale = min(window.traitCollection.displayScale, longest / side)
        while scale * side >= 320 {
            let format = UIGraphicsImageRendererFormat()
            format.scale = scale
            format.opaque = true
            let image = UIGraphicsImageRenderer(bounds: bounds, format: format).image { _ in
                window.drawHierarchy(in: bounds, afterScreenUpdates: true)
            }
            if let jpeg = image.jpegData(compressionQuality: quality), jpeg.count <= most { return FeedbackShot(image: image, jpeg: jpeg) }
            scale *= 0.8
        }
        return nil
    }
}

@MainActor final class FeedbackForm: ObservableObject {
    struct Typed {
        let text: String
        let email: String
    }

    struct Thanks: Identifiable, Equatable {
        let id = UUID()
        let title: String
        let line: String?
    }

    let about: HomeLink.Feedback.About
    let name: String?
    let shot: FeedbackShot?
    @Published var text: String
    @Published var email: String
    @Published private(set) var draft: HomeLink.Pages.FeedbackDraft?
    @Published private(set) var kept: [HomeLink.Pages.FeedbackKind] = []
    @Published private(set) var shotAdded = false
    @Published private(set) var again = false
    private(set) var id = HomeLink.Feedback.mint()
    private var shotHeld: String?
    private var emailTyped: Bool
    private var drafting: Task<Void, Never>?
    private var sent = false

    init(_ opening: FeedbackOpening) {
        about = opening.about
        name = opening.name
        shot = opening.shot
        let typed = FeedbackDesk.typed[opening.about]
        text = typed?.text ?? ""
        email = typed?.email ?? ""
        emailTyped = !(typed?.email ?? "").isEmpty
    }

    var attachments: [HomeLink.Pages.FeedbackAttachment] {
        (draft?.attachments ?? []).filter { kept.contains($0.kind) }
    }

    var sendable: Bool { Self.sends(text) }

    static func sends(_ text: String) -> Bool {
        text.contains { !$0.isWhitespace }
    }

    static func filled(_ words: String, name: String?) -> String {
        words.replacingOccurrences(of: "{name}", with: name ?? "")
    }

    private var link: HomeLink { AppRuntime.shared.shipping.link }

    func title(_ page: HomeLink.Pages.Feedback) -> String {
        switch about {
        case .menu: page.title
        case .chat: page.about.chat
        case .connector: Self.filled(page.about.connector, name: name)
        }
    }

    func thanks(_ page: HomeLink.Pages.Feedback) -> Thanks {
        let reply = Self.trimmed(email)
        return Thanks(title: page.sent.title, line: reply.flatMap { email in page.sent.line?.replacingOccurrences(of: "{email}", with: email) })
    }

    func open() {
        guard draft == nil, drafting == nil else { return }
        drafting = Task { await self.makeDraft() }
    }

    func typedEmail(_ value: String) {
        email = value
        emailTyped = true
    }

    func remove(_ kind: HomeLink.Pages.FeedbackKind) {
        kept.removeAll { $0 == kind }
    }

    func addShot() {
        guard shot != nil else { return }
        shotAdded = true
        Task { _ = try? await self.holdShot() }
    }

    func removeShot() {
        shotAdded = false
    }

    func clear() {
        text = ""
        email = ""
        emailTyped = true
        FeedbackDesk.typed[about] = nil
    }

    func leave() {
        drafting?.cancel()
        guard !sent else { return }
        FeedbackDesk.typed[about] = Self.sends(text) || !email.isEmpty ? Typed(text: text, email: email) : nil
    }

    func send() async throws -> SheetEdit.Kept {
        guard sendable else { return .stay }
        if let drafting { await drafting.value }
        guard draft != nil else {
            try await draftAgain(fresh: false)
            return .stay
        }
        if shotAdded, !(try await holdShot()) {
            try await draftAgain(fresh: true)
            return .stay
        }
        let kinds = kept + (shotAdded ? [.screenshot] : [])
        do {
            switch try await link.feedbackSend(id: id, text: text, email: Self.trimmed(email), keep: kinds) {
            case .sent:
                sent = true
                FeedbackDesk.typed[about] = nil
                return .close
            case .forgotten:
                try await draftAgain(fresh: true)
                return .stay
            }
        } catch {
            throw SheetEdit.Failed(InPlaceLine.Said(HomeLink.ActSaid(error)))
        }
    }

    private func makeDraft() async {
        let asked = id
        guard let made = try? await link.feedbackDraft(id: asked, about: about), asked == id, !Task.isCancelled else {
            drafting = nil
            return
        }
        take(made)
        drafting = nil
    }

    private func take(_ made: HomeLink.Pages.FeedbackDraft) {
        draft = made
        kept = made.attachments.map(\.kind)
        if !emailTyped, email.isEmpty, let given = made.email { email = given }
    }

    private func draftAgain(fresh: Bool) async throws {
        if fresh {
            id = HomeLink.Feedback.mint()
            shotHeld = nil
        }
        do {
            take(try await link.feedbackDraft(id: id, about: about))
            again = true
        } catch {
            throw SheetEdit.Failed(InPlaceLine.Said(HomeLink.ActSaid(error)))
        }
    }

    private func holdShot() async throws -> Bool {
        guard let shot, shotHeld != id else { return true }
        if draft == nil, let drafting { await drafting.value }
        let asked = id
        do {
            guard case .held = try await link.feedbackScreenshot(id: asked, jpeg: shot.jpeg) else { return false }
            if asked == id { shotHeld = asked }
            return true
        } catch {
            throw SheetEdit.Failed(InPlaceLine.Said(HomeLink.ActSaid(error)))
        }
    }

    static func trimmed(_ email: String) -> String? {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
