import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UniformTypeIdentifiers
import os

@MainActor
final class HomeConnectorsModel: ObservableObject {
    @Published private(set) var answer: StreamsAnswer?
    @Published private(set) var failure: LifeReader.Failure?
    @Published private(set) var pressed: Set<String> = []
    @Published private(set) var changes = MemberChanges()
    @Published private(set) var changing: Set<String> = []
    @Published private(set) var unchanged: [String: StreamUnchanged] = [:]
    @Published private(set) var refreshing: Set<String> = []
    @Published private(set) var refreshSaid: [String: String] = [:]
    @Published private(set) var refreshFailed: [String: HomeLink.ActSaid] = [:]
    @Published private(set) var sealing: Set<String> = []
    @Published private(set) var sealRefused: [String: String] = [:]
    @Published private(set) var sealFailed: [String: HomeLink.ActSaid] = [:]

    struct StreamUnchanged: Equatable {
        let said: HomeLink.ActSaid
        let change: HomeLink.StreamChange
    }

    @Published private(set) var choosing: Set<String> = []
    @Published private(set) var chooseFailed: [String: ChooseUnlanded] = [:]

    struct ChooseUnlanded: Equatable {
        let said: HomeLink.ActSaid
        let account: String
    }
    private var reads = 0
    private var paired = 0
    private static let log = Logger(subsystem: "org.lifestreamprotocol.phone", category: "settings")

    var read: HomeLink.StreamsReport? { answer?.report }

    var reading: Bool { answer == nil && failure == nil }

    static let lacks = "Pair this iPhone to see your connectors."

    static let failed = "Couldn’t load connectors. Pull to try again."

    static func waiting(read: Bool, failure: LifeReader.Failure?, lacking: Bool) -> String? {
        guard read, let failure, case .busy(let words, _, _, _) = failure,
              ReadLack.Shown(failure, lacking: lacking) == .waits else { return nil }
        return words
    }

    static func sentence(_ failure: LifeReader.Failure) -> String? {
        switch failure {
        case .busy(let words, _, _, _), .refused(let words), .failed(let words), .unknown(let words): words
        case .reach: nil
        case .missing, .unpaired: Self.failed
        }
    }

    func forget() {
        reads += 1
        paired += 1
        answer = nil
        failure = nil
        changes = MemberChanges()
        pressed = []
        changing = []
        unchanged = [:]
        refreshing = []
        refreshSaid = [:]
        refreshFailed = [:]
        sealing = []
        sealRefused = [:]
        sealFailed = [:]
        choosing = []
        chooseFailed = [:]
    }

    func busy(_ act: HomeLink.Act) -> Bool {
        pressed.contains(Self.key(act.need ?? "", act.do, act.of))
    }

    func busy(_ act: HomeLink.Pages.Act) -> Bool {
        switch act {
        case .refresh(_, let of): refreshing.contains(of)
        case .resume(_, let of): changing.contains(Self.changeKey(of, .resume))
        default: act.pressed.map { pressed.contains(Self.key(act.need ?? "", $0, act.of)) } ?? false
        }
    }

    private static func key(_ need: String, _ what: HomeLink.Act.Do, _ of: String?) -> String { "\(need) \(what.rawValue) \(of ?? "")" }

    func perform(_ act: HomeLink.Act, on connector: HomeLink.Connector?, open: OpenURLAction, allow: AllowSourceAction,
                 page: OpenConnectorsAction) {
        switch act.do {
        case .open: if let url = act.url.flatMap(URL.init(string:)) { open(url) }
        case .copy: UIPasteboard.general.string = act.text
        case .grant: if let source = PhoneSource.allCases.first(where: { $0.permission == act.grant }) { allow(source) }
        case .signin: if let connector, let route = act.of { page(.signIn(connector.id, route)) }
        case .set: if let connector { page(.form(connector.id)) }
        case .import: if let kind = act.kind { page(.importKind(kind)) }
        case .refresh: if let connector { Task { await refresh(connector) } }
        default: if let need = act.need { Task { await press(need: need, act.do, of: act.of) } }
        }
    }

