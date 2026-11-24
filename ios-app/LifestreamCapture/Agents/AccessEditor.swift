import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

@MainActor
final class AccessEditorModel: ObservableObject, Identifiable {
    enum Purpose { case signIn, ask, reader }
    enum Dock: Equatable { case none, undo, allow }

    let id = UUID()
    let name: String
    let purpose: Purpose
    @Published private(set) var editing: AccessEditing
    @Published private(set) var saved: HomeLink.AccessDraft?
    @Published private(set) var said: String?
    @Published private(set) var proving = false
    @Published var path: [AccessRoute] = []
    private let link: HomeLink
    private let prove: () async -> Bool
    private var next: HomeLink.Edit?

    init(link: HomeLink, name: String, purpose: Purpose, target: HomeLink.EditTarget, access: HomeLink.Access,
         expect: HomeLink.Version?) {
        self.link = link
        self.name = name
        self.purpose = purpose
        prove = { true }
        editing = AccessEditing(target: target, access: access, expect: expect)
    }

    init(link: HomeLink, reader: HomeLink.AgentRead, prove: @escaping () async -> Bool = { await LifeLock.shared.prove() }) {
        self.link = link
        self.prove = prove
        name = reader.name
        purpose = .reader
        editing = AccessEditing(drawn: reader)
        saved = editing.draft
    }

    var view: HomeLink.AccessView? { editing.draft?.view }

    var waits: Bool {
        guard purpose == .reader, let view else { return false }
        return view.widens || view.screen != nil
    }

    var widening: String? { waits ? (view?.widening ?? view?.sentence).map(AgentsWords.plain) : nil }

    var narrowed: String? { purpose == .reader ? editing.draft?.narrowed.map { AgentsWords.plain($0.words) } : nil }

    var state: [String] { [narrowed, widening].compactMap { $0 } }

    var dock: Dock { waits ? .allow : narrowed != nil ? .undo : .none }

    func waiting(_ category: HomeLink.AccessView.Category) -> Bool {
        guard waits, category.state != .off else { return false }
        return saved?.view.categories.first { $0.type == category.type }?.state ?? .off == .off
    }

    var busy: Bool { editing.sending != nil || proving }

    var trouble: String? {
        switch editing.trouble {
        case nil: said
        case .unreachable: AgentAsks.unsent
        case .changed(let words), .refused(let words): words
        }
    }

    func open() {
        run(editing.draw())
    }

    func tap(_ edit: HomeLink.Edit) {
        guard editing.draft != nil, !proving else { return }
        said = nil
        guard editing.sending == nil else { return next = edit }
        run(editing.tap(edit))
    }

    func far(_ time: HomeLink.AccessView.TimeChoice) {
        switch time.choice {
        case .all: tap(.window(.allTime))
        case .since:
            guard let view, !Self.picks(time, view.window) else { return }
            tap(.window(Self.since(AppClock.now.addingTimeInterval(-30 * 86_400), zone: HomeClock.current.dayAt(AppClock.now).zone)))
        case .past: if let window = time.window { tap(.window(window)) }
        }
    }

    func hide(_ level: HomeLink.HideChoice) {
        guard view?.hide?.choice != level else { return }
        tap(.hide(level))
    }

    static func picks(_ time: HomeLink.AccessView.TimeChoice, _ limit: HomeLink.Limit?) -> Bool {
        switch time.choice {
        case .all: limit?.window == .allTime
        case .since: if case .since? = limit?.window { true } else { false }
        case .past: time.window != nil && limit?.window == time.window
        }
    }

    func allow() {
        guard waits else { return }
        proved { $0.editing.save() }
    }

    func undo() {
        guard narrowed != nil else { return }
        proved { $0.editing.undo() }
    }

    func cancel() {
        guard purpose == .reader, !busy, let saved else { return }
        next = nil
        said = nil
        editing = AccessEditing(target: editing.target, drawn: saved)
    }

