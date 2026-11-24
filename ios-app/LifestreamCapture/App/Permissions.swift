import Cockpit
import Combine
import CoreLocation
import CoreMotion
#if SCREEN_TIME
import FamilyControls
#endif
import LifestreamCaptureCore
import Photos
import SwiftUI
import UIKit
import UserNotifications

@MainActor
final class PermissionsModel: ObservableObject {
    enum State: Equatable {
        case undetermined
        case granted
        case partly
        case denied
        case asked
        case absent

        var partial: Bool { self == .partly }
    }

    enum Stated: String {
        case on, limited, off
        case notNow = "not-now"
        case notAsked = "not-asked"
        case asked, asking
    }

    struct Row: Identifiable, Equatable {
        let id: String
        let name: String
        let why: String
        var state: State
        let closesApp: Bool
    }

    @Published private(set) var rows: [Row] = PermissionsModel.listed
    @Published private(set) var read = false
    @Published private(set) var asking: String?
    private var reads = 0
    private var screenTime: AnyCancellable?
    private var location: AnyCancellable?
    private var health: AnyCancellable?

    let runtime: AppRuntime
    private let script: [String: String]?
    private let told: (@MainActor ([String: String]) -> Void)?

    convenience init(runtime: AppRuntime) {
        if AppRuntime.isUITesting {
            self.init(runtime: runtime, script: UITestGrants.script ?? [:], told: nil)
        } else {
            self.init(runtime: runtime, script: nil) { grants in
                runtime.machineDiary.record(grants)
                runtime.shipping.link.tell(grants: grants)
            }
        }
    }