    func perform(_ act: HomeLink.Pages.Act, open: OpenURLAction, allow: AllowSourceAction) {
        switch act {
        case .open(_, let url): if let url = URL(string: url) { open(url) }
        case .copy(_, let text): UIPasteboard.general.string = text
        case .grant(_, _, let grant): if let source = PhoneSource.allCases.first(where: { $0.permission == grant }) { allow(source) }
        case .refresh(_, let of): if let connector = read?.connectors.first(where: { $0.id == of }) { Task { await refresh(connector) } }
        case .resume(_, let of): Task { await change(of, .resume) }
        default:
            if let need = act.need, let what = act.pressed { Task { await press(need: need, what, of: act.of) } }
        }
    }

    func refresh(_ connector: HomeLink.Connector) async {
        let id = connector.id
        guard !refreshing.contains(id) else { return }
        refreshing.insert(id)
        refreshSaid[id] = nil
        refreshFailed[id] = nil
        let home = paired
        let shipping = AppRuntime.shared.shipping
        var said: String?
        var failed: HomeLink.ActSaid?
        var holds = false
        do {
            if case .blocked(let blocked) = try await shipping.link.refresh(connector: id) {
                said = blocked.words
                holds = blocked.reason == .paused || blocked.reason == .disk
            }
        } catch LinkFailure.refused(409, "NOT_OFFERED", _) {
            said = nil
        } catch {
            failed = HomeLink.ActSaid(error)
        }
        guard home == paired else { return }
        let own = Set(connector.copies.filter { $0.road == .phone && $0.on && $0.unit != nil && $0.unit == shipping.link.unit }.map(\.id))
        if !own.isEmpty, !holds {
            refreshSaid[id] = Self.refreshingWords
            await shipping.shipper.refresh(own)
            guard home == paired else { return }
        }
        refreshSaid[id] = said
        refreshFailed[id] = failed
        await read()
        refreshing.remove(id)
    }

    static let refreshingWords = "Refreshing"

    func seal(_ connector: HomeLink.Connector, _ member: String, _ value: String) async -> Bool {
        let key = MemberChanges.key(connector.id, member)
        guard !sealing.contains(key) else { return false }
        sealing.insert(key)
        sealRefused[key] = nil
        sealFailed[key] = nil
        let home = paired
        var refused: String?
        var failed: HomeLink.ActSaid?
        do {
            if case .refused(let refusal) = try await AppRuntime.shared.shipping.link.seal(.init(connector: connector.id, member: member, value: value)) {
                refused = refusal.refused
            }
        } catch {
            failed = HomeLink.ActSaid(error)
        }
        guard home == paired else { return false }
        sealRefused[key] = refused
        sealFailed[key] = failed
        sealing.remove(key)
        let sealed = refused == nil && failed == nil
        if sealed { await read() }
        return sealed
    }

    func press(need: String, _ what: HomeLink.Act.Do, of: String? = nil) async {
        let key = Self.key(need, what, of)
        guard !pressed.contains(key) else { return }
        pressed.insert(key)
        try? await AppRuntime.shared.life.act(need: need, do: what.rawValue, of: of)
        await read()
        pressed.remove(key)
    }

    func choose(need: String, account: String) async -> Bool {
        guard !choosing.contains(need) else { return false }
        choosing.insert(need)
        chooseFailed[need] = nil
        let home = paired
        var failed: ChooseUnlanded?
        do {
            try await AppRuntime.shared.life.choose(need: need, account: account)
        } catch {
            failed = ChooseUnlanded(said: HomeLink.ActSaid(error), account: account)
        }
        guard home == paired else { return false }
        chooseFailed[need] = failed
        await read()
        choosing.remove(need)
        return failed == nil
    }

    func set(_ connector: HomeLink.Connector, _ member: String, _ value: HomeLink.JSON, was: HomeLink.JSON?) async {
        let key = MemberChanges.key(connector.id, member)
        guard !changes.busy.contains(key) else { return }
        changes.busy.insert(key)
        changes.unlanded[key] = nil
        let home = paired
        let said: HomeLink.ActSaid?
        var holds: HomeLink.JSON?
        do {
            let outcome = try await AppRuntime.shared.shipping.link.setSetting(connector: connector.id, member: member, value: value, was: was)
            said = Self.said(outcome)
            holds = MemberChanges.landed(outcome, sent: value)
        } catch {
            said = HomeLink.ActSaid(error)
        }
        guard home == paired else { return }
        if let said {
            if case .refused = said { Self.log.error("The home refused \(connector.id, privacy: .public).\(member, privacy: .public)") }
            changes.unlanded[key] = MemberChanges.Unlanded(said: said, value: value, was: was)
            changes.busy.remove(key)
            await read()
            return
        }
        changes.landed[key] = MemberChanges.Landed(connector: connector.id, member: member, value: holds ?? value)
        await read()
    }

