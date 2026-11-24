import AppKit
import Cockpit
import HomeLink
import SwiftUI


enum RouteWords {
    static func last(_ rows: [AccountSheet.Row]) -> String {
        rows.contains { $0.secure } ? "Paste it here" : "Type it here"
    }

    static let kept = "Kept encrypted on your Mac."

    static func head(_ connector: Connector, _ route: Connector.Route) -> (title: String, line: String?) {
        let way = [connector.routes.count > 1 ? route.label : nil, route.about].compactMap { $0 }.joined(separator: " · ")
        let line = [connector.gives, way].filter { !$0.isEmpty }.joined(separator: " ")
        return ("Connect \(connector.name)", line.isEmpty ? nil : line)
    }

    static func send(_ connector: Connector) -> String {
        connector.setUp ? "Save" : "Connect \(connector.name)"
    }
}

struct RouteSteps<Last: View>: View {
    let before: [String]
    let steps: [HomeLink.Import.Step]
    let last: String?
    let open: (URL) -> Void
    let content: Last

    init(before: [String], _ steps: [HomeLink.Import.Step], last: String? = nil, open: @escaping (URL) -> Void,
         @ViewBuilder content: () -> Last) {
        self.before = before
        self.steps = steps
        self.last = last
        self.open = open
        self.content = content()
    }

    private var count: Int { before.count + steps.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(before.enumerated()), id: \.offset) { index, line in
                StepRow(index + 1, title: line, separator: last != nil || index + 1 < count)
            }
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                let number = before.count + index + 1
                StepRow(number, title: step.title ?? step.words, words: step.title == nil ? nil : step.words,
                        separator: last != nil || number < count) {
                    if let link = step.open, let page = URL(string: link.url) {
                        Button { open(page) } label: {
                            HStack(spacing: Cockpit.Space.s1) {
                                Text(link.label)
                                Icon(.openOut, size: .xs)
                            }
                        }
                        .buttonStyle(.cockpit(.secondary, size: .small))
                        .help(link.url)
                    }
                }
            }
            if let last {
                StepRow(count + 1, title: last, separator: false) { content }
            }
        }
        .accessibilityElement(children: .contain)
    }
}

extension RouteSteps where Last == EmptyView {
    init(before: [String], _ steps: [HomeLink.Import.Step], open: @escaping (URL) -> Void) {
        self.init(before: before, steps, open: open) { EmptyView() }
    }
}

struct RouteNote: View {
    let note: String?

    var body: some View {
        if let note { Text(note).fixedSize(horizontal: false, vertical: true) }
    }
}

struct RouteHelp: View {
    let words: [String]

    var body: some View {
        if !words.isEmpty {
            Text(Steps.linked(words.joined(separator: " ")))
                .cockpit(.footnote)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .tint(Cockpit.Color.text)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

enum Steps {
    static func linked(_ text: String) -> AttributedString {
        var linked = AttributedString(text)
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return linked }
        for match in detector.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let found = Range(match.range, in: text), let at = Range(found, in: linked), match.url?.scheme?.hasPrefix("http") == true
            else { continue }
            let written = String(text[found])
            linked[at].link = URL(string: written.lowercased().hasPrefix("http") ? written : "https://" + written) ?? match.url
            linked[at].underlineStyle = .single
        }
        return linked
    }
}

struct GoTo: View {
    let page: URL
    let open: (URL) -> Void

    var body: some View {
        Text(Self.words(page))
            .cockpit(.footnote)
            .foregroundStyle(Cockpit.Color.textSecondary)
            .tint(Cockpit.Color.text)
            .environment(\.openURL, OpenURLAction { open($0); return .handled })
            .help(page.absoluteString)
    }

    static func words(_ page: URL) -> AttributedString {
        var link = AttributedString("\(page.host() ?? "")\(page.path())")
        link.link = page
        return AttributedString("Or go to ") + link
    }
}

struct AccountSheet: View {
    @ObservedObject var host: MacHost
    let connector: Connector
    let route: Connector.Route
    @State private var values: [String: String] = [:]
    @State private var connected = false
    @Environment(\.dismiss) private var dismiss

    struct Row: Equatable {
        let field: String
        let label: String
        let secure: Bool
        let spaces: Bool
        let placeholder: String
    }

    static func rows(_ connector: Connector, _ route: Connector.Route) -> [Row] {
        route.fields.compactMap { field in
            connector.members.first { $0.key == field }.map { member in
                Row(field: field, label: member.label, secure: member.control == .secret, spaces: member.control != .email,
                    placeholder: member.placeholder ?? "Required")
            }
        }
    }