    static func since(_ picked: Date, zone: TimeZone) -> HomeLink.Window {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return .since(ms: Int64((calendar.startOfDay(for: picked).timeIntervalSince1970 * 1000).rounded()))
    }

    private func proved(_ send: @escaping (AccessEditorModel) -> AccessEditing.Sent?) {
        guard !busy else { return }
        said = nil
        proving = true
        Task {
            let passed = await prove()
            proving = false
            guard passed else { return said = AgentAsks.unproved }
            run(send(self))
        }
    }

    private func run(_ sent: AccessEditing.Sent?) {
        guard let sent else { return }
        Task {
            do {
                let draft = try await link.send(sent)
                guard editing.land(sent.id, draft) else { return }
                if case .save = sent.request {
                    saved = draft
                } else if purpose == .reader {
                    if let narrowedTo = draft.narrowedTo {
                        saved = narrowedTo
                    } else {
                        if saved?.narrowed?.undo.expect != draft.expect { saved?.narrowed = nil }
                        if !waits, draft.access != saved?.access { return run(editing.save()) }
                    }
                }
                if let edit = next {
                    next = nil
                    run(editing.tap(edit))
                }
            } catch {
                editing.fail(sent.id, error)
                next = nil
                if purpose == .reader, case .changed(let words)? = editing.trouble, case .reader(let id) = editing.target {
                    await reread(id, keeping: words)
                }
            }
        }
    }

    private func reread(_ id: String, keeping words: String) async {
        guard let read = try? await link.agent(id), editing.sending == nil, !proving else { return }
        editing = AccessEditing(drawn: read)
        saved = editing.draft
        said = words
    }
}

enum AccessRoute: Hashable {
    enum Scope: Hashable {
        case all
        case type(String)
        case account(String)
    }

    case time(Scope)
    case category(String)
    case hiding
    case custom

    func title(in view: HomeLink.AccessView?) -> String {
        switch self {
        case .time: AgentsWords.howFarBack
        case .category(let type): view?.categories.first { $0.type == type }?.name ?? AgentsWords.access
        case .hiding: AgentsWords.hides
        case .custom: AgentsWords.custom
        }
    }
}

struct AccessEditorSheet: View {
    @ObservedObject var model: AccessEditorModel
    let answering: Bool
    let back: () -> Void
    let finish: () -> Void

    var body: some View {
        NavigationStack(path: $model.path) {
            AccessPage(model: model, push: { model.path.append($0) }, answer: answer, answering: answering)
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: AccessRoute.self) { route in
                    let at = model.path.firstIndex(of: route) ?? model.path.count - 1
                    AccessPushed(model: model, route: route, push: { model.path.append($0) })
                        .environment(\.drawerPush, DrawerPush(back: at > 0 ? model.path[at - 1].title(in: model.view) : AgentsWords.accessOf(model.name)) {
                            back()
                        })
                }
        }
        .environment(\.cockpitPartsFlat, true)
        .environment(\.drawerAsPage, false)
        .tint(Cockpit.Color.text)
        .accessibilityIdentifier("access.editor")
        .drawerRest(.large)
        .interactiveDismissDisabled()
    }

    private var answer: AccessAnswer {
        model.purpose == .signIn ? .done(finish) : .allow(cancel: back, allow: finish)
    }
}

struct AccessPushed: View {
    @ObservedObject var model: AccessEditorModel
    let route: AccessRoute?
    let push: (AccessRoute) -> Void

    var body: some View {
        if let route, let view = model.view {
            switch route {
            case .time(let scope): AccessTimePage(model: model, view: view, scope: scope)
            case .category(let type):
                if let category = view.categories.first(where: { $0.type == type }) {
                    AccessCategoryPage(model: model, view: view, category: category, push: push)
                }
            case .hiding: if let hiding = view.hide { AccessHidingPage(model: model, hiding: hiding, push: push) }
            case .custom: if let hiding = view.hide { AccessCustomPage(model: model, hiding: hiding) }
            }
        } else {
            AccessPage(model: model, push: push, answer: nil)
        }
    }
}