    static func said(_ outcome: SettingOutcome) -> HomeLink.ActSaid? {
        switch outcome {
        case .taken, .changed: nil
        case .refused: .refused(ReachWords.refused)
        case .saving: .saving
        case .unknown(let words): .unknown(words)
        case .unreachable: .notSent
        }
    }

    static func changeKey(_ stream: String, _ change: HomeLink.StreamChange) -> String {
        switch change {
        case .pauseHistory, .resumeHistory: "\(stream) history"
        default: stream
        }
    }

    func change(_ stream: String, _ change: HomeLink.StreamChange) async {
        let key = Self.changeKey(stream, change)
        guard !changing.contains(key) else { return }
        changing.insert(key)
        unchanged[stream] = nil
        let home = paired
        var failed: StreamUnchanged?
        do {
            try await AppRuntime.shared.shipping.link.change(stream: stream, change)
        } catch {
            failed = StreamUnchanged(said: HomeLink.ActSaid(error), change: change)
        }
        guard home == paired else { return }
        unchanged[stream] = failed
        await read()
        changing.remove(key)
    }

    func read() async {
        let runtime = AppRuntime.shared
        reads += 1
        let mine = reads
        let begun = runtime.life.revision
        for await drawn in runtime.pages.reading(StreamsAnswer.self, StreamsAnswer.key(unit: runtime.shipping.link.unit)) {
            guard mine == reads else { return }
            if let page = drawn.page, page != answer {
                answer = page
                ProductsBook.shared.saw(digest: page.report.products)
                PhoneNeeds.shared.take(page.report.needs)
            }
            failure = PageReading<StreamsAnswer>.failure(drawn.state, begun: begun)
            guard drawn.state == .fresh, let report = answer?.report else { continue }
            changes.settle(report)
        }
    }
}

struct HomeStreamSheet: View {
    let connector: HomeLink.Connector
    let report: HomeLink.StreamsReport
    let unit: String?
    @ObservedObject var home: HomeConnectorsModel

    var body: some View {
        ConnectorPage(connector: connector, report: report, unit: unit, home: home)
    }
}

struct ConnectorPage: View {
    let connector: HomeLink.Connector
    let report: HomeLink.StreamsReport
    let unit: String?
    @ObservedObject var home: HomeConnectorsModel
    @State private var confirmingOff = false

    private var setup: Bool { connector.health.state == .setup }

    var body: some View {
        Group {
            if setup, StreamSetup.due(connector, unit: unit) != nil {
                PageDrawer(connector.name, icon: StreamsWords.icon(connector), line: StreamsWords.line(connector)) {
                    parts
                } foot: {
                    StreamSetup.Due(connector: connector, unit: unit, home: home)
                }
            } else if setup {
                PageDrawer(connector.name, icon: StreamsWords.icon(connector), line: StreamsWords.line(connector)) { parts }
            } else {
                PageDrawer(connector.name, icon: StreamsWords.icon(connector), line: StreamsWords.line(connector),
                           lineBusy: StreamProgress.stands(connector)) {
                    parts
                } foot: {
                    if StreamFoot.Buttons.stands(connector, offable: offable) { foot }
                }
            }
        }
        .confirmationDialog(ConnectorWords.disconnectTitle(connector.name), isPresented: $confirmingOff, titleVisibility: .visible) {
            Button(ConnectorWords.disconnect, role: .destructive) { Task { await home.change(connector.id, .turnOff) } }
                .accessibilityIdentifier("connector.detail.turnOff.confirm")
            Button(ConnectorWords.cancel, role: .cancel) {}
        } message: {
            Text(ConnectorWords.disconnectBody(connector))
        }
    }

    private var offable: Bool { StreamFoot.offable(connector) }

    private var foot: some View {
        StreamFoot.Buttons(connector: connector, home: home, offable: offable) { confirmingOff = true }
    }

