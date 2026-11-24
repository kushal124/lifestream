import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit

struct FeedbackSheet: View {
    let page: HomeLink.Pages.Feedback
    let thanked: (FeedbackForm.Thanks) -> Void
    @StateObject private var form: FeedbackForm
    @State private var acts = SheetActs()
    @State private var path: [Pushed] = []
    @FocusState private var focus: Field?

    enum Pushed: Hashable { case see, shot }
    enum Field: Hashable { case text, email }

    init(_ opening: FeedbackOpening, page: HomeLink.Pages.Feedback, thanked: @escaping (FeedbackForm.Thanks) -> Void) {
        self.page = page
        self.thanked = thanked
        _form = StateObject(wrappedValue: FeedbackForm(opening))
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    field
                    chips
                    if form.again {
                        Text(page.again)
                            .cockpit(.footnote)
                            .foregroundStyle(Cockpit.Color.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, Cockpit.Space.s3)
                            .accessibilityIdentifier("feedback.again")
                    }
                    rule.padding(.top, Cockpit.Space.s5)
                    emailRow
                    rule
                    seeRow
                }
                .padding(.horizontal, Cockpit.Gap.sheet)
                .padding(.top, Cockpit.Space.s3)
                .padding(.bottom, Cockpit.Gap.edge)
            }
            .scrollDismissesKeyboard(.interactively)
            .groundColor(Cockpit.Color.surface)
            .cockpitSheet()
            .navigationTitle(form.title(page))
            .navigationBarTitleDisplayMode(.inline)
            .sheetEditBar(SheetEdit(ready: form.sendable, keepLabel: page.send, keepIcon: .send, identifier: "feedback", acts: acts) {
                let kept = try await form.send()
                if kept == .close { thanked(form.thanks(page)) }
                return kept
            })
            .navigationDestination(for: Pushed.self) { pushed in
                switch pushed {
                case .see: FeedbackSeen(form: form, page: page)
                case .shot: shotPage
                }
            }
        }
        .tint(Cockpit.Color.text)
        .accessibilityIdentifier("feedback.sheet")
        .onAppear {
            form.open()
            focus = .text
        }
        .onDisappear { form.leave() }
    }

    private var field: some View {
        VStack(alignment: .trailing, spacing: Cockpit.Space.s2) {
            TextField("", text: $form.text, prompt: Text(page.field.placeholder).foregroundStyle(Cockpit.Color.textTertiary), axis: .vertical)
                .cockpit(.body)
                .foregroundStyle(Cockpit.Color.text)
                .lineLimit(6...)
                .focused($focus, equals: .text)
                .frame(maxWidth: .infinity, minHeight: Self.fieldHeight, alignment: .topLeading)
                .onChange(of: form.text) { _, text in
                    if text.count > page.field.max { form.text = String(text.prefix(page.field.max)) }
                }
                .accessibilityIdentifier("feedback.text")
            if !form.text.isEmpty {
                Button(page.clear) { form.clear() }
                    .buttonStyle(.cockpit(.plain, size: .small))
                    .accessibilityIdentifier("feedback.clear")
            }
        }
    }

    static let fieldHeight: CGFloat = 200

    private var chips: some View {
        FlowLayout(spacing: Cockpit.Space.s2, lineSpacing: Cockpit.Space.s2) {
            ForEach(form.attachments, id: \.kind) { attachment in
                AttachmentChip(attachment.title, lead: .icon(Self.icon(attachment.kind)),
                               act: .kept(open: { path.append(.see) }, remove: { withAnimation { form.remove(attachment.kind) } }))
            }
            if let shot = form.shot, let kind = page.kinds.first(where: { $0.kind == .screenshot }) {
                let picture = Image(uiImage: shot.image)
                if form.shotAdded {
                    AttachmentChip(kind.title, lead: .picture(picture),
                                   act: .kept(open: { path.append(.shot) }, remove: { withAnimation { form.removeShot() } }))
                } else {
                    AttachmentChip(kind.add ?? kind.title, lead: .picture(picture), act: .offered(add: { withAnimation { form.addShot() } }))
                }
            }
        }
        .padding(.top, Cockpit.Space.s4)
        .animation(Cockpit.Ease.out(Cockpit.Duration.open), value: form.draft)
    }

    private var emailRow: some View {
        HStack(spacing: Cockpit.Space.s3) {
            Text(page.email.label)
                .cockpit(.body)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .fixedSize()
            TextField("", text: Binding(get: { form.email }, set: { form.typedEmail($0) }),
                      prompt: Text(page.email.placeholder).foregroundStyle(Cockpit.Color.textTertiary))
                .cockpit(.body)
                .foregroundStyle(Cockpit.Color.text)
                .multilineTextAlignment(.trailing)
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($focus, equals: .email)
                .accessibilityLabel(page.email.label)
                .accessibilityIdentifier("feedback.email")
        }
        .frame(minHeight: Cockpit.Size.target + Cockpit.Space.s3)
    }

    private var seeRow: some View {
        Button { path.append(.see) } label: {
            HStack(spacing: Cockpit.Space.s3) {
                Icon(.visible, size: .md)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                Text(page.see)
                    .cockpit(.body)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                Spacer(minLength: Cockpit.Space.s3)
                Icon(.forward, size: .sm)
                    .foregroundStyle(Cockpit.Color.textTertiary)
            }
            .frame(minHeight: Cockpit.Size.target + Cockpit.Space.s3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("feedback.see")
    }

    private var rule: some View {
        Rectangle()
            .fill(Cockpit.Color.rule)
            .frame(height: Cockpit.Stroke.hairline)
    }

    @ViewBuilder private var shotPage: some View {
        if let shot = form.shot {
            let title = page.kinds.first { $0.kind == .screenshot }?.title ?? page.see
            SheetPage(title) {
                Image(uiImage: shot.image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.control, style: .continuous))
                    .accessibilityLabel(title)
                    .accessibilityIdentifier("feedback.shot")
            }
        }
    }

    static func icon(_ kind: HomeLink.Pages.FeedbackKind) -> Cockpit.Icon {
        switch kind {
        case .answer: .chat
        case .connector: .streams
        case .app, .unknown: .info
        case .screenshot: .photo
        }
    }
}