    init(runtime: AppRuntime, script: [String: String]?, told: (@MainActor ([String: String]) -> Void)?) {
        self.runtime = runtime
        self.script = script
        self.told = told
        guard script == nil else { return }
        location = runtime.locationRecorder.authorizationChanged
            .sink { [weak self] _ in Task { await self?.refresh() } }
        health = NotificationCenter.default.publisher(for: HealthRecorder.readsAllowedNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in Task { await self?.refresh() } }
        #if SCREEN_TIME
        screenTime = AuthorizationCenter.shared.$authorizationStatus
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in Task { await self?.refresh() } }
        #endif
    }

    #if SCREEN_TIME
    private static let screenTimeState = State.undetermined
    #else
    private static let screenTimeState = State.absent
    #endif

    static let listed: [Row] = [
        Row(id: "location", name: "Location, Always", why: "Where you were and how you moved.", state: .undetermined, closesApp: false),
        Row(id: "motion", name: "Motion & Fitness", why: "Walking, driving, still.", state: .undetermined, closesApp: true),
        Row(id: "health", name: "Health", why: "Sleep times your check-ins; steps, heart and workouts fill in your days.", state: .undetermined, closesApp: false),
        Row(id: "photos", name: "Photos, Full Access", why: "Your photos' times and places.", state: .undetermined, closesApp: true),
        Row(id: "contacts", name: "Contacts", why: "The names in your days.", state: .undetermined, closesApp: true),
        Row(id: "screen-time", name: "Screen Time", why: "Which apps you used.", state: screenTimeState, closesApp: false),
        Row(id: "notifications", name: "Notifications", why: "Check-ins, and warnings when syncing stops.", state: .undetermined, closesApp: false),
    ]

    func stated(_ id: String) -> Stated? {
        guard let row = rows.first(where: { $0.id == id }) else { return nil }
        let screen = PhoneSource.allCases.first { $0.permission == id }?.rawValue ?? id
        return switch row.state {
        case .absent: nil
        case _ where asking == id: .asking
        case .undetermined: runtime.firstRun.facts.past.contains(screen) ? .notNow : .notAsked
        case .granted: .on
        case .partly: .limited
        case .denied: .off
        case .asked: .asked
        }
    }

    func mark(of id: String) -> SignalMark? {
        guard let state = stated(id) else { return nil }
        let kind: Cockpit.SignalKind? = switch state {
        case .on, .asked: nil
        case .limited, .off: .caution
        case .notNow, .notAsked, .asking: .idle
        }
        return SignalMark(kind: kind, word: PhoneWords.word(id, state))
    }

    var grants: [String: String] {
        rows.reduce(into: [:]) { grants, row in grants[row.id] = stated(row.id)?.rawValue }
    }

    func tell() {
        guard read, let told else { return }
        told(grants)
    }

    func refresh() async {
        var fresh = Self.listed
        if let script {
            for index in fresh.indices where fresh[index].state != .absent {
                let id = fresh[index].id
                fresh[index].state = script[id] == "absent" ? .absent : UITestGrants.state(id)
            }
        } else {
            if runtime.locationRecorder.authorizationStatus == .notDetermined { runtime.firstRun.spentAlways(false) }
            reads += 1
            let mine = reads
            for index in fresh.indices { fresh[index].state = await state(fresh[index].id) }
            guard mine == reads else { return }
        }
        rows = fresh
        read = true
        tell()
    }

    func ask(_ id: String, start: () async -> Void) async {
        guard let row = rows.first(where: { $0.id == id }) else { return }
        let location = id == "location"
        if prompts(row) || (location && runtime.locationRecorder.serviceRequested != true)
            || (location && row.state == .partly && !runtime.firstRun.facts.askedAlways) {
            await prompt(id, start: start)
        } else if let url = URL(string: UIApplication.openSettingsURLString) {
            await UIApplication.shared.open(url)
        }
    }

    func prompts(_ row: Row) -> Bool {
        row.state == .undetermined || (row.id == "health" && row.state == .partly)
    }

    private func prompt(_ id: String, start: () async -> Void) async {
        guard asking == nil else { return }
        asking = id
        tell()
        if script != nil {
            await scripted(id, start: start)
        } else if id == "location" {
            await askLocation(start: start)
        } else {
            await ask(id)
        }
        await refresh()
        asking = nil
        tell()
    }

    private func askLocation(start: () async -> Void) async {
        let recorder = runtime.locationRecorder
        if recorder.serviceRequested != true {
            await start()
        } else if recorder.authorizationStatus == .notDetermined {
            recorder.requestWhenInUseAuthorization()
        }
        guard await recorder.authorizationAnswer() == .authorizedWhenInUse, !runtime.firstRun.facts.askedAlways else { return }
        if await recorder.askAlways() { runtime.firstRun.spentAlways(true) }
    }

    private func ask(_ id: String) async {
        switch id {
        case "motion": await runtime.motionRecorder.requestAuthorizationAndSweep()
        case "health": await runtime.healthRecorder.requestAuthorizationAndBackfill()
        case "photos": _ = await PhotosServices.shared.library.requestAccess()
        case "contacts": await runtime.contactsRecorder.requestAuthorization()
        case "screen-time": try? await runtime.usageRecorder.requestAuthorization()
        case "notifications": _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        default: break
        }
    }

    private func scripted(_ id: String, start: () async -> Void) async {
        if id == "location" { await start() }
        guard let answer = script?[id] else { return }
        if id == "location" {
            UITestGrants.answer(id, "while-using")
            await refresh()
        }
        if answer == "held" {
            try? await Task.sleep(for: .seconds(86_400))
            return
        }
        if answer == "late-always" {
            Task {
                try? await Task.sleep(for: .seconds(1))
                UITestGrants.answer(id, "always")
                await refresh()
            }
            return
        }
        UITestGrants.answer(id, answer)
    }

    private func state(_ id: String) async -> State {
        switch id {
        case "location":
            switch runtime.locationRecorder.authorizationStatus {
            case .notDetermined: return .undetermined
            case .authorizedAlways: return runtime.locationRecorder.serviceRequested == true ? .granted : .undetermined
            case .authorizedWhenInUse: return .partly
            default: return .denied
            }
        case "motion":
            switch CMMotionActivityManager.authorizationStatus() {
            case .notDetermined: return .undetermined
            case .authorized: return .granted
            default: return .denied
            }
        case "health":
            let recorder = runtime.healthRecorder
            switch await recorder.sheet() {
            case nil: return .absent
            case .first: return .undetermined
            case .newTypes: return .partly
            case .answered: return await recorder.yielded() ? .granted : .asked
            }
        case "photos":
            switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
            case .notDetermined: return .undetermined
            case .authorized: return .granted
            case .limited: return .partly
            default: return .denied
            }
        case "contacts":
            switch await runtime.contactsRecorder.authorization() {
            case .notDetermined: return .undetermined
            case .authorized: return .granted
            case .limited: return .partly
            case .denied, .restricted: return .denied
            }
        case "screen-time":
            #if SCREEN_TIME
            let status = AuthorizationCenter.shared.authorizationStatus
            if #available(iOS 26.4, *), status == .approvedWithDataAccess { return .granted }
            switch status {
            case .notDetermined: return .undetermined
            case .approved: return .granted
            default: return .denied
            }
            #else
            return .absent
            #endif
        case "notifications":
            switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
            case .notDetermined: return .undetermined
            case .authorized, .provisional, .ephemeral: return .granted
            default: return .denied
            }
        default: return .undetermined
        }
    }
}

enum UITestGrants {
    static let script: [String: String]? = {
        let arguments = ProcessInfo.processInfo.arguments
        guard AppRuntime.isUITesting, let at = arguments.firstIndex(of: "--ui-test-grants"), at + 1 < arguments.count else { return nil }
        return Dictionary(arguments[at + 1].split(separator: ",").compactMap { pair -> (String, String)? in
            let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
            return parts.count == 2 ? (parts[0], parts[1]) : nil
        }, uniquingKeysWith: { _, last in last })
    }()

    static let key = "ui-test.grants.answered"

    static var answered: [String: String] {
        UserDefaults.standard.dictionary(forKey: key) as? [String: String] ?? [:]
    }

    static func answer(_ id: String, _ answer: String) {
        var all = answered
        all[id] = answer
        UserDefaults.standard.set(all, forKey: key)
    }

    static func state(_ id: String) -> PermissionsModel.State {
        switch answered[id] {
        case nil: .undetermined
        case "on", "always": .granted
        case "asked": .asked
        case "while-using", "limited": .partly
        default: .denied
        }
    }
}
