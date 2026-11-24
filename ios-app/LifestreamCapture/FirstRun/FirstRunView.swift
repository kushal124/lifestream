import Cockpit
import LifestreamCaptureCore
import MapKit
import SwiftUI

struct FirstRunView: View {
    @StateObject private var model: FirstRunModel
    @ObservedObject private var permissions: PermissionsModel
    @ObservedObject private var opened = OpenedLink.shared
    @ObservedObject private var shipper = AppRuntime.shared.shipping.shipper
    @EnvironmentObject private var app: CaptureAppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL
    @State private var pairing = false
    @State private var keyboard = false
    let started: () -> Void

    init(permissions: PermissionsModel, started: @escaping () -> Void) {
        self.permissions = permissions
        self.started = started
        _model = StateObject(wrappedValue: FirstRunModel(permissions: permissions, record: AppRuntime.shared.firstRun,
                                                         paired: { AppRuntime.shared.shipping.shipper.paired }))
    }

    var body: some View {
        Group {
            if let screen = model.screen {
                FirstRunFrame(centred: screen == .done, grounded: screen == .welcome, band: Self.band(screen), back: wayBack) {
                    if model.showsMarks, screen != .done {
                        StepMarks(model.marks).accessibilityIdentifier("firstrun.marks")
                    }
                } column: {
                    column(screen)
                        .id(screen)
                        .transition(transition)
                } foot: {
                    foot(screen)
                }
                .animation(motion, value: screen)
            } else {
                Cockpit.Color.canvas.ignoresSafeArea()
            }
        }
        .tint(Cockpit.Color.text)
        .task(id: permissions.read) {
            if permissions.read { model.begin() }
        }
        .onChange(of: permissions.rows) { old, new in model.answered(from: old, to: new) }
        .onReceive(opened.$pending) { pending in
            guard let pending else { return }
            pairing = false
            model.open(pending.link)
            opened.pending = nil
        }
        .sheet(isPresented: $pairing) { PairingView() }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboard = true }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboard = false }
    }

    private var wayBack: FirstRunBack? {
        guard let previous = model.previous, !model.held, permissions.asking == nil,
              !model.pair.busy, !model.pair.scanning, !model.pair.standing, !keyboard else { return nil }
        return FirstRunBack(centred: previous == .done, grounded: previous == .welcome, marked: previous != .welcome, band: Self.band(previous),
                            go: { model.back() }) {
            column(previous)
        }
    }

    private static func band(_ screen: FirstRunModel.Screen) -> Image? {
        screen == .welcome || screen == .done ? Image("RiverBand") : nil
    }

    private var motion: Animation? {
        if AppRuntime.isUITesting { return nil }
        return reduceMotion ? .easeInOut(duration: Cockpit.Duration.fast)
            : .timingCurve(0.45, 0, 0.25, 1, duration: Cockpit.Duration.slow)
    }

    private var transition: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading))
    }


    private static var welcomeWords: CGFloat { 320 }

    @ViewBuilder private func column(_ screen: FirstRunModel.Screen) -> some View {
        switch screen {
        case .welcome:
            FirstRunColumn("Welcome to Lifestream") {
                LogoMark().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            } line: {
                FirstRunLine("Everything about you, gathered into one stream and kept on your Mac. This iPhone adds where you go, how you move, your health and your photos.")
                    .frame(maxWidth: Self.welcomeWords)
            }
            .onAxis()
            .firstRunScreen("firstrun.welcome")
        case .pair:
            PairColumn(model: model.pair)
        case .stream(let source):
            FirstRunColumn(source.name) { picture(source) } line: {
                let said = line(source)
                FirstRunLine(said.words, kind: said.kind).accessibilityIdentifier("firstrun.line")
            }
            .firstRunScreen("firstrun.\(source.rawValue)")
        case .done:
            DoneColumn(model: model, permissions: permissions, paired: shipper.paired, pair: { pairing = true })
        }
    }


    @ViewBuilder private func foot(_ screen: FirstRunModel.Screen) -> some View {
        switch screen {
        case .welcome:
            FirstRunFoot {
                Button("Set up") { model.pass() }
                    .buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
                    .accessibilityIdentifier("firstrun.setup")
            } plain: {
                Link(destination: Privacy.policy) {
                    HStack(spacing: Cockpit.Space.s1) { Text("Privacy policy"); Icon(.openOut, size: .xs) }
                }
                    .buttonStyle(.cockpit(.plain, fullWidth: true))
                    .accessibilityIdentifier("start.privacy")
            }
        case .pair:
            PairFoot(model: model.pair) { model.pass() }
        case .stream(let source):
            streamFoot(source)
        case .done:
            FirstRunFoot {
                Button("Start") {
                    AppNavigation.shared.selectedTab = .days
                    started()
                }
                .buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
                .accessibilityIdentifier("permissions.continue")
            }
        }
    }

    @ViewBuilder private func streamFoot(_ source: PhoneSource) -> some View {
        let state = model.state(source)
        let working = model.asks(source)
        let standing = model.stands(source)
        if standing || state == .undetermined || working {
            FirstRunFoot(note: standing ? nil : FirstRunWords.before(source), done: standing ? "Allowed" : nil) {
                Button("Allow") { Task { await model.allow(source, start: app.start) } }
                    .buttonStyle(.cockpit(.primary, size: .large, busy: working, fullWidth: true))
                    .accessibilityIdentifier(source == .location ? "start.capture" : "firstrun.allow")
            } plain: {
                Button("Not now") { model.pass() }
                    .buttonStyle(.cockpit(.plain, fullWidth: true))
                    .allowsHitTesting(!working)
                    .accessibilityIdentifier("firstrun.notnow")
            }
        } else {
            let change = FirstRunChange.of(source, state, closesApp: permissions.rows.first { $0.id == source.permission }?.closesApp ?? false)
            FirstRunFoot(note: change?.closes == true ? "iOS closes Lifestream when you change this. It opens back here." : nil) {
                Button("Continue") { model.pass() }
                    .buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
                    .accessibilityIdentifier("firstrun.continue")
            } plain: {
                if let change {
                    Button(change.label) { perform(change.act) }
                        .buttonStyle(.cockpit(.plain, fullWidth: true))
                        .accessibilityIdentifier("firstrun.change")
                }
            }
        }
    }


    private func line(_ source: PhoneSource) -> (words: String, kind: FirstRunLine.Kind) {
        let state = model.state(source)
        let find = model.finds[source]
        if model.asks(source) { return (source.why, .words) }
        switch state {
        case .undetermined, .absent:
            return (source.why, .words)
        case .granted:
            return (find?.line ?? source.why, find?.line == nil ? .words : .found)
        case .asked:
            if let found = find?.line { return (found, .found) }
            return (FirstRunWords.asked, .state)
        case .partly:
            return (FirstRunWords.partial(source, count: find?.count), .state)
        case .denied:
            return (FirstRunWords.off(source), .state)
        }
    }

    @ViewBuilder private func picture(_ source: PhoneSource) -> some View {
        let state = model.state(source)
        let find = state == .undetermined ? nil : model.finds[source]
        switch source {
        case .location:
            StreamPicture(.map(place: model.place.map { AnyView(PlaceMap(place: $0)) }, off: state == .denied))
        case .motion: StreamPicture(.motion)
        case .health: StreamPicture(.health)
        case .screenTime: StreamPicture(.screenTime)
        case .photos:
            StreamPicture(.photos(find.map { $0.photos.map { Image(uiImage: $0) } }, limited: state.partial))
        case .contacts:
            StreamPicture(.contacts(find?.initials))
        default:
            EmptyView()
        }
    }

    private func perform(_ act: FirstRunChange.Act) {
        switch act {
        case .askHealth: Task { await permissions.ask("health", start: app.start) }
        case .openHealth: if let url = URL(string: "x-apple-health://") { openURL(url) }
        case .choosePhotos: model.chooseMorePhotos()
        case .settings: if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
        }
    }
}