private struct FeedbackSeen: View {
    @ObservedObject var form: FeedbackForm
    let page: HomeLink.Pages.Feedback

    var body: some View {
        SheetPage(page.see) {
            SheetPart(nil) {
                CardRow(separator: false) {
                    Text(verbatim: form.text)
                        .cockpit(.body)
                        .foregroundStyle(Cockpit.Color.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                .accessibilityIdentifier("feedback.seen.text")
            }
            if let email = FeedbackForm.trimmed(form.email) {
                SheetPart(page.email.label) {
                    CardRow(separator: false) {
                        Text(verbatim: email)
                            .cockpit(.body)
                            .foregroundStyle(Cockpit.Color.text)
                    }
                }
            }
            ForEach(form.attachments, id: \.kind) { attachment in
                SheetPart(attachment.title) {
                    CardRow(separator: false) {
                        SeenText(attachment.text)
                            .foregroundStyle(Cockpit.Color.text)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                }
                .accessibilityIdentifier("feedback.seen.\(attachment.kind.rawValue)")
            }
            if form.shotAdded, let shot = form.shot {
                SheetPart(page.kinds.first { $0.kind == .screenshot }?.title) {
                    Image(uiImage: shot.image)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.control, style: .continuous))
                }
            }
            Text(page.privacy)
                .cockpit(.footnote)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Cockpit.Space.s4)
                .accessibilityIdentifier("feedback.privacy")
        }
        .accessibilityIdentifier("feedback.seen")
    }
}

struct OpenFeedbackAction: Sendable {
    let perform: @MainActor @Sendable (HomeLink.Feedback.About, String?) -> Void

    @MainActor func callAsFunction(_ about: HomeLink.Feedback.About, name: String? = nil) { perform(about, name) }
}

extension EnvironmentValues {
    @Entry var openFeedback: OpenFeedbackAction? = nil
}

extension View {
    func feedbackSheet(_ opening: Binding<FeedbackOpening?>) -> some View { modifier(FeedbackPresenting(opening: opening)) }

    func feedbackHost() -> some View { modifier(FeedbackHost()) }
}

private struct FeedbackHost: ViewModifier {
    @ObservedObject private var page = FeedbackDesk.page
    @State private var opening: FeedbackOpening?

    func body(content: Content) -> some View {
        content
            .environment(\.openFeedback, page.page?.open == true ? OpenFeedbackAction { about, name in
                opening = FeedbackOpening.take(about, name: name)
            } : nil)
            .feedbackSheet($opening)
    }
}

private struct FeedbackPresenting: ViewModifier {
    @Binding var opening: FeedbackOpening?
    @ObservedObject private var page = FeedbackDesk.page
    @State private var thanks: FeedbackForm.Thanks?
    static let shown: Duration = .seconds(3)

    func body(content: Content) -> some View {
        content
            .sheet(item: $opening) { opening in
                if let page = page.page {
                    FeedbackSheet(opening, page: page) { thanks = $0 }
                }
            }
            .overlay(alignment: .bottom) {
                if let thanks {
                    Toast(thanks.title, line: thanks.line)
                        .padding(.horizontal, Cockpit.Gap.edge)
                        .padding(.bottom, Cockpit.Space.s4)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .accessibilityIdentifier("feedback.sent")
                        .task(id: thanks.id) {
                            AccessibilityNotification.Announcement(thanks.title).post()
                            try? await Task.sleep(for: Self.shown)
                            guard !Task.isCancelled, self.thanks?.id == thanks.id else { return }
                            withAnimation(Cockpit.Ease.out(Cockpit.Duration.open)) { self.thanks = nil }
                        }
                }
            }
            .animation(Cockpit.Ease.out(Cockpit.Duration.open), value: thanks)
            .task { await page.read() }
    }
}
