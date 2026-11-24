import Cockpit
import HomeLink
import LifestreamCaptureCore
import SafariServices
import SwiftUI
import UIKit


struct SignInPage: View {
    let id: String
    let route: String?
    @ObservedObject var home: HomeConnectorsModel
    @Environment(\.openConnectors) private var open

    var body: some View {
        if let connector = home.read?.connectors.first(where: { $0.id == id }) {
            if let route, let chosen = connector.routes.first(where: { $0.id == route }) {
                switch chosen.way {
                case "key": KeySignIn(connector: connector, route: chosen, home: home)
                case "device": DeviceSignIn(connector: connector, route: chosen, home: home)
                case "client": ClientSignIn(connector: connector, route: chosen, home: home)
                default: SignInFrame(connector: connector, route: chosen) { InPlaceLine("This iPhone can't sign in this way yet.") }
                }
            } else {
                PageDrawer("Sign in") {
                    SheetPart(nil) {
                        ForEach(connector.routes, id: \.id) { each in
                            SettingRow(each.label, line: each.about, separator: each.id != connector.routes.last?.id,
                                       tag: each.id == connector.route ? "In use" : nil, opens: { open(.signIn(id, each.id)) })
                                .accessibilityIdentifier("signin.route.\(each.id)")
                        }
                    }
                }
            }
        }
    }
}

enum SignInWords {
    static let paste = "Paste it here"
    static let kept = "Kept encrypted on your Mac."
}

struct SignInFrame<Content: View, Foot: View>: View {
    let connector: HomeLink.Connector
    let route: HomeLink.Connector.Route
    var last: String?
    let content: Content
    let foot: Foot

    init(connector: HomeLink.Connector, route: HomeLink.Connector.Route, last: String? = nil,
         @ViewBuilder content: () -> Content, @ViewBuilder foot: () -> Foot) {
        self.connector = connector
        self.route = route
        self.last = last
        self.content = content()
        self.foot = foot()
    }

    private var footed: Bool { Foot.self != EmptyView.self }

    var body: some View {
        if footed {
            PageDrawer(title) { parts } foot: {
                VStack(spacing: Cockpit.Space.s2) {
                    if let note = route.note { Text(note).connectorsNote().multilineTextAlignment(.center).accessibilityIdentifier("signin.note") }
                    foot
                }
            }
        } else {
            PageDrawer(title) {
                parts
                if let note = route.note { Text(note).connectorsNote().accessibilityIdentifier("signin.note") }
            }
        }
    }

    private var title: String { "Connect \(connector.name)" }

    @ViewBuilder private var parts: some View {
        let way = [connector.routes.count > 1 ? route.label : nil, route.about].compactMap { $0 }.joined(separator: " · ")
        let before = connector.before
        let count = before.count + route.steps.count
        if !way.isEmpty || !connector.gives.isEmpty {
            Text([connector.gives, way].filter { !$0.isEmpty }.joined(separator: " "))
                .cockpit(.subhead)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("signin.help")
        }
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(before.enumerated()), id: \.offset) { index, step in
                StepRow(index + 1, title: step, separator: last != nil || index + 1 < count)
            }
            ForEach(Array(route.steps.enumerated()), id: \.offset) { index, step in
                GuideStepRow(before.count + index + 1, step: step, separator: last != nil || before.count + index + 1 < count,
                             identifier: "signin.step.open")
            }
            if let last {
                StepRow(count + 1, title: last, separator: false) {
                    VStack(alignment: .leading, spacing: Cockpit.Space.s3) { content }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("signin.steps")
        if last == nil { content }
    }
}

extension SignInFrame where Foot == EmptyView {
    init(connector: HomeLink.Connector, route: HomeLink.Connector.Route, last: String? = nil, @ViewBuilder content: () -> Content) {
        self.init(connector: connector, route: route, last: last, content: content, foot: { EmptyView() })
    }
}

@MainActor enum SignInAsk {
    static func send(_ call: @Sendable (HomeLink) async throws -> HomeLink.SignInAnswer) async -> (HomeLink.SignInAnswer?, HomeLink.ActSaid?) {
        do {
            return (try await call(AppRuntime.shared.shipping.link), nil)
        } catch {
            return (nil, HomeLink.ActSaid(error))
        }
    }