    @ViewBuilder private var parts: some View {
        if setup {
            StreamSetup(connector: connector, unit: unit, home: home)
            StreamReads(gives: connector.gives, reads: connector.where, labelled: true)
        } else {
            StreamCallout(connector: connector, unit: unit, home: home)
            StreamProgress(connector: connector, now: report.atMs)
            if let figure = connector.figure, !(StreamProgress.stands(connector) && (figure.today ?? 0) == 0) {
                StreamFigure(today: figure.today, noun: StreamsWords.noun(connector), week: figure.week, day: report.day)
            }
            StreamComesFrom(connector: connector)
            StreamForm(connector: connector, home: home)
            StreamSettings(connector: connector, home: home)
            StreamProcessing(connector: connector, home: home)
            StreamHistory(connector: connector, home: home)
            StreamReads(gives: connector.gives)
            StreamFoot.Unchanged(connector: connector, home: home)
        }
    }
}

struct StreamSetup: View {
    let connector: HomeLink.Connector
    let unit: String?
    @ObservedObject var home: HomeConnectorsModel

    static func due(_ connector: HomeLink.Connector, unit: String?) -> HomeLink.Act? {
        connector.health.acts.first { $0.taken(by: unit, on: connector) }
    }

    static func line(_ connector: HomeLink.Connector, step: String) -> String? {
        connector.ways.lazy.flatMap(\.requirements).first { !$0.met && $0.words == step }?.line
    }

    var body: some View {
        let health = connector.health
        let before = connector.before
        let due = Self.due(connector, unit: unit)
        let last = health.words.isEmpty ? nil : health.words
        let count = before.count + (last == nil ? 0 : 1)
        if count > 0 {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(before.enumerated()), id: \.offset) { index, step in
                    StepRow(index + 1, title: step, separator: index + 1 < count)
                }
                if let last {
                    let line = Self.line(connector, step: last)
                    StepRow(count, title: last, words: due == nil ? [line, StreamsWords.act].compactMap { $0 }.joined(separator: " ") : line ?? health.line,
                            separator: false)
                        .accessibilityIdentifier("connector.detail.connect")
                }
            }
        }
    }

    struct Due: View {
        let connector: HomeLink.Connector
        let unit: String?
        @ObservedObject var home: HomeConnectorsModel
        @Environment(\.openURL) private var openURL
        @Environment(\.allowSource) private var allow
        @Environment(\.openConnectors) private var page

        var body: some View {
            if let act = StreamSetup.due(connector, unit: unit) {
                Button(act.label) { home.perform(act, on: connector, open: openURL, allow: allow, page: page) }
                    .buttonStyle(.cockpit(.primary, size: .large, busy: home.busy(act), fullWidth: true))
                    .accessibilityIdentifier("connector.detail.act.\(act.do.rawValue)")
            }
        }
    }
}

struct ImportSheet: View {
    let kind: HomeLink.Import
    let report: HomeLink.StreamsReport
    let unit: String?
    @ObservedObject var home: HomeConnectorsModel
    let leave: (@escaping @MainActor () -> Void) -> Void

    var body: some View {
        PageDrawer(kind.name, icon: Cockpit.Icon(rawValue: kind.icon) ?? .file, line: ImportWords.head(kind)) {
            ImportParts(kind: kind, report: report, unit: unit, home: home, leave: leave)
        }
    }
}

extension HomeLink.Import {
    var underWay: Bool {
        !coming.isEmpty || held.contains { [.syncing, .waiting].contains($0.health.state) }
    }
}

struct ImportPage: View {
    let kind: String
    let unit: String?
    @ObservedObject var home: HomeConnectorsModel
    let leave: (@escaping @MainActor () -> Void) -> Void

    var body: some View {
        if let report = home.read, let declared = report.imports.first(where: { $0.kind == kind }) {
            PageDrawer(declared.name, line: ImportWords.head(declared)) {
                ImportParts(kind: declared, report: report, unit: unit, home: home, leave: leave)
            }
        }
    }
}

struct ImportParts: View {
    let kind: HomeLink.Import
    let report: HomeLink.StreamsReport
    let unit: String?
    @ObservedObject var home: HomeConnectorsModel
    let leave: (@escaping @MainActor () -> Void) -> Void
    @State private var choosing = false
    @State private var chosen: String?

    private var icon: Cockpit.Icon { Cockpit.Icon(rawValue: kind.icon) ?? .file }

