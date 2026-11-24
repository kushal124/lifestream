import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

@MainActor
final class AgentsStore: ObservableObject {
    static let shared = AgentsStore(link: AppRuntime.shared.shipping.link)

    @Published private(set) var list: HomeLink.AgentList?
    @Published private(set) var listFailed = false
    @Published private(set) var reads: [String: HomeLink.AgentRead] = [:]
    @Published private(set) var failed: Set<String> = []
    @Published private(set) var histories: [String: HomeLink.HistoryPage] = [:]
    @Published private(set) var earlier: Set<String> = []
    @Published private(set) var ending: Set<String> = []
    @Published private(set) var endFailed: [String: String] = [:]
    @Published private(set) var picked: [String: String] = [:]
    @Published private(set) var picking: Set<String> = []
    @Published private(set) var readPages: [String: HomeLink.ReadPage] = [:]
    @Published private(set) var readFailed: [String: String] = [:]
    @Published private(set) var things: [String: HomeLink.ThingsPage] = [:]
    @Published private(set) var thingsFailed: [String: String] = [:]
    @Published private(set) var moreThings: Set<String> = []
    @Published private(set) var guides: HomeLink.AgentGuides?
    private var editors: [String: AccessEditorModel] = [:]
    private let link: HomeLink

    init(link: HomeLink) {
        self.link = link
    }

    func readList() async {
        do {
            list = try await link.agents()
            listFailed = false
        } catch {
            listFailed = list == nil
        }
    }

    func readGuides() async {
        guard let read = try? await link.guides() else { return }
        guides = read
    }

    func readAll() async {
        async let list: Void = readList()
        async let guides: Void = readGuides()
        _ = await (list, guides)
    }

    func read(_ id: String) async {
        do {
            let read = try await link.agent(id)
            reads[id] = read
            failed.remove(id)
            if editors[id]?.busy != true, editors[id]?.waits != true { editors[id] = AccessEditorModel(link: link, reader: read) }
        } catch {
            if reads[id] == nil { failed.insert(id) }
        }
    }

    func readHistory(_ id: String) async {
        let kind = picked[id]
        guard let page = try? await link.agentHistory(id, kind: kind), picked[id] == kind else { return }
        histories[id] = page
    }

    func pick(_ id: String, kind: String?) async {
        guard picked[id] != kind else { return }
        picked[id] = kind
        picking.insert(id)
        await readHistory(id)
        if picked[id] == kind { picking.remove(id) }
    }

    func readEarlier(_ id: String) async {
        guard let page = histories[id], let next = page.next, earlier.insert(id).inserted else { return }
        defer { earlier.remove(id) }
        let kind = picked[id]
        guard let more = try? await link.agentHistory(id, before: next.before, kind: kind), picked[id] == kind,
              histories[id] == page else { return }
        histories[id] = page.joined(more)
    }

    static func key(_ id: String, _ call: String) -> String { id + "/" + call }

    func readPage(_ id: String, call: String) async {
        let key = Self.key(id, call)
        do {
            readPages[key] = try await link.agentRead(id, call: call)
            readFailed[key] = nil
        } catch {
            if readPages[key] == nil { readFailed[key] = Self.said(error) }
        }
    }

    func readThings(_ id: String, call: String) async {
        let key = Self.key(id, call)
        do {
            things[key] = try await link.agentThings(id, call: call)
            thingsFailed[key] = nil
        } catch {
            if things[key] == nil { thingsFailed[key] = Self.said(error) }
        }
    }

    func readMoreThings(_ id: String, call: String) async {
        let key = Self.key(id, call)
        guard let page = things[key], let next = page.next, moreThings.insert(key).inserted else { return }
        defer { moreThings.remove(key) }
        guard let more = try? await link.agentThings(id, call: call, before: next), things[key] == page else { return }
        things[key] = page.joined(more)
    }

    private static func said(_ error: Error) -> String {
        switch error as? LinkFailure {
        case .refused(_, _, let message), .unavailable(_, let message?, _, _): message
        default: AgentsWords.unreached
        }
    }

    func disconnect(_ id: String) async -> Bool {
        await end(id) {
            let read = try await self.link.disconnect(id)
            self.reads[id] = read
            self.editors[id] = nil
            await self.readList()
        }
    }