struct FirstRunChange: Equatable {
    enum Act: Equatable { case askHealth, openHealth, choosePhotos, settings }

    let label: String
    let act: Act
    let closes: Bool

    static func of(_ source: PhoneSource, _ state: PermissionsModel.State, closesApp: Bool) -> FirstRunChange? {
        switch (source, state) {
        case (.health, .partly): FirstRunChange(label: "Allow new Health data", act: .askHealth, closes: false)
        case (.health, _): FirstRunChange(label: "Open Health", act: .openHealth, closes: false)
        case (.location, .partly): FirstRunChange(label: "Allow Always in Settings", act: .settings, closes: false)
        case (.photos, .partly): FirstRunChange(label: "Choose more photos", act: .choosePhotos, closes: false)
        case (.contacts, .partly): FirstRunChange(label: "Add contacts in Settings", act: .settings, closes: closesApp)
        case (_, .denied): FirstRunChange(label: "Turn on in Settings", act: .settings, closes: closesApp)
        default: nil
        }
    }
}

extension View {
    func firstRunScreen(_ identifier: String) -> some View {
        accessibilityElement(children: .contain).accessibilityIdentifier(identifier)
    }
}

enum FirstRunWords {
    static func before(_ source: PhoneSource) -> String? {
        switch source {
        case .location: "iOS asks twice. Choose Allow While Using, then Change to Always Allow."
        case .health: "iOS shows a list. Turn on whatever you're happy for Lifestream to read."
        case .contacts: "iOS closes Lifestream if you change this later in Settings. It opens back here."
        default: nil
        }
    }

