import Cockpit
import Combine
import CoreLocation
import HomeLink
import LifestreamCaptureCore
@preconcurrency import Photos
import SwiftUI
import UIKit

@MainActor
final class FirstRunModel: ObservableObject {
    enum Screen: Hashable {
        case welcome, pair, stream(PhoneSource), done

        var key: String {
            switch self {
            case .welcome: "welcome"
            case .pair: "pair"
            case .stream(let source): source.rawValue
            case .done: "done"
            }
        }
    }

    enum Phase: Equatable {
        case idle
        case asking
        case reading
        case standing
    }

    struct Place: Equatable {
        let latitude: Double
        let longitude: Double
    }

    @Published private(set) var screen: Screen?
    @Published private(set) var phase = Phase.idle
    @Published private(set) var finds: [PhoneSource: FirstRunFind] = [:]
    @Published private(set) var place: Place?
    @Published private(set) var healthWaits = false
    @Published private(set) var pair = PairModel()

    let permissions: PermissionsModel
    private let record: FirstRunRecord
    private let paired: () -> Bool
    private var placing: Task<Void, Never>?
    private var waiting: AnyCancellable?

    init(permissions: PermissionsModel, record: FirstRunRecord, paired: @escaping () -> Bool) {
        self.permissions = permissions
        self.record = record
        self.paired = paired
        arm(pair)
        let runtime = permissions.runtime
        waiting = runtime.shipping.shipper.$homeName.removeDuplicates().map { _ in () }
            .merge(with: runtime.$restoreLanded.removeDuplicates().map { _ in () })
            .sink { [weak self] in
                guard let self, self.screen == .done else { return }
                self.readHealthWaits()
            }
    }

    var streams: [PhoneSource] { PhoneSource.firstRun(permissions.rows) }

    private var order: [Screen] { [.welcome, .pair] + streams.map(Screen.stream) + [.done] }

    private var past: Set<String> { record.facts.past }

    func state(_ source: PhoneSource) -> PermissionsModel.State {
        permissions.rows.first { $0.id == source.permission }?.state ?? .absent
    }

    func plainYes(_ screen: Screen) -> Bool {
        switch screen {
        case .welcome, .done: false
        case .pair: paired()
        case .stream(let source): [.granted, .asked].contains(state(source))
        }
    }

    func asks(_ source: PhoneSource) -> Bool { phase == .asking && screen == .stream(source) }

    func stands(_ source: PhoneSource) -> Bool { phase == .standing && screen == .stream(source) }

    var held: Bool { phase == .asking || phase == .standing }

    var marks: [StepMarks.Mark] {
        ([.pair] + streams.map(Screen.stream)).map { mark in
            if mark == screen { return .here }
            if plainYes(mark) { return .done }
            return past.contains(mark.key) ? .past : .ahead
        }
    }

    var showsMarks: Bool {
        switch screen {
        case .pair, .stream, .done: true
        default: false
        }
    }

    func begin() {
        guard screen == nil else { return }
        go(next(after: nil))
    }

    func open(_ link: PairingLink) {
        remember(.welcome)
        let model = PairModel(link: link)
        arm(model)
        pair = model
        go(.pair)
        Task { await model.look() }
    }

    private func arm(_ model: PairModel) {
        model.done = { [weak self, weak model] in
            guard let self, let model, self.pair === model else { return }
            self.advance()
        }
    }

    func pass() {
        guard let screen else { return }
        remember(screen)
        advance()
    }

    func allow(_ source: PhoneSource, start: () async -> Void) async {
        guard phase == .idle, screen == .stream(source), let id = source.permission else { return }
        phase = .asking
        await permissions.ask(id, start: start)
        await settle(source)
    }

    func answered(from old: [PermissionsModel.Row], to new: [PermissionsModel.Row]) {
        if screen == .done { readHealthWaits() }
        guard phase == .idle, case .stream(let source)? = screen else { return }
        let state = { (rows: [PermissionsModel.Row]) in rows.first { $0.id == source.permission }?.state }
        guard state(old) != state(new) else { return }
        phase = .reading
        Task { await settle(source) }
    }