    func unlist(_ id: String) async -> Bool {
        await end(id) {
            self.list = try await self.link.unlist(id)
            self.reads[id] = nil
            self.histories[id] = nil
        }
    }

    private func end(_ id: String, _ act: () async throws -> Void) async -> Bool {
        guard ending.insert(id).inserted else { return false }
        defer { ending.remove(id) }
        endFailed[id] = nil
        do {
            try await act()
            return true
        } catch {
            endFailed[id] = switch error as? LinkFailure {
            case .refused(_, _, let message), .unavailable(_, let message?, _, _): message
            default: AgentAsks.unsent
            }
            return false
        }
    }

    func editor(_ id: String) -> AccessEditorModel? {
        if let editor = editors[id] { return editor }
        guard let read = reads[id] else { return nil }
        let editor = AccessEditorModel(link: link, reader: read)
        editors[id] = editor
        return editor
    }

    func name(_ id: String) -> String {
        reads[id]?.name ?? list?.readers.first { $0.id == id }?.name ?? ""
    }

    func title(_ route: ConnectorsRoute) -> String {
        switch route {
        case .agents: AgentsWords.page
        case .connect: guides?.page.title ?? ""
        case .agent(let id): name(id)
        case .access(_, nil): AgentsWords.reads
        case .access(let id, let part?): part.title(in: editors[id]?.view)
        case .history: AgentsWords.history
        case .read(let id, let call): readPages[Self.key(id, call)]?.title ?? AgentsWords.history
        case .things(let id, let call): things[Self.key(id, call)]?.title ?? ""
        case .disconnect(let id): reads[id]?.disconnect?.head ?? name(id)
        default: ""
        }
    }

    nonisolated static func icon(_ kind: HomeLink.AgentRow.Kind) -> Cockpit.Icon {
        kind == .chat ? .chat : .codingAgent
    }

    nonisolated static func mark(_ name: String) -> Cockpit.Icon {
        Cockpit.Icon(rawValue: name) ?? .aiApps
    }
}

extension ConnectorsRoute {
    var agents: Bool {
        switch self {
        case .agents, .connect, .agent, .access, .history, .read, .things, .disconnect: true
        default: false
        }
    }
}

struct AgentsTab: View {
    @State private var path: [ConnectorsRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            AgentsPage()
                .navigationDestination(for: ConnectorsRoute.self) { route in
                    AgentsDestination(route: route)
                }
        }
        .environment(\.openConnectors, OpenConnectorsAction { path.append($0) })
        .environment(\.drawerAsPage, true)
        .tint(Cockpit.Color.text)
        .task {
            let pushed = AppNavigation.designPush.filter { $0.agents && $0 != .agents }
            guard !pushed.isEmpty else { return }
            await AgentsStore.shared.readAll()
            path = pushed
        }
    }
}

struct AgentsDestination: View {
    let route: ConnectorsRoute

    var body: some View {
        Group {
            switch route {
            case .agents: AgentsPage()
            case .connect: ConnectPage()
            case .agent(let id): AgentPage(id: id)
            case .access(let id, let part): AccessDestination(id: id, part: part)
            case .history(let id): HistoryPage(id: id)
            case .read(let id, let call): ReadPage(id: id, call: call)
            case .things(let id, let call): ThingsPage(id: id, call: call)
            case .disconnect(let id): DisconnectPage(id: id)
            default: EmptyView()
            }
        }
        .environment(\.cockpitPartsFlat, true)
    }
}

private struct AccessDestination: View {
    let id: String
    let part: AccessRoute?
    @ObservedObject private var store = AgentsStore.shared
    @Environment(\.openConnectors) private var open

    var body: some View {
        if let editor = store.editor(id) {
            AccessPushed(model: editor, route: part, push: { open(.access(id, $0)) })
        } else {
            PageDrawer(AgentsWords.reads) { ProgressView().frame(maxWidth: .infinity) }
                .task { await store.read(id) }
        }
    }
}

struct AgentsListing: Equatable {
    struct Row: Equatable, Identifiable {
        let id: String
        let name: String
        let line: String
        let end: String?
        let icon: Cockpit.Icon
    }

    private(set) var connected: [Row] = []
    private(set) var chat: [Row] = []
    private(set) var disconnected: [Row] = []

