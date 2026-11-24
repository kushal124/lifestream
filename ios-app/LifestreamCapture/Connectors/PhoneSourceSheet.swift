import AVFoundation
import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit

struct PhoneSourceSheet: View {
    let source: PhoneSource
    let leave: (@escaping @MainActor () -> Void) -> Void
    @ObservedObject var home: HomeConnectorsModel
    @EnvironmentObject private var model: CaptureAppModel
    @ObservedObject private var needs = PhoneNeeds.shared
    @ObservedObject private var permissions = PhoneNeeds.shared.permissions
    @ObservedObject private var checkIns = AppRuntime.shared.checkInModel
    @ObservedObject private var shipper = AppRuntime.shared.shipping.shipper
    @ObservedObject private var settings = AppRuntime.shared.settings
    @ObservedObject private var photos = PhotosServices.shared
    @Environment(\.openConnectors) private var open
    @State private var confirmingOff = false

    @ViewBuilder private var photoActs: some View {
        let brings = !BringInPhotos.refused, clears = ClearPhotoCopies.due
        if brings || clears {
            VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                Card(group: true) {
                    if brings { BringInPhotos().environment(\.actsFollow, clears) }
                    if clears { ClearPhotoCopies() }
                }
                if clears { Text(ClearPhotoCopies.note).connectorsNote() }
            }
        }
    }

    var body: some View {
        let line = connector.flatMap(StreamsWords.meta) ?? source.gives
        let buttons = StreamFoot.Buttons.stands(stream, offable: offable)
        PageDrawer(source.name, icon: source.icon, line: line, lineBusy: connector.map(StreamProgress.stands) == true) {
            if let connector, let read = home.read {
                StreamCallout(connector: connector, unit: shipper.unit, home: home, grantDrawn: source.permission != nil)
                StreamProgress(connector: connector, now: read.atMs)
                if let figure = connector.figure {
                    StreamFigure(today: figure.today, noun: StreamsWords.noun(connector), week: figure.week, day: read.day)
                }
            }
            if permits {
                PermissionState(source: source)
            }
            if let connector, home.read != nil { StreamComesFrom(connector: connector) }
            settingsPart
            if let connector, let refresh = connector.refreshNow {
                SheetPart(ownMembers.isEmpty ? ConnectorWords.settings : nil) { StreamRefreshRow(connector: connector, refresh: refresh, home: home) }
            }
            parts
            if let connector {
                StreamProcessing(connector: connector, home: home)
                StreamHistory(connector: connector, home: home)
            }
            if source == .photos { photoActs }
            StreamReads(gives: source.gives)
            if let connector { StreamFoot.Unchanged(connector: connector, home: home) }
        } foot: {
            if buttons {
                StreamFoot.Buttons(connector: stream, home: home, offable: offable) { confirmingOff = true }
            }
        }
        .confirmationDialog(ConnectorWords.disconnectTitle(source.name), isPresented: $confirmingOff, titleVisibility: .visible) {
            Button(ConnectorWords.openSettings) {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
            Button(ConnectorWords.cancel, role: .cancel) {}
        } message: {
            Text(ConnectorWords.managedByIOS(source.name))
        }
        .task {
            if source == .location || source == .checkIns {
                await settings.sync()
                if AppRuntime.shared.reach.snapshot.reach != .unpaired { await home.read() }
            }
            await model.refresh()
        }
    }

    private var connector: HomeLink.Connector? {
        home.read?.connectors.first { $0.id == source.stream.id }
    }

    private var permits: Bool { source.permission != nil || source.device != nil }

    private var stream: HomeLink.Connector? {
        connector.flatMap { StreamFoot.shown($0) ? $0 : nil }
    }

    private var offable: Bool {
        switch source.access(needs) {
        case .stated(.on), .stated(.asked), .stated(.limited), .device(.authorized): true
        default: false
        }
    }

    @ViewBuilder private var settingsPart: some View {
        let members = ownMembers
        if !members.isEmpty {
            SheetPart(ConnectorWords.settings) {
                ForEach(members) { own in ownRow(own, separator: own.key != members.last?.key) }
            }
        }
    }

    private var ownMembers: [OwnMember] {
        let built = OwnMember.built(source)
        let said = home.read?.connectors.first { $0.id == built.first?.connector }
        return built.map { own in
            guard let member = said?.members.first(where: { $0.key == own.key && $0.panel != nil }) else { return own }
            return own.said(member)
        }
    }

    @ViewBuilder private func ownRow(_ own: OwnMember, separator: Bool) -> some View {
        let at = settings.stated[own.connector]?[own.key]
        SettingRow(own.label, about: own.about, waiting: own.waiting, only: own.only,
                   problem: settings.unkept["\(own.connector).\(own.key)"], separator: separator) {
            if let steps = own.steps {
                MenuRow(own.label, selection: Binding(
                    get: { at?.key ?? "" },
                    set: { value in Task { await settings.change(own.connector, own.key, to: .string(value)) } }),
                        options: steps.map { MenuRow.Option($0.value, $0.words, note: $0.note) }, default: own.fallback)
                    .accessibilityIdentifier(own.identifier)
            } else {
                Toggle(own.label, isOn: Binding(
                    get: { at?.bool == true },
                    set: { on in Task { await settings.change(own.connector, own.key, to: .bool(on)) } }))
                    .labelsHidden()
                    .toggleStyle(.cockpit)
                    .accessibilityIdentifier(own.identifier)
            }
        }
    }

    @ViewBuilder private var parts: some View {
        switch source {
        case .photos: PhotosLibrarySettings()
        case .contacts: ContactsAddressBook()
        case .screenTime: ScreenTimeSettings()
        case .notes:
            Card(group: true) {
                ListRow("Your notes", chevron: true, separator: false,
                        action: { leave { AppNavigation.shared.whenClear { AppNavigation.shared.present(.notes(.folders)) } } })
                    .accessibilityIdentifier("connectors.notes.open")
            }
        case .checkIns:
            Card(group: true) {
                ListRow("Check in now", meta: Words.count(checkIns.status.history.reports.count, "report"), chevron: true,
                        separator: false, action: { open(.checkIns) })
                    .accessibilityIdentifier("settings.checkins")
            }
        case .location, .motion, .health, .voice, .camera: EmptyView()
        }
    }
}