    private var begun: Bool { !kind.coming.isEmpty || !kind.held.isEmpty }

    var body: some View {
        let said = Set(kind.held.map(\.health.words))
        if let wait = kind.wait, !wait.isEmpty {
            WaitTag(wait).accessibilityIdentifier("import.wait")
        }
        ForEach(report.needs.filter { $0.connector == kind.kind && !said.contains($0.words) }) { need in
            StreamActs(need.words, state: need.state, acts: need.acts.filter { $0.do != .import }, detail: need.line, unit: unit,
                       home: home, identifier: "import.need.\(need.id)")
        }
        steps
        if !kind.coming.isEmpty {
            SheetPart(kind.titles.held) {
                files(kind.coming)
            }
            .accessibilityIdentifier("import.coming")
        }
        ForEach(Array(kind.held.enumerated()), id: \.element.id) { index, held in
            ImportHeldPart(held: held, label: index == 0 && kind.coming.isEmpty ? kind.titles.held : nil, icon: icon,
                           unit: unit, home: home, leave: leave) { files($0, after: $1) }
        }
    }

    @ViewBuilder private var steps: some View {
        let guide = kind.guide
        let last = guide.count + 1
        VStack(alignment: .leading, spacing: 0) {
            if begun {
                StepRow(1, done: true, title: ImportWords.done, words: guide.map(ImportWords.title).joined(separator: Words.dot))
                    .accessibilityIdentifier("import.guide")
            } else {
                ForEach(Array(guide.enumerated()), id: \.offset) { index, step in
                    GuideStepRow(index + 1, step: step, identifier: "import.guide.open")
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("import.guide")
            }
            StepRow(last, title: ImportWords.choose(kind), words: kind.lists == nil ? chosen : StreamsWords.act, separator: false) {
                if kind.lists == nil {
                    Button { choosing = true } label: {
                        HStack(spacing: Cockpit.Space.s1) {
                            Icon(.file, size: .xs)
                            Text(ImportWords.files)
                        }
                    }
                    .buttonStyle(.cockpit(begun ? .secondary : .primary, size: .small))
                    .accessibilityIdentifier("import.choose")
                }
            }
            .accessibilityIdentifier("import.drop")
        }
        .fileImporter(isPresented: $choosing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            chosen = ImportWords.send(urls)
        }
    }

    @ViewBuilder private func files(_ files: [HomeLink.Import.File], after: Bool = false) -> some View {
        ForEach(Array(files.enumerated()), id: \.element.id) { index, file in
            let act = file.acts.first { $0.taken(by: unit) }
            ListRow(file.name, meta: [file.words, file.line].filter { !$0.isEmpty }.joined(separator: " · "), lines: 2, leading: .symbol(.file),
                    separator: index < files.count - 1 || after,
                    control: act.map { act in .act(act.label, busy: home.busy(act)) { Task { await home.press(need: act.need ?? "", act.do) } } })
                .accessibilityIdentifier("import.file.\(file.id)")
        }
    }
}

struct GuideStepRow: View {
    let number: Int
    let step: HomeLink.Import.Step
    let separator: Bool
    let identifier: String
    @Environment(\.openURL) private var openURL

    init(_ number: Int, step: HomeLink.Import.Step, separator: Bool = true, identifier: String) {
        self.number = number
        self.step = step
        self.separator = separator
        self.identifier = identifier
    }

    var body: some View {
        StepRow(number, title: ImportWords.title(step), words: step.title == nil ? nil : step.words, separator: separator) {
            if let open = step.open, let url = URL(string: open.url) {
                Button { openURL(url) } label: {
                    HStack(spacing: Cockpit.Space.s1) {
                        Text(open.label)
                        Icon(.openOut, size: .xs)
                    }
                }
                .buttonStyle(.cockpit(.secondary, size: .small))
                .accessibilityIdentifier(identifier)
            }
        }
    }
}

struct ImportHeldPart<Files: View>: View {
    let held: HomeLink.Import.Held
    let label: String?
    let icon: Cockpit.Icon
    let unit: String?
    @ObservedObject var home: HomeConnectorsModel
    let leave: (@escaping @MainActor () -> Void) -> Void
    let files: ([HomeLink.Import.File], Bool) -> Files
    @State private var typed = ""