    init(_ list: HomeLink.AgentList) {
        for reader in list.readers {
            let row = Row(id: reader.id, name: reader.name, line: reader.summary,
                          end: reader.state == .connected ? reader.reads.last : nil, icon: AgentsStore.mark(reader.mark))
            if reader.kind == .chat {
                chat.append(row)
            } else if reader.state == .connected {
                connected.append(row)
            } else {
                disconnected.append(row)
            }
        }
    }
}

private struct AgentsPage: View {
    @ObservedObject private var store = AgentsStore.shared
    @ObservedObject private var asks = AppRuntime.shared.agents
    @Environment(\.openConnectors) private var open

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Cockpit.Space.s8) {
                content
            }
            .environment(\.cockpitRowsBare, true)
            .padding(.horizontal, Cockpit.Space.s5)
            .padding(.top, Cockpit.Space.s5)
            .padding(.bottom, Cockpit.Space.s6)
        }
        .tabRoot(AgentsWords.page)
        .groundColor(Cockpit.Color.canvas)
        .task { await store.readAll() }
        .refreshable { await store.readAll() }
        .accessibilityIdentifier("agents.page")
    }

    @ViewBuilder private var content: some View {
        if let listing = store.list.map(AgentsListing.init) {
            let waiting = asks.asks.filter { $0.state == .open }
            if !waiting.isEmpty {
                Card(AgentsWords.needsYou, group: true, flat: true) {
                    ForEach(waiting) { ask in
                        ListRow(ask.name, meta: ask.line, leading: .tile(.codingAgent), separator: ask.id != waiting.last?.id,
                                control: .act(AgentsWords.review, busy: false) { asks.review(ask) },
                                action: { open(.agent(ask.reader)) }) { EmptyView() }
                            .accessibilityIdentifier("agents.ask.\(ask.id)")
                    }
                }
            }
            if listing.connected.isEmpty {
                if let guides = store.guides {
                    Card(guides.page.title, group: true, flat: true) { GuideRows(guides: guides) }
                        .accessibilityIdentifier("agents.guides")
                }
            } else {
                Card(AgentsWords.connected, group: true, flat: true) {
                    rows(listing.connected, last: store.guides == nil)
                    if let guides = store.guides {
                        ListRow(guides.page.title, leading: .icon(.add), chevron: false, separator: false, action: { open(.connect) })
                            .accessibilityIdentifier("agents.connect")
                    }
                }
            }
            part(AgentsWords.inLifestream, listing.chat)
            part(AgentsWords.disconnected, listing.disconnected)
        } else if store.listFailed {
            PageLack(AgentsWords.unreached) { Task { await store.readAll() } }
        } else {
            ProgressView().frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder private func part(_ title: String, _ rows: [AgentsListing.Row]) -> some View {
        if !rows.isEmpty {
            Card(title, group: true, flat: true) { self.rows(rows, last: true) }
        }
    }

    private func rows(_ rows: [AgentsListing.Row], last: Bool) -> some View {
        ForEach(rows) { row in
            ListRow(row.name, meta: row.line, leading: .tile(row.icon), chevron: true, separator: !last || row.id != rows.last?.id,
                    action: { open(.agent(row.id)) }) {
                row.end.map { RowEnd(.time($0)) }
            }
            .accessibilityIdentifier("agents.row.\(row.id)")
        }
    }
}

private struct ConnectPage: View {
    @ObservedObject private var store = AgentsStore.shared

    var body: some View {
        PageDrawer(store.guides?.page.title ?? "") {
            if let guides = store.guides {
                SheetPart(nil) { GuideRows(guides: guides) }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .task { await store.readGuides() }
        .accessibilityIdentifier("agents.picker")
    }
}

struct AgentPageParts: Equatable {
    let line: String
    let amount: String
    let noun: String
    let reads: String
    let far: String
    let hides: String?
    let recent: HomeLink.HistoryRead?
    let none: String
    let all: Bool
    let connection: String?
    let disconnect: String?

    init(_ read: HomeLink.AgentRead, view: HomeLink.AccessView) {
        line = read.disconnected ?? read.reads.short
        amount = Words.count(read.figure.today)
        noun = read.figure.words
        reads = view.reads
        far = view.window.words
        hides = view.hide?.words
        recent = read.recent.lines.first
        none = read.reads.line
        all = read.recent.all != nil
        connection = read.kind == .agent ? read.how : nil
        disconnect = read.disconnect.map { $0.confirm + "\u{2026}" }
    }
}

private struct AgentPage: View {
    let id: String
    @ObservedObject private var store = AgentsStore.shared

    var body: some View {
        Group {
            if let read = store.reads[id], let model = store.editor(id) {
                AgentPageBody(id: id, read: read, model: model)
            } else if store.failed.contains(id) {
                PageDrawer(store.name(id)) {
                    PageLack(AgentsWords.unreached) { Task { await store.read(id) } }
                }
            } else {
                PageDrawer(store.name(id)) { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .task { await store.read(id) }
        .accessibilityIdentifier("agent.page")
    }
}

private struct AgentPageBody: View {
    let id: String
    let read: HomeLink.AgentRead
    @ObservedObject var model: AccessEditorModel
    @ObservedObject private var store = AgentsStore.shared
    @ObservedObject private var asks = AppRuntime.shared.agents
    @Environment(\.openConnectors) private var open
    @Environment(\.dismiss) private var dismiss
    @State private var unlisting = false

    private var connected: Bool { read.state == .connected }

    var body: some View {
        let view = model.view ?? read.view
        let parts = AgentPageParts(read, view: view)
        PageDrawer(read.name, icon: AgentsStore.mark(read.mark), line: parts.line) {
            if connected, let ask = asks.polled ? asks.asks.first(where: { $0.reader == id && $0.state == .open }) : read.ask {
                Callout(ask.head, detail: Words.phrase(ask.underLine), signal: .caution, action: AgentsWords.review, primary: true, identifier: "agent.ask") {
                    asks.review(ask)
                }
            }
            figure(parts)
            if connected {
                access(view, parts)
                if let trouble = model.trouble { InPlaceLine(trouble) }
            }
            history(parts)
            if let connection = parts.connection {
                SheetPart(AgentsWords.connection) {
                    SettingRow(connection, separator: false, lead: .icon(.link))
                }
            }
            if let trouble = store.endFailed[id] { InPlaceLine(trouble) }
            if let words = parts.disconnect {
                end(words, identifier: "agent.disconnect") { open(.disconnect(id)) }
            } else if read.unlist != nil {
                end(AgentsWords.removeFromList, identifier: "agent.unlist") { unlisting = true }
            }
        } foot: {
            if connected, model.dock != .none { AccessDock(model: model) }
        }
        .confirmationDialog(read.unlist?.ask ?? "", isPresented: $unlisting, titleVisibility: .visible) {
            Button(AgentsWords.remove, role: .destructive) {
                Task { if await store.unlist(id) { dismiss() } }
            }
        } message: {
            Text(read.unlist?.line ?? "")
        }
    }

    private func figure(_ parts: AgentPageParts) -> some View {
        WeekFigure(parts.amount, words: parts.noun,
                   bars: read.figure.days.map { WeekFigure.Bar(count: $0.n, when: $0.words) },
                   labels: read.figure.days.map(\.words), marked: .last)
            .accessibilityIdentifier("agent.figure")
    }

    private func access(_ view: HomeLink.AccessView, _ parts: AgentPageParts) -> some View {
        SheetPart(AgentsWords.access) {
            SettingRow(AgentsWords.reads, line: parts.reads, opens: { open(.access(id, nil)) })
                .accessibilityIdentifier("agent.reads")
            SettingRow(AgentsWords.howFarBack, separator: view.hide != nil) {
                MenuRow(AgentsWords.howFarBack, selection: far(view), options: view.times.indices.map { MenuRow.Option($0, view.times[$0].words, apart: view.times[$0].choice == .since) },
                        busy: model.busy, words: parts.far, flush: .trailing)
            }
            .accessibilityIdentifier("agent.time")
            if let hiding = view.hide, let words = parts.hides {
                SettingRow(AgentsWords.hides, separator: false) {
                    MenuRow(AgentsWords.hides, selection: hides(hiding),
                            options: hiding.choices.map { MenuRow.Option($0.level, $0.words, note: $0.line) },
                            busy: model.busy, words: words, flush: .trailing)
                }
                .accessibilityIdentifier("agent.hides")
            }
        }
    }

    private func far(_ view: HomeLink.AccessView) -> Binding<Int> {
        Binding(get: { view.times.firstIndex { AccessEditorModel.picks($0, view.window) } ?? -1 }, set: { index in
            let time = view.times[index]
            model.far(time)
            if time.choice == .since { open(.access(id, .time(.all))) }
        })
    }

    private func hides(_ hiding: HomeLink.AccessView.Hiding) -> Binding<HomeLink.HideChoice> {
        Binding(get: { hiding.choice }, set: { level in
            model.hide(level)
            if level == .custom { open(.access(id, .custom)) }
        })
    }

    private func history(_ parts: AgentPageParts) -> some View {
        SheetPart(AgentsWords.history, action: parts.all ? AgentsWords.seeAll : nil, perform: { open(.history(id)) },
                  actionIdentifier: "agent.history.all") {
            if let recent = parts.recent {
                ReadRow(read: recent, reader: id, separator: false, identifier: "agent.history.row.\(recent.id)")
            } else {
                SettingRow(parts.none, separator: false)
            }
        }
    }

    private func end(_ words: String, identifier: String, _ act: @escaping () -> Void) -> some View {
        Button(action: act) {
            Text(words).cockpit(.body).foregroundStyle(Cockpit.Color.warning)
                .frame(maxWidth: .infinity, minHeight: Cockpit.Size.controlMd, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(store.ending.contains(id))
        .accessibilityIdentifier(identifier)
    }
}

private struct DisconnectPage: View {
    let id: String
    @ObservedObject private var store = AgentsStore.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        if let read = store.reads[id], let words = read.disconnect {
            PageDrawer(words.head, line: words.line) {
                ended(AgentsWords.stops, words.stops)
                ended(AgentsWords.stays, words.stays)
                if let trouble = store.endFailed[id] { InPlaceLine(trouble) }
            } foot: {
                Button(words.confirm) {
                    Task { if await store.disconnect(id) { dismiss() } }
                }
                .buttonStyle(.cockpit(.primary, tone: .warning, size: .large, busy: store.ending.contains(id), fullWidth: true))
                .accessibilityIdentifier("disconnect.confirm")
            }
            .accessibilityIdentifier("disconnect.page")
        } else {
            PageDrawer(store.name(id)) { ProgressView().frame(maxWidth: .infinity) }
                .task { await store.read(id) }
        }
    }

    private func ended(_ title: String, _ rows: [HomeLink.Disconnecting.Ended]) -> some View {
        SheetPart(title) {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                SettingRow(row.name, line: row.line, separator: index < rows.count - 1)
            }
        }
    }
}

struct HistoryLines: View {
    let reader: String
    let key: String
    let lines: [HomeLink.HistoryLine]
    @Binding var opened: Set<String>
    @ObservedObject private var asks = AppRuntime.shared.agents

    static let indent: CGFloat = 40

    var body: some View {
        ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
            let at = key + "/\(index)"
            let last = index == lines.count - 1
            switch line {
            case .read(let read): ReadRow(read: read, reader: reader, separator: !last)
            case .change(let change): changed(change, separator: !last)
            case .fold(let fold):
                let open = opened.contains(at)
                SettingRow(fold.words, line: fold.line, separator: !last || open, lead: .icon(HistoryLines.icon(fold.icon)),
                           opens: { toggle(at) }) {
                    RowEnd(.time(AgentsWords.time(fold.atMs)))
                }
                .topAligned()
                .accessibilityAddTraits(open ? .isSelected : [])
                .accessibilityIdentifier("history.fold")
                if open {
                    ForEach(Array(fold.lines.enumerated()), id: \.offset) { inner, read in
                        ReadRow(read: read, reader: reader, separator: !last || inner < fold.lines.count - 1)
                            .padding(.leading, Self.indent)
                    }
                }
            }
        }
    }

    private func changed(_ change: HomeLink.HistoryChange, separator: Bool) -> some View {
        let waiting = change.tone == .waiting
        let icon = HistoryLines.icon(change.icon)
        return SettingRow(change.words, line: change.line, separator: separator, lead: waiting ? .toned(icon, .caution) : .icon(icon)) {
            if waiting, let ask = change.ask.flatMap(asks.listed) {
                Button(AgentsWords.review) { asks.review(ask) }
                    .buttonStyle(.cockpit(.secondary, size: .small))
                    .accessibilityIdentifier("history.review.\(ask.id)")
            } else {
                RowEnd(.time(AgentsWords.time(change.atMs)))
            }
        }
        .topAligned()
        .accessibilityIdentifier("history.change")
    }

    static func icon(_ name: String) -> Cockpit.Icon {
        Cockpit.Icon(rawValue: name) ?? .search
    }

    private func toggle(_ at: String) {
        withAnimation(.easeOut(duration: Cockpit.Duration.fast)) {
            if opened.remove(at) == nil { opened.insert(at) }
        }
    }
}

private struct ReadRow: View {
    let read: HomeLink.HistoryRead
    let reader: String
    var separator = true
    var identifier = "history.read"
    @Environment(\.openConnectors) private var open

    var body: some View {
        let refused = read.tone == .refused
        let icon = HistoryLines.icon(read.icon)
        SettingRow(read.words, problem: refused ? read.line : nil, line: refused ? nil : read.line, note: read.kept, separator: separator,
                   lead: refused ? .toned(icon, .warning) : .icon(icon), opens: opens) {
            RowEnd(.time(AgentsWords.time(read.atMs)))
        }
        .topAligned()
        .accessibilityIdentifier(identifier)
    }

    private var opens: (() -> Void)? {
        guard read.opens else { return nil }
        let route = ConnectorsRoute.read(reader, read.id)
        return { open(route) }
    }
}

struct HistoryDays: Equatable {
    struct Day: Equatable, Identifiable {
        let id: String
        let words: String
        let reads: String?
        let lines: [HomeLink.HistoryLine]
    }

    let days: [Day]

    init(_ sessions: [HomeLink.HistoryPage.Session]) {
        var days: [Day] = []
        for session in sessions {
            if let at = days.indices.last, days[at].id == session.day.day {
                days[at] = Day(id: days[at].id, words: days[at].words, reads: days[at].reads ?? session.day.reads, lines: days[at].lines + session.lines)
            } else {
                days.append(Day(id: session.day.day, words: session.day.words, reads: session.day.reads, lines: session.lines))
            }
        }
        self.days = days
    }
}

private struct HistoryPage: View {
    let id: String
    @ObservedObject private var store = AgentsStore.shared
    @State private var opened: Set<String> = []

    var body: some View {
        PageDrawer(AgentsWords.history) {
            if let page = store.histories[id] {
                if let empty = page.empty {
                    SheetPart(nil) {
                        SettingRow(empty.title, line: empty.line, separator: false)
                    }
                    .accessibilityIdentifier("history.empty")
                }
                if let figure = page.figure { head(figure, page) }
                ForEach(HistoryDays(page.sessions).days) { day in
                    SheetPart(day.words, aside: day.reads) {
                        HistoryLines(reader: id, key: day.id, lines: day.lines, opened: $opened)
                    }
                }
                if let next = page.next {
                    SheetPart(nil) {
                        SettingRow(next.words, separator: false, opens: { Task { await store.readEarlier(id) } })
                    }
                    .disabled(store.earlier.contains(id))
                    .accessibilityIdentifier("history.earlier")
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .task { await store.readHistory(id) }
        .refreshable { await store.readHistory(id) }
        .accessibilityIdentifier("history.page")
    }

    private func head(_ figure: HomeLink.ReadsFigure, _ page: HomeLink.HistoryPage) -> some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
            WeekFigure(Words.count(figure.today), words: figure.words,
                       bars: figure.days.map { WeekFigure.Bar(count: $0.n, when: $0.words) },
                       labels: figure.days.map(\.words), marked: .last)
            BoldLine(AgentsWords.runs(figure.said))
            if !page.chips.isEmpty {
                ChipRow(page.chips.map { Chip($0.name, id: $0.kind, count: $0.n) },
                        picked: Binding(get: { store.picked[id] }, set: { kind in Task { await store.pick(id, kind: kind) } }),
                        reading: store.picking.contains(id))
                    .accessibilityIdentifier("history.chips")
            }
        }
        .accessibilityIdentifier("history.figure")
    }
}

private struct ReadPage: View {
    let id: String
    let call: String
    @ObservedObject private var store = AgentsStore.shared
    @Environment(\.openConnectors) private var open

    private var key: String { AgentsStore.key(id, call) }

    var body: some View {
        Group {
            if let page = store.readPages[key] {
                PageDrawer(page.title, line: page.line) {
                    drawn(page)
                } foot: {
                    if let show = page.show {
                        Button(show.words) { open(.things(id, call)) }
                            .buttonStyle(.cockpit(.secondary, size: .large, fullWidth: true))
                            .accessibilityIdentifier("read.show")
                    }
                }
            } else if let failed = store.readFailed[key] {
                PageDrawer(AgentsWords.history) {
                    PageLack(failed) { Task { await store.readPage(id, call: call) } }
                }
            } else {
                PageDrawer(AgentsWords.history) { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .task { await store.readPage(id, call: call) }
        .accessibilityIdentifier("read.page")
    }

    @ViewBuilder private func drawn(_ page: HomeLink.ReadPage) -> some View {
        if let refused = page.refused {
            Text(verbatim: refused)
                .cockpit(.subhead)
                .foregroundStyle(Cockpit.Color.warning)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("read.refused")
        } else if let figure = page.figure {
            VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                WeekFigure(Words.count(figure.n), words: figure.words, bars: [], bare: true)
                if !page.kinds.isEmpty {
                    KindBar(parts: page.kinds.map { KindBar.Part($0.name, n: $0.n) })
                }
            }
            .accessibilityIdentifier("read.figure")
        }
        if let kept = page.kept, page.refused == nil {
            SheetPart(AgentsWords.keptFromIt, note: kept.held) {
                ForEach(Array(kept.rows.enumerated()), id: \.offset) { index, row in
                    SettingRow(row.name, separator: index < kept.rows.count - 1) {
                        SettingValue(row.value)
                    }
                }
            }
            .accessibilityIdentifier("read.kept")
        }
        if let why = page.why {
            VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                SectionLabel(AgentsWords.whyItCould)
                BoldLine(AgentsWords.runs(why))
            }
            .accessibilityIdentifier("read.why")
        }
    }
}

private struct ThingsPage: View {
    let id: String
    let call: String
    @ObservedObject private var store = AgentsStore.shared

    private var key: String { AgentsStore.key(id, call) }

    var body: some View {
        Group {
            if let page = store.things[key] {
                PageDrawer(page.title, line: page.gone) {
                    ForEach(page.groups) { group in
                        SheetPart(group.name, aside: Words.count(group.n)) {
                            ForEach(Array(group.things.enumerated()), id: \.offset) { index, thing in
                                row(thing, icon: HistoryLines.icon(group.icon), separator: index < group.things.count - 1)
                            }
                        }
                    }
                    if page.next != nil {
                        SheetPart(nil) {
                            SettingRow(AgentsWords.showMore, separator: false, opens: { Task { await store.readMoreThings(id, call: call) } })
                        }
                        .disabled(store.moreThings.contains(key))
                        .accessibilityIdentifier("things.more")
                    }
                }
            } else if let failed = store.thingsFailed[key] {
                PageDrawer("") {
                    PageLack(failed) { Task { await store.readThings(id, call: call) } }
                }
            } else {
                PageDrawer("") { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .task { await store.readThings(id, call: call) }
        .accessibilityIdentifier("things.page")
    }

    private func row(_ thing: HomeLink.Thing, icon: Cockpit.Icon, separator: Bool) -> some View {
        SettingRow(thing.title, line: thing.line, separator: separator, lead: .glyph(icon), opens: Self.opening(thing)) {
            if let when = thing.when { RowEnd(.time(when)) }
        }
        .accessibilityIdentifier("things.row")
    }

    static func opening(_ thing: HomeLink.Thing) -> (() -> Void)? {
        guard let route = LifeRoute.opening(thing.opens) else { return nil }
        let tab: AppNavigation.Tab = switch route {
        case .person, .group: .people
        case .place: .places
        default: .days
        }
        return { AppNavigation.shared.open(route, in: tab) }
    }
}

extension HomeLink.ThingsPage {
    func joined(_ more: HomeLink.ThingsPage) -> HomeLink.ThingsPage {
        var page = self
        for group in more.groups {
            if let at = page.groups.firstIndex(where: { $0.kind == group.kind }) {
                page.groups[at].things += group.things
            } else {
                page.groups.append(group)
            }
        }
        page.next = more.next
        page.gone = page.gone ?? more.gone
        return page
    }
}