    var body: some View {
        let rows = Self.rows(connector, route)
        let (title, line) = RouteWords.head(connector, route)
        let named = rows.contains { $0.field == host.refusedField }
        SheetFrame(title, line: line) {
            RouteSteps(before: connector.before, route.steps, last: RouteWords.last(rows), open: host.browse) {
                SheetPart(nil, note: rows.contains { $0.secure } ? RouteWords.kept : nil) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        SettingRow(row.label, separator: index < rows.count - 1, fieldEnd: true) {
                            Field(row.label, text: value(row.field), placeholder: row.placeholder, secure: row.secure, spaces: row.spaces,
                                  error: host.refusedField == row.field ? host.failure : nil)
                        }
                    }
                }
                .disabled(host.working || connected)
            }
            if let failure = host.failure, !named { InPlaceLine(failure) }
        } words: {
            RouteNote(note: route.note)
        } acts: {
            Button("Cancel") { dismiss() }.buttonStyle(.cockpit(.plain)).keyboardShortcut(.cancelAction).disabled(host.working || connected)
            Button(connected ? "Connected" : RouteWords.send(connector)) { connect(rows) }
                .buttonStyle(.cockpit(.primary, busy: host.working)).keyboardShortcut(.defaultAction)
                .disabled(!ready(rows) && !host.working)
        }
        .onSubmit { if ready(rows) { connect(rows) } }
    }

    private func value(_ field: String) -> Binding<String> {
        Binding { values[field] ?? "" } set: { values[field] = $0 }
    }

    private func ready(_ rows: [Row]) -> Bool {
        !rows.isEmpty && rows.allSatisfy { !(values[$0.field] ?? "").isEmpty } && !host.working && !connected
    }

    private func connect(_ rows: [Row]) {
        let typed = Dictionary(uniqueKeysWithValues: rows.map { ($0.field, values[$0.field] ?? "") })
        let sent = host.connectAccount(connector.id, route: route.id, values: typed)
        Task {
            guard await sent?.value == true else { return }
            values = [:]
            connected = true
            host.connected(connector.name)
            try? await Task.sleep(for: .seconds(1))
            dismiss()
        }
    }
}

struct DeviceSheet: View {
    @ObservedObject var host: MacHost
    let connector: Connector
    let route: Connector.Route
    @State private var connected = false
    @State private var opened = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let (title, line) = RouteWords.head(connector, route)
        let state = host.device
        let shown = code(state)
        let stuck = ended(state) != nil && !host.working
        SheetFrame(title, line: line) {
            VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                Text(connected || (opened && shown != nil)
                     ? "Waiting for you to allow Lifestream in your browser. This closes by itself once you do."
                     : "Sign in to \(connector.name) in your browser, enter this code if it asks, then allow Lifestream.")
                    .quiet(.body)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: Cockpit.Space.s2) {
                    CopyValue(shown?.code, shape: "XXXX-XXXX", label: "Your code", copy: host.copy)
                    Button("New code", action: start)
                        .buttonStyle(.cockpit(stuck ? .primary : .plain))
                        .keyboardShortcut(stuck ? KeyboardShortcut.defaultAction : nil)
                        .disabled(host.working || connected)
                }
                if let page = shown?.open { GoTo(page: page, open: open) }
                if let ended = ended(state) { InPlaceLine(ended) }
                if !connector.before.isEmpty || !route.steps.isEmpty { RouteSteps(before: connector.before, route.steps, open: host.browse) }
            }
        } words: {
            RouteNote(note: route.note)
        } acts: {
            Button("Cancel") { dismiss() }.buttonStyle(.cockpit(.plain)).keyboardShortcut(.cancelAction).disabled(connected)
            if connected {
                Button("Connected") {}.buttonStyle(.cockpit(.primary)).disabled(true)
            } else if let page = shown?.open {
                Button("Open \(connector.name)") { open(page) }
                    .buttonStyle(.cockpit(.primary)).keyboardShortcut(.defaultAction)
            } else if host.working {
                Button("Open \(connector.name)") {}.buttonStyle(.cockpit(.primary, busy: true))
            }
        }
        .task { if state == nil, host.failure == nil, !host.working { start() } }
        .onChange(of: host.device) { _, now in
            guard now == .signedIn else { return }
            connected = true
            host.connected(connector.name)
            Task {
                try? await Task.sleep(for: .seconds(1))
                dismiss()
            }
        }
    }

    private func start() {
        opened = false
        host.startDevice(connector.id, route: route.id)
    }

    private func open(_ page: URL) {
        opened = true
        host.browse(page)
    }

    private func code(_ state: DeviceSignIn?) -> (code: String, open: URL)? {
        if case .code(let code, let open) = state { return (code, open) }
        return nil
    }

    private func ended(_ state: DeviceSignIn?) -> String? {
        switch state {
        case .denied: return "\(connector.name) said no."
        case .expired: return "This code ran out."
        case .code, .signedIn: return nil
        case nil: return host.failure
        }
    }
}