    private var need: String { ImportWords.whose(held.id) }

    var body: some View {
        let health = held.health
        if let ask = held.ask {
            let busy = home.choosing.contains(need)
            Callout(ask.words, signal: HomeLink.State.needsYou.signal, acts: [], identifier: "import.held.\(held.id).ask")
            Card(group: true) {
                ForEach(Array(ask.choices.enumerated()), id: \.offset) { index, account in
                    ListRow(account, leading: .symbol(.online), separator: index < ask.choices.count - 1 || ask.other,
                            control: .act(ask.choose, busy: busy) { answer(account, ask) })
                        .accessibilityIdentifier("import.held.\(held.id).choice.\(index)")
                }
                if ask.other {
                    AddRow(ask.another, text: $typed) {
                        let account = typed.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !account.isEmpty else { return }
                        answer(account, ask)
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("import.held.\(held.id).other")
                }
            }
            if let failed = home.chooseFailed[need], !busy {
                InPlaceLine(InPlaceLine.Said(failed.said), retry: failed.said == .notSent ? { answer(failed.account, ask) } : nil)
                    .accessibilityIdentifier("import.held.\(held.id).failure")
            }
        } else if ![.ok, .syncing].contains(health.state), !health.words.isEmpty {
            StreamActs(health.words, state: health.state, acts: health.acts.filter { $0.do != .import }, detail: health.line, unit: unit,
                       home: home, identifier: "import.held.\(held.id).state")
        }
        SheetPart(label) {
            let open = held.openDay.flatMap { day in held.open.map { (day: day, words: $0) } }
            let tail = held.downloaded != nil || open != nil
            ListRow(held.name, meta: held.line, signal: health.state.rowSignal, lines: 2, leading: .symbol(icon),
                    known: true, separator: !held.files.isEmpty || !held.products.isEmpty || tail) { EmptyView() }
                .accessibilityIdentifier("import.held.\(held.id)")
            files(held.files, !held.products.isEmpty || tail)
            ForEach(held.products, id: \.id) { product in
                ListRow(product.name, meta: ImportWords.meta(product), separator: product.id != held.products.last?.id || tail) { EmptyView() }
            }
            if let downloaded = held.downloaded {
                ListRow(downloaded, wraps: true, separator: open != nil) { EmptyView() }
                    .accessibilityIdentifier("import.held.\(held.id).downloaded")
            }
            if let open {
                ListRow(open.words, leading: .symbol(.days), chevron: true, separator: false,
                        action: { leave { AppNavigation.shared.open(.day(open.day), in: .days) } })
                    .accessibilityIdentifier("import.held.\(held.id).day")
            }
        }
    }

    private func answer(_ account: String, _ ask: HomeLink.Import.Held.Ask) {
        Task {
            if await home.choose(need: need, account: account) { typed = "" }
        }
    }
}

enum ImportWords {
    static let done = "Asked and downloaded"
    static func choose(_ kind: HomeLink.Import) -> String { "Choose the \(kind.file)" }
    static let files = "Choose from Files"
    static let sent = "Sending to Lifestream"
    static let unsent = "Couldn’t take that file. Try again."

    static func head(_ kind: HomeLink.Import) -> String {
        let reads = Self.reads(kind)
        return reads.isEmpty ? kind.takes : reads
    }

    static func title(_ step: HomeLink.Import.Step) -> String { step.title ?? step.words }

    @MainActor static func send(_ urls: [URL]) -> String {
        guard let inbox = UploadInbox.shared(appGroup: AppGroup.identifier) else { return unsent }
        var taken = 0
        for url in urls {
            let opened = url.startAccessingSecurityScopedResource()
            defer { if opened { url.stopAccessingSecurityScopedResource() } }
            let type = (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType?.preferredMIMEType) ?? nil
            if (try? inbox.publish(file: url, name: url.lastPathComponent, mediaType: type ?? "application/octet-stream")) != nil { taken += 1 }
        }
        return taken == urls.count ? sent : unsent
    }

    static func reads(_ kind: HomeLink.Import) -> String {
        kind.products.isEmpty ? kind.reads ?? "" : kind.products.map(\.name).joined(separator: " · ")
    }