    static func ended(_ answer: HomeLink.SignInAnswer?, name: String) -> HomeLink.ActSaid? {
        switch answer {
        case .denied: .refused("\(name) said no.")
        case .expired: .refused("This sign-in ran out. Start again.")
        case nil: nil
        default: .refused(ReachWords.refused)
        }
    }
}

struct KeySignIn: View {
    let connector: HomeLink.Connector
    let route: HomeLink.Connector.Route
    @ObservedObject var home: HomeConnectorsModel
    @State private var values: [String: String] = [:]
    @State private var working = false
    @State private var connected = false
    @State private var refused: HomeLink.SignInRefusal?
    @State private var failed: HomeLink.ActSaid?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let fields = route.fields.compactMap { key in connector.members.first { $0.key == key } }
        SignInFrame(connector: connector, route: route, last: SignInWords.paste) {
            SheetPart(nil) {
                ForEach(fields) { member in
                    let email = member.control == .email
                    SettingRow(member.label, separator: member.key != fields.last?.key, fieldEnd: true) {
                        Field(member.label, text: Binding(get: { values[member.key] ?? "" }, set: { values[member.key] = $0 }),
                              placeholder: member.placeholder ?? "Required", secure: member.control == .secret, spaces: !email,
                              error: refused?.field == member.key ? refused?.refused : nil)
                            .keyboardType(email ? .emailAddress : .default)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("signin.field.\(member.key)")
                    }
                }
            }
            .disabled(working || connected)
            Text(SignInWords.kept)
                .cockpit(.footnote)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .accessibilityIdentifier("signin.kept")
            if let failed = failed ?? (refused?.field == nil ? refused.map { HomeLink.ActSaid.refused($0.refused) } : nil) {
                InPlaceLine(InPlaceLine.Said(failed), retry: failed == .notSent ? { send(fields) } : nil)
                    .accessibilityIdentifier("signin.failed")
            }
        } foot: {
            Button(connected ? "Connected" : "Connect \(connector.name)") { send(fields) }
                .buttonStyle(.cockpit(.primary, size: .large, busy: working, fullWidth: true))
                .disabled(!ready(fields) || connected)
                .accessibilityIdentifier("signin.send")
        }
        .onSubmit { if ready(fields) { send(fields) } }
    }

    private func ready(_ fields: [HomeLink.Connector.Member]) -> Bool {
        !fields.isEmpty && fields.allSatisfy { !(values[$0.key] ?? "").isEmpty } && !working
    }

    private func send(_ fields: [HomeLink.Connector.Member]) {
        let typed = Dictionary(uniqueKeysWithValues: fields.map { ($0.key, values[$0.key] ?? "") })
        let ask = HomeLink.SignInKeyAsk(connector: connector.id, route: route.id, values: typed)
        working = true
        refused = nil
        failed = nil
        Task {
            let (answer, failure) = await SignInAsk.send { try await $0.signIn(ask) }
            working = false
            failed = failure
            switch answer {
            case .refused(let refusal): refused = refusal
            case .signedIn:
                values = [:]
                connected = true
                await home.read()
                dismiss()
            default: failed = failed ?? SignInAsk.ended(answer, name: connector.name)
            }
        }
    }
}