private struct AccessPage: View {
    @ObservedObject var model: AccessEditorModel
    let push: (AccessRoute) -> Void
    let answer: AccessAnswer?
    var answering = false
    @State private var all = false

    private static let shown = 7
    private static let count: CGFloat = 32

    private var title: String {
        model.purpose == .reader ? AgentsWords.reads : AgentsWords.accessOf(model.name)
    }

    var body: some View {
        if let view = model.view {
            PageDrawer(title) {
                content(view)
            } foot: {
                foot(view)
            }
            .accessibilityIdentifier("access.page")
        } else {
            PageDrawer(title) {
                if let trouble = model.trouble {
                    InPlaceLine(trouble) { model.open() }
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
        }
    }

    @ViewBuilder private func content(_ view: HomeLink.AccessView) -> some View {
        BoldLine(AgentsWords.runs(view.sentence))
            .accessibilityIdentifier("access.sentence")
        if view.screen != nil || model.trouble != nil {
            VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                if let screen = view.screen { AccessNote(screen) }
                if let trouble = model.trouble { InPlaceLine(trouble) }
            }
        }
        let folded = !all && view.categories.count > Self.shown + 1
        let categories = folded ? Array(view.categories.prefix(Self.shown)) : view.categories
        Segmented(AgentsWords.reads, options: view.modes.map { TabOption($0.words, id: $0.mode, identifier: "access.mode.\($0.mode.rawValue)") },
                  selection: view.mode, line: view.modeLine) { model.tap(.mode($0)) }
        SheetPart(AgentsWords.whatItCanSee, aside: view.categories.contains { $0.reads != nil } ? AgentsWords.thirtyDays : nil) {
            ForEach(categories) { category in
                SettingRow(category.name, line: category.differs, separator: folded || category.type != categories.last?.type,
                           lead: .glyph(Cockpit.Icon(rawValue: category.icon) ?? .file), opens: { push(.category(category.type)) }) {
                    HStack(spacing: Cockpit.Space.s3) {
                        if let reads = category.reads {
                            SettingValue(AgentsWords.count(reads))
                                .monospacedDigit()
                                .frame(minWidth: Self.count, alignment: .trailing)
                                .accessibilityLabel(reads.words)
                        }
                        AccessSwitch(category.name, category.state, waiting: model.waiting(category)) { model.tap(.type(category.type, on: $0)) }
                            .accessibilityIdentifier("access.read.\(category.type)")
                    }
                }
                .opensFromLine()
            }
            if folded {
                SettingRow(AgentsWords.more(view.categories.count - Self.shown), separator: false, lead: .glyph(.more), opens: { all = true })
                    .opensFromLine()
                    .accessibilityIdentifier("access.more")
            }
        }
        if model.purpose != .reader { limits(view) }
    }

    private func limits(_ view: HomeLink.AccessView) -> some View {
        SheetPart(nil) {
            SettingRow(AgentsWords.howFarBack, lead: .glyph(.time), opens: { push(.time(.all)) }) {
                SettingValue(view.window.words)
            }
            .accessibilityIdentifier("access.time")
            if let hiding = view.hide {
                SettingRow(AgentsWords.hides, lead: .glyph(.hidden), opens: { push(.hiding) }) {
                    SettingValue(AgentsWords.level(hiding))
                }
                .accessibilityIdentifier("access.hiding")
            }
            SettingRow(AgentsWords.finer, separator: false, lead: .glyph(.people)) {
                SettingValue(AgentsWords.later)
            }
            .environment(\.cockpitRowQuiet, true)
        }
    }

    @ViewBuilder private func foot(_ view: HomeLink.AccessView) -> some View {
        if let answer {
            AccessFoot(nil, answer: answer, busy: model.busy || answering)
        } else {
            AccessDock(model: model)
        }
    }

}

struct AccessDock: View {
    @ObservedObject var model: AccessEditorModel