    static func meta(_ product: HomeLink.Import.Held.Product) -> String? {
        let lead = product.name + Words.dot
        if product.line.hasPrefix(lead) { return String(product.line.dropFirst(lead.count)) }
        return product.line == product.name || product.line.isEmpty ? nil : product.line
    }

    static func whose(_ id: String) -> String { "import:\(id):whose" }
}

struct StreamQuietGroups: View {
    let count: Int
    var separator = false

    var body: some View {
        ListRow("Quiet in " + Words.count(count, "group"), chevron: true, separator: separator,
                action: { PeopleTabModel.shared.showQuietGroups() })
            .accessibilityIdentifier("connector.detail.quiet")
    }
}

struct StreamCallout: View {
    let connector: HomeLink.Connector
    let unit: String?
    @ObservedObject var home: HomeConnectorsModel
    var grantDrawn = false

    var body: some View {
        let health = connector.health
        if connector.paused(.all) != nil {
            Callout(ConnectorWords.paused, signal: HomeLink.State.paused.signal, acts: [], identifier: "connector.detail.paused")
        }
        if Self.says(connector), health.state != .setup {
            let elsewhere = health.acts.contains { !$0.taken(by: unit, on: connector) }
            StreamActs(health.words, state: health.state, acts: health.acts,
                       detail: elsewhere ? StreamsWords.act : health.line, unit: unit, connector: connector, home: home,
                       identifier: "connector.detail.state")
        }
        ForEach((home.answer?.callout(of: connector.id) ?? []).filter { !(grantDrawn && $0.unit == unit && $0.reason == .grant) }) { need in
            StreamActs(need.words, state: need.state, acts: need.acts, detail: need.line, unit: unit, connector: connector, home: home,
                       identifier: "connector.detail.need.\(need.id)")
        }
    }
}

extension StreamCallout {
    static func says(_ connector: HomeLink.Connector) -> Bool {
        let health = connector.health
        return ![.ok, .syncing].contains(health.state) && !(health.state == .paused && connector.paused(.all) != nil)
    }
}

struct StreamActs: View {
    let words: String
    let state: HomeLink.State
    let acts: [HomeLink.Act]
    let steps: [String]
    let detail: String?
    let unit: String?
    let connector: HomeLink.Connector?
    @ObservedObject var home: HomeConnectorsModel
    let identifier: String
    @Environment(\.openURL) private var openURL
    @Environment(\.allowSource) private var allow
    @Environment(\.openConnectors) private var page
    @Environment(\.openFeedback) private var feedback

    init(_ words: String, state: HomeLink.State, acts: [HomeLink.Act], steps: [String] = [], detail: String?, unit: String?,
         connector: HomeLink.Connector? = nil, home: HomeConnectorsModel, identifier: String) {
        self.words = words
        self.state = state
        self.acts = acts
        self.steps = steps
        self.detail = detail
        self.unit = unit
        self.connector = connector
        self.home = home
        self.identifier = identifier
    }

    var body: some View {
        let buttons = acts.filter { $0.taken(by: unit, on: connector) && ($0.do != .report || feedback != nil) }.map { act in
            Callout.Act(act.label, id: act.do.rawValue, busy: home.busy(act), words: act.do == .report) {
                if act.do == .report, let of = act.of {
                    feedback?(.connector(of), name: connector?.name)
                } else {
                    home.perform(act, on: connector, open: openURL, allow: allow, page: page)
                }
            }
        }
        Callout(words, detail: detail, steps: steps, signal: state.signal, acts: buttons, identifier: identifier)
    }
}

struct HomeSourcesPage: View {
    let id: String
    @ObservedObject var home: HomeConnectorsModel

    var body: some View {
        if let connector = home.read?.connectors.first(where: { $0.id == id }) {
            PageDrawer(connector.name) {
                SheetPart(connector.name, note: StreamsWords.act) {
                    StreamCopies(copies: connector.copies, after: false)
                }
            }
        }
    }
}

struct HomeListPage: View {
    let id: String
    let member: String
    @ObservedObject var home: HomeConnectorsModel
    @State private var kept: [String] = []
    @State private var typed = ""