struct DeviceSignIn: View {
    let connector: HomeLink.Connector
    let route: HomeLink.Connector.Route
    @ObservedObject var home: HomeConnectorsModel
    @State private var code: HomeLink.DeviceCode?
    @State private var interval = 5000
    @State private var opened = false
    @State private var working = false
    @State private var connected = false
    @State private var ended: HomeLink.ActSaid?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        SignInFrame(connector: connector, route: route) {
            Text(opened && code != nil
                 ? "Waiting for you to allow Lifestream in your browser. This goes on by itself once you do."
                 : "Sign in to \(connector.name) in your browser, enter this code if it asks, then allow Lifestream.")
                .cockpit(.body)
                .foregroundStyle(Cockpit.Color.text)
                .fixedSize(horizontal: false, vertical: true)
            CopyValue(code?.code, shape: "XXXX-XXXX", label: "Your code") { UIPasteboard.general.string = $0 }
                .accessibilityIdentifier("signin.code")
            if let ended { InPlaceLine(InPlaceLine.Said(ended)).accessibilityIdentifier("signin.failed") }
            if let page = code.flatMap({ URL(string: $0.open) }), ended == nil {
                Button(connected ? "Connected" : "Open \(connector.name)") {
                    opened = true
                    openURL(page)
                }
                .buttonStyle(.cockpit(.primary, fullWidth: true))
                .disabled(connected)
                .accessibilityIdentifier("signin.open")
            }
            Button("New code") { Task { await start() } }
                .buttonStyle(.cockpit(ended == nil ? .plain : .primary, busy: working, fullWidth: true))
                .disabled(working || connected)
                .accessibilityIdentifier("signin.restart")
        }
        .task { if code == nil { await start() } }
        .task(id: polling) {
            while polling, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(interval))
                guard !Task.isCancelled else { return }
                await poll()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, polling { Task { await poll() } }
        }
    }

    private var polling: Bool { code != nil && ended == nil && !connected && scenePhase == .active }

    private func start() async {
        working = true
        ended = nil
        opened = false
        let ask = HomeLink.SignInDeviceStartAsk(connector: connector.id, route: route.id)
        let (answer, failure) = await SignInAsk.send { try await $0.signIn(ask) }
        working = false
        switch answer {
        case .code(let given):
            code = given
            interval = given.intervalMs
        case .refused(let refusal): ended = .refused(refusal.refused)
        default: ended = failure ?? SignInAsk.ended(answer, name: connector.name)
        }
    }

    private func poll() async {
        guard let code, !connected else { return }
        let ask = HomeLink.SignInDevicePollAsk(connector: connector.id, route: route.id, attempt: code.attempt, intervalMs: interval)
        let (answer, _) = await SignInAsk.send { try await $0.signIn(ask) }
        guard code == self.code, !connected else { return }
        switch answer {
        case .pending(let next): if let next { interval = next }
        case .signedIn:
            connected = true
            await home.read()
            dismiss()
        case .refused(let refusal): ended = .refused(refusal.refused)
        case .denied, .expired: ended = SignInAsk.ended(answer, name: connector.name)
        case .code, .started, nil: break
        }
    }
}

struct ClientSignIn: View {
    let connector: HomeLink.Connector
    let route: HomeLink.Connector.Route
    @ObservedObject var home: HomeConnectorsModel
    @State private var clientId = ""
    @State private var clientSecret = ""
    @State private var started: HomeLink.ClientStarted?
    @State private var browser: Browsed?
    @State private var pasted = ""
    @State private var listener: LoopbackListener?
    @State private var working = false
    @State private var connected = false
    @State private var refused: HomeLink.SignInRefusal?
    @State private var failed: HomeLink.ActSaid?
    @Environment(\.dismiss) private var dismiss

    struct Browsed: Identifiable {
        let url: URL
        var id: URL { url }
    }

    static let paste = "Paste the address your browser ended on"