    var body: some View {
        switch model.dock {
        case .none: AccessFoot(nil, busy: model.busy)
        case .undo: AccessFoot(lines: model.state, answer: .undo(model.undo), busy: model.busy)
        case .allow: AccessFoot(lines: model.state, answer: .allow(cancel: model.cancel, allow: model.allow), busy: model.busy)
        }
    }
}

private struct AccessSwitch: View {
    let label: String
    let state: HomeLink.Switch
    let waiting: Bool
    let set: (Bool) -> Void

    init(_ label: String, _ state: HomeLink.Switch, waiting: Bool = false, set: @escaping (Bool) -> Void) {
        self.label = label
        self.state = state
        self.waiting = waiting
        self.set = set
    }

    var body: some View {
        Toggle(label, isOn: Binding(get: { state != .off }, set: set))
            .labelsHidden()
            .toggleStyle(.cockpit(waiting: waiting))
    }
}

private struct AccessTimePage: View {
    @ObservedObject var model: AccessEditorModel
    let view: HomeLink.AccessView
    let scope: AccessRoute.Scope

    private var limit: HomeLink.Limit? {
        switch scope {
        case .all: view.window
        case .type(let type): view.categories.first { $0.type == type }?.limit
        case .account(let account): view.categories.lazy.flatMap(\.accounts).first { $0.account == account }?.limit
        }
    }

    private var line: String? {
        switch scope {
        case .all: nil
        case .type(let type): view.categories.first { $0.type == type }?.name
        case .account(let account): view.categories.lazy.flatMap(\.accounts).first { $0.account == account }.map { [$0.name, $0.line].compactMap { $0 }.joined(separator: Words.dot) }
        }
    }

    private func set(_ window: HomeLink.Window) {
        switch scope {
        case .all: model.tap(.window(window))
        case .type(let type): model.tap(.typeWindow(type, window))
        case .account(let account): model.tap(.accountWindow(account, window))
        }
    }

    private var since: Int64? { if case .since(let ms)? = limit?.window { ms } else { nil } }

    private var zone: TimeZone { HomeClock.current.dayAt(AppClock.now).zone }

    private func picked(_ time: HomeLink.AccessView.TimeChoice) -> Bool { AccessEditorModel.picks(time, limit) }

    private func pick(_ time: HomeLink.AccessView.TimeChoice) {
        switch time.choice {
        case .all: set(.allTime)
        case .since:
            guard since == nil else { return }
            set(AccessEditorModel.since(AppClock.now.addingTimeInterval(-30 * 86_400), zone: zone))
        case .past: if let window = time.window { set(window) }
        }
    }

    var body: some View {
        PageDrawer(AgentsWords.howFarBack, line: line) {
            SheetPart(nil, note: scope == .all ? nil : AgentsWords.accountNote) {
                ForEach(Array(view.times.enumerated()), id: \.offset) { index, time in
                    let last = index == view.times.count - 1
                    choice(time.words, picked(time), last: last && !(time.choice == .since && since != nil)) { pick(time) }
                    if time.choice == .since, let since {
                        DatePicker(time.words, selection: Binding(get: { Date(timeIntervalSince1970: Double(since) / 1000) },
                                                                  set: { set(AccessEditorModel.since($0, zone: zone)) }),
                                   in: ...AppClock.now, displayedComponents: .date)
                            .environment(\.timeZone, zone)
                            .labelsHidden()
                            .datePickerStyle(.compact)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, Cockpit.Space.s2)
                            .accessibilityIdentifier("access.time.since")
                    }
                }
            }
        }
        .accessibilityIdentifier("access.times")
    }