struct OwnMember: Identifiable {
    typealias Step = (value: String, words: String, note: String?)

    let connector: String
    let key: String
    let label: String
    var about: String?
    let steps: [Step]?
    let fallback: String?
    var waiting: String?
    var only: String?
    let identifier: String

    var id: String { key }

    func said(_ member: HomeLink.Connector.Member) -> OwnMember {
        OwnMember(connector: connector, key: key, label: member.label, about: member.about,
                  steps: member.steps.map { $0.map { ($0.value, $0.words, $0.note) } }, fallback: member.default.map(\.key),
                  waiting: member.waitingLine, only: member.only, identifier: identifier)
    }

    static func built(_ source: PhoneSource) -> [OwnMember] {
        switch source {
        case .location:
            [OwnMember(connector: PhoneSettings.location, key: "precision", label: "Precision",
                       steps: [(LocationPrecision.precise.rawValue, "Precise", nil), (LocationPrecision.battery.rawValue, "Battery saving", nil)],
                       fallback: LocationPrecision.precise.rawValue, identifier: "location.precision")]
        case .checkIns:
            [OwnMember(connector: PhoneSettings.checkin, key: "prompts", label: "Ask through the day", steps: nil, fallback: nil,
                       identifier: "checkin.promptsOn"),
             OwnMember(connector: PhoneSettings.checkin, key: "bedtime", label: "Bedtime", steps: PhoneSettings.bedtimes.map { ($0, $0, nil) },
                       fallback: PhoneSettings.bedtimeDefault, identifier: "checkin.bedtime")]
        default:
            []
        }
    }
}

struct PermissionState: View {
    let source: PhoneSource
    @ObservedObject private var needs = PhoneNeeds.shared
    @ObservedObject private var permissions = PhoneNeeds.shared.permissions
    @Environment(\.allowSource) private var allow

    var body: some View {
        SheetPart("Permission") { content }
    }

    @ViewBuilder private var content: some View {
        if let id = source.permission, let row = permissions.rows.first(where: { $0.id == id }) {
            let stated = permissions.read || AppRuntime.isUITesting ? permissions.stated(id) : nil
            let act: String? = switch stated {
            case .notNow, .notAsked: "Allow"
            case .limited where permissions.prompts(row): "Allow"
            case .limited, .off: "Open Settings"
            case .on, .asked, .asking, nil: nil
            }
            permission(row.name, line: note(row), identifier: stateIdentifier ?? "permissions.row.\(id)",
                       act: act.map { ($0, buttonIdentifier(row)) }, said: stated != .notAsked, asking: stated == .asking)
        } else if let type = source.device {
            let status = needs.device(type)
            permission(type == .audio ? "Microphone" : "Camera",
                       line: status != .notDetermined ? nil
                           : type == .audio ? "iOS asks the first time you record a voice note." : "iOS asks the first time you open the camera.",
                       identifier: nil,
                       act: status == .authorized ? nil : (status == .notDetermined ? "Allow" : "Open Settings", "permissions.\(source.rawValue)"),
                       said: status != .notDetermined)
        }
    }