    var body: some View {
        if let connector = home.read?.connectors.first(where: { $0.id == id }),
           let field = connector.members.first(where: { $0.key == member }) {
            let key = MemberChanges.key(id, member)
            let busy = home.changes.busy.contains(key)
            let values = Self.values(field.value)
            let rows = values + kept.filter { !values.contains($0) }
            PageDrawer(field.label) {
                SheetPart(connector.name, line: field.about) {
                    ForEach(rows, id: \.self) { value in
                        let on = values.contains(value)
                        SettingRow(value) {
                            Toggle(value, isOn: Binding(get: { on }, set: { next in
                                if !next, !kept.contains(value) { kept.append(value) }
                                change(connector, field, next ? values + [value] : values.filter { $0 != value })
                            }))
                            .labelsHidden()
                            .toggleStyle(.cockpit)
                            .disabled(busy)
                            .accessibilityIdentifier("connector.list.\(value)")
                        }
                    }
                    AddRow(field.add ?? field.label, text: $typed) {
                        let value = typed.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !value.isEmpty, !values.contains(value) else { return }
                        typed = ""
                        change(connector, field, values + [value])
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("connector.list.add")
                }
                if let problem = home.changes.problem(key, read: home.failure) {
                    Text(problem).cockpit(.footnote).foregroundStyle(Cockpit.Color.warning)
                }
                MemberFailure(connector: connector, member: member, home: home)
            }
        }
    }

    private func change(_ connector: HomeLink.Connector, _ field: HomeLink.Connector.Member, _ values: [String]) {
        Task { await home.set(connector, member, .array(values.map { .string($0) }), was: field.value) }
    }

    static func values(_ value: HomeLink.JSON?) -> [String] {
        guard case .array(let items) = value else { return [] }
        return items.map(\.key).filter { !$0.isEmpty }
    }
}

struct HomeZonePage: View {
    let id: String
    let member: String
    @ObservedObject var home: HomeConnectorsModel
    @State private var query = ""

    var body: some View {
        if let connector = home.read?.connectors.first(where: { $0.id == id }),
           let field = connector.members.first(where: { $0.key == member }) {
            let key = MemberChanges.key(id, member)
            let at = field.value?.key ?? ""
            let typed = query.trimmingCharacters(in: .whitespaces)
            let zones = StreamSettings.zones(at).map { ($0, StreamSettings.zoneWords($0)) }
                .filter { typed.isEmpty || $0.1.localizedCaseInsensitiveContains(typed) || $0.0.localizedCaseInsensitiveContains(typed) }
            PageDrawer(field.label) {
                SearchField(text: $query, placeholder: "Find a time zone")
                SheetPart(connector.name) {
                    if !zones.isEmpty {
                        LazyVStack(spacing: 0) {
                            ForEach(zones, id: \.0) { zone, words in
                                ListRow(words, separator: zone != zones.last?.0, action: {
                                    guard zone != at else { return }
                                    Task { await home.set(connector, member, .string(zone), was: field.value) }
                                }) {
                                    if zone == at { Icon(.done, size: .sm).foregroundStyle(Cockpit.Color.engaged) }
                                }
                                .accessibilityAddTraits(zone == at ? .isSelected : [])
                                .accessibilityIdentifier("connector.zone.\(zone)")
                            }
                        }
                        .disabled(home.changes.busy.contains(key))
                    }
                }
                if let problem = home.changes.problem(key, read: home.failure) {
                    Text(problem).cockpit(.footnote).foregroundStyle(Cockpit.Color.warning)
                }
                MemberFailure(connector: connector, member: member, home: home)
            }
        }
    }
}

struct StreamFigure: View {
    let today: Int?
    let noun: (String, String)?
    let week: [Int]?
    let day: String

    var body: some View {
        let counted = today == nil
        let today = self.today ?? 0
        let week = counted ? Array(repeating: 0, count: 7) : self.week ?? []
        let days = StreamsWords.daysEnding(day, count: week.count)
        WeekFigure(counted ? "00" : Words.count(today),
                   words: [noun.map { named(today, $0) }, "today"].compactMap { $0 }.joined(separator: " "),
                   bars: week.indices.map { index in
                       WeekFigure.Bar(count: week[index], noun: noun.map { named(week[index], $0) }, when: days[index])
                   },
                   bare: true,
                   marked: .busiest(week))
            .reading(counted)
            .accessibilityIdentifier("connector.detail.week")
    }

    private func named(_ count: Int, _ noun: (String, String)) -> String { count == 1 ? noun.0 : noun.1 }
}