    static func partial(_ source: PhoneSource, count: Int?) -> String {
        switch source {
        case .location: "Only while Lifestream is open. Your days will miss the way between places."
        case .photos: count.map { "Only the \(FirstRunFinds.photosAndVideos($0)) you chose. Your days will miss the rest." } ?? "Only the photos and videos you chose. Your days will miss the rest."
        case .contacts: count.map { "Only the \(Words.count($0, "contact")) you chose. Your days will name no one else." } ?? "Only the contacts you chose. Your days will name no one else."
        case .health: "New kinds of Health data wait for you to allow them. The rest is read."
        default: "Only in part. Your days will miss the rest."
        }
    }

    static let asked = "Asked. Health decides what Lifestream reads; change it in the Health app, under Sharing."

    static func off(_ source: PhoneSource) -> String {
        switch source {
        case .location: "Off. Your days will have no places or journeys."
        case .contacts: "Off. Your days will name no one."
        default: "Off. Your days will miss \(source.misses)."
        }
    }
}

private struct PlaceMap: View {
    let place: FirstRunModel.Place

    var body: some View {
        let centre = CLLocationCoordinate2D(latitude: place.latitude, longitude: place.longitude)
        GeometryReader { proxy in
            StillMap(rect: StillMap.rect(around: centre, metres: 900, size: proxy.size))
        }
        .background(MapGround.land)
    }
}

private struct DoneColumn: View {
    @ObservedObject var model: FirstRunModel
    @ObservedObject var permissions: PermissionsModel
    @EnvironmentObject private var app: CaptureAppModel
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var typeSize
    let paired: Bool
    let pair: () -> Void

    private struct Act {
        let label: String
        var busy = false
        let perform: () -> Void
    }

    var body: some View {
        let streams = model.streams
        FirstRunColumn("This iPhone records") { EmptyView() } line: {
            FirstRunLine("Anything off can be turned on here, or later in Connectors.")
        } below: {
            VStack(alignment: .leading, spacing: Cockpit.Space.s6) {
                Card(group: true) {
                    ForEach(Array(streams.enumerated()), id: \.element) { index, source in
                        let said = self.said(source)
                        row(source.name, icon: source.icon, mark: said.mark, act: said.act, separator: index < streams.count - 1)
                            .accessibilityIdentifier("permissions.row.\(source.permission ?? "")")
                    }
                }
                Card(group: true) {
                    row("Your Mac", icon: .workMac,
                        mark: paired ? SignalMark(kind: nil, word: "Paired") : SignalMark(kind: .idle, word: "Not paired"),
                        act: paired ? nil : Act(label: "Pair", perform: pair), separator: false)
                        .accessibilityIdentifier("firstrun.mac")
                }
            }
        }
        .firstRunScreen("firstrun.done")
    }

    private func said(_ source: PhoneSource) -> (mark: SignalMark, act: Act?) {
        let id = source.permission ?? ""
        guard let state = permissions.stated(id) else { return (.on, nil) }
        let word = PhoneWords.word(id, state)
        let settings = Act(label: "Open Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) } }
        switch state {
        case .on: return (SignalMark(kind: nil, word: word), nil)
        case .asked: return (SignalMark(kind: nil, word: model.healthWaits ? "Waiting for your Mac" : word), nil)
        case .limited where !(permissions.rows.first(where: { $0.id == id }).map(permissions.prompts) ?? false), .off:
            return (SignalMark(kind: .idle, word: word), settings)
        case .limited, .notNow, .notAsked, .asking:
            return (SignalMark(kind: .idle, word: word),
                    Act(label: "Allow", busy: state == .asking) { Task { await permissions.ask(id, start: app.start) } })
        }
    }

    @ViewBuilder private func row(_ name: String, icon: Cockpit.Icon, mark: SignalMark, act: Act?, separator: Bool) -> some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                Text(name).cockpit(.rowTitle).foregroundStyle(Cockpit.Color.text)
                SignalWord(mark)
                if let act {
                    Button(act.label, action: act.perform)
                        .buttonStyle(.cockpit(.secondary, size: .small, busy: act.busy))
                        .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Cockpit.Space.s4)
            .overlay(alignment: .bottom) {
                if separator { Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.Stroke.border) }
            }
            .accessibilityElement(children: .combine)
            .accessibilityValue(act?.label ?? "")
            .accessibilityAction(named: Text(act?.label ?? "")) { if let act, !act.busy { act.perform() } }
        } else {
            ListRow(name, meta: mark.word, signal: mark.kind,
                    leading: .symbol(icon), separator: separator,
                    control: act.map { act in .act(act.label, busy: act.busy, perform: act.perform) }) {
                EmptyView()
            }
        }
    }
}