    var body: some View {
        let client = route.client
        let asks = client.map { !$0.held } ?? false
        SignInFrame(connector: connector, route: route) {
            if let client, asks, started == nil {
                SheetPart(client.name, line: client.before.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")) {
                    SettingRow("Client ID", fieldEnd: true) {
                        Field("Client ID", text: $clientId, placeholder: "Required", spaces: false,
                              error: refused?.field == "client_id" ? refused?.refused : nil)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("signin.client.id")
                    }
                    SettingRow("Client secret", separator: false, fieldEnd: true) {
                        Field("Client secret", text: $clientSecret, placeholder: "Required", secure: true, spaces: false,
                              error: refused?.field == "client_secret" ? refused?.refused : nil)
                            .accessibilityIdentifier("signin.client.secret")
                    }
                }
                .disabled(working)
            }
            Button(connected ? "Connected" : route.label) { Task { await start(asks) } }
                .buttonStyle(.cockpit(started == nil ? .primary : .secondary, busy: working && started == nil, fullWidth: true))
                .disabled(working || connected || (asks && (clientId.isEmpty || clientSecret.isEmpty)))
                .accessibilityIdentifier("signin.start")
            if started != nil {
                SheetPart(nil) {
                    SettingRow(Self.paste, separator: false, fieldEnd: true) {
                        HStack(spacing: Cockpit.Space.s2) {
                            Field(Self.paste, text: $pasted, placeholder: "http://127.0.0.1", spaces: false,
                                  error: refused?.field == "address" ? refused?.refused : nil)
                                .keyboardType(.URL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .accessibilityIdentifier("signin.paste")
                            Button("Done") { Task { await finish(pasted.trimmingCharacters(in: .whitespaces)) } }
                                .buttonStyle(.cockpit(.secondary, busy: working))
                                .disabled(pasted.isEmpty || working || connected)
                                .accessibilityIdentifier("signin.paste.done")
                        }
                    }
                }
            }
            let underField = ["client_id", "client_secret", "address"].contains(refused?.field ?? "")
            if let failed = failed ?? (underField ? nil : refused.map { HomeLink.ActSaid.refused($0.refused) }) {
                InPlaceLine(InPlaceLine.Said(failed), retry: failed == .notSent && started == nil ? { Task { await start(asks) } } : nil)
                    .accessibilityIdentifier("signin.failed")
            }
        }
        .sheet(item: $browser) { BrowserView(url: $0.url).ignoresSafeArea() }
        .onDisappear { listener?.close() }
    }

    private func start(_ asks: Bool) async {
        working = true
        refused = nil
        failed = nil
        listener?.close()
        let listening = try? await LoopbackListener.open()
        listener = listening
        let ask = HomeLink.SignInClientStartAsk(connector: connector.id, route: route.id,
                                                client: asks ? .init(clientId: clientId.trimmingCharacters(in: .whitespaces),
                                                                     clientSecret: clientSecret) : nil,
                                                port: listening?.port)
        let (answer, failure) = await SignInAsk.send { try await $0.signIn(ask) }
        working = false
        switch answer {
        case .started(let given):
            started = given
            browser = URL(string: given.open).map(Browsed.init)
            if let listening {
                Task {
                    for await address in listening.caught {
                        browser = nil
                        await finish(address)
                        return
                    }
                }
            }
            if given.listening { await waitForHome() }
        case .refused(let refusal): refused = refusal
        default: failed = failure ?? SignInAsk.ended(answer, name: connector.name)
        }
    }

    private func waitForHome() async {
        while started != nil, !connected, !Task.isCancelled {
            try? await Task.sleep(for: .seconds(2))
            if await finish(nil) != .pending(intervalMs: nil) { return }
        }
    }

    @discardableResult private func finish(_ address: String?) async -> HomeLink.SignInAnswer? {
        guard let attempt = started?.attempt, !connected else { return nil }
        working = true
        refused = nil
        failed = nil
        let ask = HomeLink.SignInClientFinishAsk(connector: connector.id, route: route.id, attempt: attempt, address: address)
        let (answer, failure) = await SignInAsk.send { try await $0.signIn(ask) }
        working = false
        switch answer {
        case .signedIn:
            connected = true
            listener?.close()
            await home.read()
            dismiss()
        case .refused(let refusal): refused = refusal
        case .pending: return .pending(intervalMs: nil)
        case .denied, .expired:
            failed = SignInAsk.ended(answer, name: connector.name)
            started = nil
        case .code, .started, nil: failed = failure ?? SignInAsk.ended(answer, name: connector.name)
        }
        return answer
    }
}

struct BrowserView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