    private func choice(_ words: String, _ on: Bool, last: Bool = false, _ pick: @escaping () -> Void) -> some View {
        ListRow(words, separator: !last, action: pick) {
            if on { Icon(.done, size: .sm).foregroundStyle(Cockpit.Color.engaged) }
        }
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

private struct AccessCategoryPage: View {
    @ObservedObject var model: AccessEditorModel
    let view: HomeLink.AccessView
    let category: HomeLink.AccessView.Category
    let push: (AccessRoute) -> Void

    var body: some View {
        PageDrawer(category.name, line: category.line) {
            SheetPart(AgentsWords.accounts, note: AgentsWords.accountNote) {
                ForEach(category.accounts) { account in
                    let own = account.limit.flatMap { $0.window == .allTime || $0.window == (category.limit ?? view.window).window ? nil : $0.words }
                    SettingRow(account.name, line: [account.line, own].compactMap { $0 }.joined(separator: Words.dot),
                               separator: account != category.accounts.last, lead: .glyph(Cockpit.Icon(rawValue: category.icon) ?? .file),
                               opens: { push(.time(.account(account.account))) }) {
                        AccessSwitch(account.name, account.state) { model.tap(.account(account.account, on: $0)) }
                            .accessibilityIdentifier("access.account.\(account.account)")
                    }
                    .opensFromLine()
                }
            }
            SheetPart(nil) {
                SettingRow(AgentsWords.howFarBack, separator: false, lead: .glyph(.time), opens: { push(.time(.type(category.type))) }) {
                    SettingValue(category.limit?.words ?? view.window.words)
                }
            }
        }
    }
}

private struct AccessHidingPage: View {
    @ObservedObject var model: AccessEditorModel
    let hiding: HomeLink.AccessView.Hiding
    let push: (AccessRoute) -> Void

    var body: some View {
        PageDrawer(AgentsWords.hides, line: hiding.words) {
            SheetPart(nil) {
                ForEach(hiding.choices, id: \.level) { choice in
                    let custom = choice.level == .custom
                    SettingRow(choice.words, line: choice.line, separator: choice != hiding.choices.last, opens: {
                        if !choice.selected { model.tap(.hide(choice.level)) }
                        if custom { push(.custom) }
                    }) {
                        if choice.selected { Icon(.done, size: .sm).foregroundStyle(Cockpit.Color.text).accessibilityHidden(true) }
                    }
                    .picksInPlace(!custom)
                    .topAligned()
                    .accessibilityAddTraits(choice.selected ? .isSelected : [])
                    .accessibilityIdentifier("access.hide.\(choice.level.rawValue)")
                }
            }
        }
    }
}

private struct AccessCustomPage: View {
    @ObservedObject var model: AccessEditorModel
    let hiding: HomeLink.AccessView.Hiding

    var body: some View {
        PageDrawer(AgentsWords.custom, line: hiding.words) {
            SheetPart(AgentsWords.hide) {
                ForEach(hiding.types) { type in
                    detail(type.name, type.type, type.state, fixedWith: nil, last: type == hiding.types.last && type.subtypes.isEmpty)
                    ForEach(type.subtypes) { subtype in
                        detail(subtype.name, subtype.type, subtype.state, fixedWith: type.name,
                               last: type == hiding.types.last && subtype == type.subtypes.last)
                            .padding(.leading, Cockpit.Space.s6)
                    }
                }
            }
        }
    }

    @ViewBuilder private func detail(_ name: String, _ type: String, _ state: HomeLink.AccessView.DetailState, fixedWith parent: String?,
                                     last: Bool) -> some View {
        SettingRow(name, separator: !last) {
            if state == .fixed {
                SettingValue(parent.map(AgentsWords.hiddenWith) ?? AgentsWords.hidden)
            } else {
                Toggle(name, isOn: Binding(get: { state == .hidden }, set: { model.tap(.detail(type, hidden: $0)) }))
                    .labelsHidden()
                    .toggleStyle(.cockpit)
            }
        }
        .disabled(model.view?.hide?.choice != .custom)
    }
}