struct ClientSheet: View {
    @ObservedObject var host: MacHost
    let connector: Connector
    let route: Connector.Route
    let client: Connector.Route.Client
    @State private var id = ""
    @State private var secret = ""
    @State private var address = ""
    @State private var connected = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let (title, line) = RouteWords.head(connector, route)
        let started = host.client.flatMap(Self.started)
        let named: Set<String> = ["client_id", "client_secret", "address"]
        SheetFrame(title, line: line) {
            if let started {
                Text(started.listening
                     ? "Allow Lifestream in your browser. This closes by itself once you do."
                     : "Allow Lifestream in your browser, then paste the address it ended on.")
                    .quiet(.body)
                    .fixedSize(horizontal: false, vertical: true)
                GoTo(page: started.open, open: host.browse)
                SheetPart(nil) {
                    SettingRow("Paste the address your browser ended on", line: "The page that didn't load, from its address bar.",
                               separator: false) {
                        EmptyView()
                    } held: {
                        Field("The address your browser ended on", text: $address, placeholder: "http://127.0.0.1:…", spaces: false,
                              error: host.refusedField == "address" ? host.failure : nil)
                    }
                }
                .disabled(host.working || connected)
            } else {
                Text(client.held
                     ? "Sign in to \(connector.name) in your browser, then allow Lifestream."
                     : "Lifestream signs in with a \(client.name) client you make once. Make it, then type its ID and secret here.")
                    .quiet(.body)
                    .fixedSize(horizontal: false, vertical: true)
                if !client.held {
                    SheetPart("Make your \(client.name) client") {
                        RouteHelp(words: client.before)
                    }
                    SheetPart(nil) {
                        SettingRow("Client ID", fieldEnd: true) {
                            Field("Client ID", text: $id, placeholder: "Required", spaces: false,
                                  error: host.refusedField == "client_id" ? host.failure : nil)
                        }
                        SettingRow("Client secret", separator: false, fieldEnd: true) {
                            Field("Client secret", text: $secret, placeholder: "Required", secure: true, spaces: false,
                                  error: host.refusedField == "client_secret" ? host.failure : nil)
                        }
                    }
                    .disabled(host.working || connected)
                }
            }
            if let failure = host.failure, !named.contains(host.refusedField ?? "") { InPlaceLine(failure) }
            if started == nil {
                if !connector.before.isEmpty || !route.steps.isEmpty { RouteSteps(before: connector.before, route.steps, open: host.browse) }
            }
        } words: {
            RouteNote(note: route.note)
        } acts: {
            Button("Cancel") { dismiss() }.buttonStyle(.cockpit(.plain)).keyboardShortcut(.cancelAction).disabled(connected)
            if connected {
                Button("Connected") {}.buttonStyle(.cockpit(.primary)).disabled(true)
            } else if started != nil {
                Button("Start again", action: start).buttonStyle(.cockpit(.plain)).disabled(host.working)
                Button("Finish", action: finish)
                    .buttonStyle(.cockpit(.primary, busy: host.working)).keyboardShortcut(.defaultAction)
                    .disabled(address.isEmpty || host.working)
            } else {
                Button(route.label, action: start)
                    .buttonStyle(.cockpit(.primary, busy: host.working)).keyboardShortcut(.defaultAction)
                    .disabled(!ready || host.working)
            }
        }
        .onChange(of: host.client) { _, now in
            guard now == .signedIn else { return }
            connected = true
            host.connected(connector.name)
            Task {
                try? await Task.sleep(for: .seconds(1))
                dismiss()
            }
        }
    }

    private var ready: Bool { client.held || (!id.isEmpty && !secret.isEmpty) }

    private func start() {
        address = ""
        host.startClient(connector.id, route: route.id, client: client.held ? nil : HomeLink.ClientTyped(clientId: id, clientSecret: secret))
    }

    private func finish() {
        host.finishClient(connector.id, route: route.id, address: address)
    }

    private static func started(_ state: ClientSignIn) -> (open: URL, listening: Bool)? {
        if case .started(let open, let listening) = state { return (open, listening) }
        return nil
    }
}