    private func settle(_ source: PhoneSource) async {
        let state = state(source)
        if [.granted, .asked].contains(state) || state.partial { await read(source) }
        if source == .location, state != .undetermined, state != .denied { readPlace() }
        if self.state(source) != state { return await settle(source) }
        guard screen == .stream(source) else { return }
        guard state == .granted || (state == .asked && finds[source]?.line != nil) else {
            phase = .idle
            return
        }
        phase = .standing
        try? await Task.sleep(for: PairModel.stands)
        if screen == .stream(source) { advance() }
    }

    func chooseMorePhotos() {
        guard UITestGrants.script == nil, let top = Self.topController() else { return }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: top) { _ in
            Task { @MainActor in await self.read(.photos) }
        }
    }

    func advance() {
        go(next(after: screen))
    }

    var previous: Screen? {
        guard let screen, let at = order.firstIndex(of: screen), at > 0 else { return nil }
        return order[at - 1]
    }

    func back() {
        guard !held, let previous else { return }
        go(previous)
    }

    private func next(after: Screen?) -> Screen {
        let screens = order
        let start = after.flatMap { screens.firstIndex(of: $0).map { $0 + 1 } } ?? 0
        return screens[start...].first { $0 == .done || (!past.contains($0.key) && !plainYes($0)) } ?? .done
    }

    private func go(_ screen: Screen) {
        self.screen = screen
        phase = .idle
        if screen != .stream(.location) {
            placing?.cancel()
            placing = nil
        }
        switch screen {
        case .pair:
            if paired() { pair.standsPaired() }
        case .stream(let source):
            let state = state(source)
            if state.partial || [.granted, .asked].contains(state), finds[source] == nil {
                Task { await read(source) }
            }
            if source == .location, state == .partly { readPlace() }
        case .done:
            readHealthWaits()
        case .welcome:
            break
        }
    }

    private func remember(_ screen: Screen) {
        record.leave(screen.key)
        permissions.tell()
    }

    private func readHealthWaits() {
        let store = permissions.runtime.captureStore
        Task { healthWaits = !(await store.historyReadsAdmitted) }
    }

    private func read(_ source: PhoneSource) async {
        var find = await FirstRunFinds.read(source)
        finds[source] = find
        guard !find.newest.isEmpty else { return }
        find.photos = await FirstRunFinds.thumbnails(find.newest)
        find.newest = []
        finds[source] = find
    }

    private func readPlace() {
        guard place == nil, placing == nil else { return }
        placing = Task {
            if let fix = await FirstRunFinds.place() { place = Place(latitude: fix.latitude, longitude: fix.longitude) }
            if !Task.isCancelled { placing = nil }
        }
    }

    private static func topController() -> UIViewController? {
        let window = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
        var top = window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }
}

@MainActor
final class FirstRunRecord: ObservableObject {
    static let legacyKeys = ["first-run.past", "first-run.continued", "permissions.asked-always"]

    @Published private(set) var facts: CaptureStore.FirstRun
    private let store: CaptureStore
    private(set) var writing: Task<Void, Never>?

    init(store: CaptureStore, defaults: UserDefaults = .standard) {
        self.store = store
        facts = store.firstRunAtOpen
        let keys = Self.legacyKeys
        guard keys.contains(where: { defaults.object(forKey: $0) != nil }) else { return }
        guard !store.madeAtOpen, facts == CaptureStore.FirstRun() else {
            keys.forEach(defaults.removeObject(forKey:))
            return
        }
        let kept = CaptureStore.FirstRun(past: Set(defaults.stringArray(forKey: keys[0]) ?? []),
                                         started: defaults.bool(forKey: keys[1]), askedAlways: defaults.bool(forKey: keys[2]))
        facts = kept
        writing = Task { [store] in
            guard (try? await store.setFirstRun(kept)) != nil else { return }
            keys.forEach(defaults.removeObject(forKey:))
        }
    }

    func leave(_ key: String) { change { $0.past.insert(key) } }

    func start() { change { $0.started = true } }

    func spentAlways(_ spent: Bool) { change { $0.askedAlways = spent } }

    func again() { change { $0.past = []; $0.started = false } }

    private func change(_ edit: (inout CaptureStore.FirstRun) -> Void) {
        var changed = facts
        edit(&changed)
        guard changed != facts else { return }
        facts = changed
        let previous = writing
        writing = Task { [store] in
            await previous?.value
            try? await store.setFirstRun(changed)
        }
    }
}