    private func permission(_ name: String, line: String?, identifier: String?, act: (words: String, identifier: String)?,
                            said: Bool, asking: Bool = false) -> some View {
        let mark = source.signal(needs)
        let lead = act != nil && said && !asking
        return SettingRow(name, line: lead ? mark.word : line, signal: lead ? mark.kind : nil, note: lead ? line : nil,
                          separator: false) {
            if asking {
                HStack(spacing: Cockpit.Space.s2) {
                    Loading(size: .glyph).accessibilityHidden(true)
                    SettingValue(mark.word)
                }
            } else if let act {
                Button(act.words) { allow(source) }
                    .buttonStyle(.cockpit(.secondary, size: .small))
                    .accessibilityIdentifier(act.identifier)
            } else {
                SettingValue(mark.word, signal: mark.kind)
            }
        }
        .accessibilityValue(mark.word)
        .accessibilityIdentifier(identifier ?? "permissions.\(source.rawValue).state")
    }

    private func note(_ row: PermissionsModel.Row) -> String? {
        switch row.state {
        case .absent: return "This build of Lifestream does not include it. A later build adds it, installed over this one."
        case .asked: return "iOS does not tell apps what Health allows. Change it in the Health app, under Sharing, Apps."
        case .denied where row.closesApp: return "iOS closes Lifestream when you change this. It opens back here."
        default: return nil
        }
    }

    private var stateIdentifier: String? {
        switch source {
        case .photos: "photos.authorization"
        case .screenTime: "usage.authorization"
        default: nil
        }
    }

    private func buttonIdentifier(_ row: PermissionsModel.Row) -> String {
        switch (source, row.state) {
        case (.photos, .undetermined): "photos.allow"
        case (.photos, _): "photos.openSettings"
        case (.contacts, .undetermined): "contacts.allow"
        case (.screenTime, _): "usage.enable"
        default: "permissions.\(row.id)"
        }
    }
}

extension PhoneSource {
    var ownParts: Bool {
        switch self {
        case .photos, .contacts, .screenTime, .notes, .checkIns: true
        case .location, .motion, .health, .voice, .camera: false
        }
    }

    var confirmation: (title: String, message: String)? {
        guard self == .screenTime else { return nil }
        if #available(iOS 26.4, *) {
            return ("Allow Screen Time?", "Only one app can read Screen Time's totals at a time: allowing it may take that from another app. This build also needs Apple's approval for it.")
        }
        return ("Allow Screen Time?", "Lifestream can mark when apps you choose reach a use you set. Reading Screen Time's totals needs iOS 26.4 or later.")
    }
}

struct AllowSourceAction {
    let perform: @MainActor (PhoneSource) -> Void

    @MainActor func callAsFunction(_ source: PhoneSource) { perform(source) }
}

extension EnvironmentValues {
    @Entry var allowSource = AllowSourceAction { _ in }
}

extension View {
    func allowingSources() -> some View { modifier(AllowingSources()) }
}

private struct AllowingSources: ViewModifier {
    @EnvironmentObject private var model: CaptureAppModel
    @ObservedObject private var needs = PhoneNeeds.shared
    @State private var confirming: PhoneSource?

    func body(content: Content) -> some View {
        content
            .environment(\.allowSource, AllowSourceAction(perform: allow))
            .confirmationDialog(
                confirming?.confirmation?.title ?? "",
                isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                titleVisibility: .visible, presenting: confirming
            ) { source in
                Button("Allow") { Task { await needs.permissions.ask(source.permission ?? "", start: model.start) } }
                Button("Not now", role: .cancel) {}
            } message: { source in
                Text(source.confirmation?.message ?? "")
            }
    }

    private func allow(_ source: PhoneSource) {
        if let type = source.device {
            Task { await needs.allow(type) }
            return
        }
        guard let id = source.permission else { return }
        if source.confirmation != nil, needs.permissions.rows.first(where: { $0.id == id })?.state == .undetermined {
            confirming = source
            return
        }
        Task { await needs.permissions.ask(id, start: model.start) }
    }
}

