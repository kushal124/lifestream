import AVFoundation
import Cockpit
import Combine
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit

struct PhoneNeed: Identifiable, Equatable {
    let id: String
    let weight: HomeLink.Weight
    let title: String
    let line: String?
    let stamp: String
}

enum NeedStrip: Identifiable, Equatable {
    case home(HomeLink.Need)
    case own(PhoneNeed)

    var id: String {
        switch self {
        case .home(let need): need.id
        case .own(let need): need.id
        }
    }

    var weight: HomeLink.Weight {
        switch self {
        case .home(let need): need.weight
        case .own(let need): need.weight
        }
    }

    var title: String {
        switch self {
        case .home(let need): need.words
        case .own(let need): need.title
        }
    }

    var line: String? {
        switch self {
        case .home(let need): need.line.flatMap { $0.isEmpty ? nil : $0 }
        case .own(let need): need.line
        }
    }

    var about: String? {
        switch self {
        case .home(let need): need.about
        case .own: nil
        }
    }
}

@MainActor
final class PhoneNeeds: ObservableObject {
    static let shared = PhoneNeeds()
    private static let dismissedKey = "needs.dismissed"

    @Published private(set) var home: [HomeLink.Need] = []
    private var listed: [HomeLink.Need] = []
    private var hidden: Set<String> = []
    @Published private(set) var needs: [PhoneNeed] = []
    @Published private(set) var back: Date?
    @Published private(set) var devices: [AVMediaType: AVAuthorizationStatus] = [:]
    let permissions = PermissionsModel(runtime: .shared)

    private let build = BuildExpiry.read()
    private var subscriptions: Set<AnyCancellable> = []

    private init() {
        permissions.objectWillChange
            .sink { [weak self] _ in Task { @MainActor in self?.recompute() } }
            .store(in: &subscriptions)
        AppRuntime.shared.shipping.shipper.$saved
            .map { $0?.needs ?? [] }
            .removeDuplicates()
            .sink { [weak self] needs in Task { @MainActor in self?.take(needs) } }
            .store(in: &subscriptions)
        NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
            .sink { [weak self] _ in Task { await self?.refresh() } }
            .store(in: &subscriptions)
        Task { await refresh() }
    }

    var banner: [HomeLink.Need] { home.filter(\.banner) }

    var strips: [NeedStrip] {
        needs.map(NeedStrip.own) + home.filter { !$0.banner }.map(NeedStrip.home)
    }

    var count: Int { strips.count }

    var stopped: Bool { strips.contains { $0.weight == .stopped } }

    func take(_ needs: [HomeLink.Need]) {
        let wasBanner = Set(listed.filter(\.banner).map(\.id))
        listed = needs
        hidden = hidden.filter { key in needs.contains { Self.key($0) == key } }
        if !wasBanner.isEmpty, !needs.contains(where: \.banner) { back = AppClock.now }
        if needs.contains(where: \.banner) { back = nil }
        publish()
        recompute()
    }

    private func publish() {
        let shown = listed.filter { !hidden.contains(Self.key($0)) }
        if shown != home { home = shown }
    }

    static func key(_ need: HomeLink.Need) -> String {
        need.id + "|" + (need.sinceMs.map(String.init) ?? need.words)
    }

    func dismiss(_ strip: NeedStrip) async {
        guard strip.weight == .advice else { return }
        switch strip {
        case .home(let need):
            let key = Self.key(need)
            hidden.insert(key)
            publish()
            do {
                try await AppRuntime.shared.life.act(need: need.id, do: "dismiss", of: nil)
            } catch {
                hidden.remove(key)
                publish()
            }
            await AppRuntime.shared.homeStreams.read()
        case .own(let need):
            var dismissed = Self.dismissedOwn
            dismissed[need.id] = need.stamp
            UserDefaults.standard.set(dismissed, forKey: Self.dismissedKey)
            recompute()
        }
    }

    private static var dismissedOwn: [String: String] {
        UserDefaults.standard.dictionary(forKey: dismissedKey) as? [String: String] ?? [:]
    }

    func device(_ type: AVMediaType) -> AVAuthorizationStatus {
        devices[type] ?? AVCaptureDevice.authorizationStatus(for: type)
    }

    func refresh() async {
        devices = [.audio: AVCaptureDevice.authorizationStatus(for: .audio),
                   .video: AVCaptureDevice.authorizationStatus(for: .video)]
        await permissions.refresh()
        recompute()
    }

    func allow(_ type: AVMediaType) async {
        if device(type) == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: type)
        } else if let url = URL(string: UIApplication.openSettingsURLString) {
            await UIApplication.shared.open(url)
        }
        devices[type] = AVCaptureDevice.authorizationStatus(for: type)
    }

    func recompute() {
        var fresh: [PhoneNeed] = []
        let runtime = AppRuntime.shared
        if let room = Self.room(runtime.captureStore.volume.room, listed: listed, unit: runtime.shipping.shipper.unit, name: Self.name) {
            fresh.append(room)
        }
        if let build, AppClock.now >= build.notice { fresh.append(Self.expiry(build)) }
        let dismissed = Self.dismissedOwn
        fresh = fresh.filter { $0.weight == .stopped || dismissed[$0.id] != $0.stamp }
        if fresh != needs { needs = fresh }
    }

    static var name: String {
        let runtime = AppRuntime.shared
        return runtime.shipping.shipper.unit.flatMap { unit in runtime.homeStreams.read?.devices.first { $0.unit == unit }?.name }
            ?? PhoneLink.name()
    }

    static func expiry(_ build: BuildLife) -> PhoneNeed {
        PhoneNeed(id: "build.expiry", weight: .advice, title: "This iPhone's build stops on \(Words.longDate(build.expires))",
                  line: "Reinstall it from your Mac", stamp: String(Int64(build.expires.timeIntervalSince1970)))
    }

    static func room(_ room: Room, listed: [HomeLink.Need], unit: String?, name: String) -> PhoneNeed? {
        guard room == .full, !listed.contains(where: { $0.id == unit.map { "room:\($0)" } }) else { return nil }
        return PhoneNeed(id: "room", weight: .stopped, title: "\(name)'s disk is full",
                         line: "Location and Health aren't saved · free some space on it", stamp: "full")
    }
}
