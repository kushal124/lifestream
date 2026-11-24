import AVFoundation
import Cockpit
import LifestreamCaptureCore
import SwiftUI

enum PhoneSource: String, CaseIterable, Identifiable, Hashable {
    case location, motion, health, photos, contacts, screenTime, voice, camera, checkIns, notes

    var id: String { rawValue }

    static func of(_ connector: String) -> PhoneSource? {
        allCases.first { $0.stream.id == connector }
    }

    var stream: DeclaredStream {
        switch self {
        case .location: .location
        case .motion: .motion
        case .health: .appleHealth
        case .photos: .applePhotos
        case .contacts: .appleContacts
        case .screenTime: .screenTime
        case .voice: .voiceNotes
        case .camera: .camera
        case .checkIns: .checkin
        case .notes: .notes
        }
    }

    var identifier: String {
        switch self {
        case .photos: "machinery.library"
        case .screenTime: "machinery.usage"
        case .checkIns: "machinery.checkins"
        default: "machinery.\(rawValue)"
        }
    }

    var permission: String? { stream.grant }

    static func firstRun(_ permissions: [PermissionsModel.Row]) -> [PhoneSource] {
        allCases.filter { source in
            guard source != .checkIns, let id = source.permission else { return false }
            return permissions.first { $0.id == id }.map { $0.state != .absent } ?? false
        }
    }

    var device: AVMediaType? {
        switch self {
        case .voice: .audio
        case .camera: .video
        default: nil
        }
    }


    var name: String { stream.name }
    var icon: Cockpit.Icon { stream.icon }
    var gives: String { stream.gives }

    var misses: String { stream.misses ?? "it" }

    var why: String { stream.why ?? gives }


    enum Access: Equatable {
        case free
        case checking
        case stated(PermissionsModel.Stated)
        case device(AVAuthorizationStatus)
        case absent
        case scheduleOff
    }

    @MainActor
    func access(_ needs: PhoneNeeds) -> Access {
        if let device { return .device(needs.device(device)) }
        let permissions = needs.permissions
        guard let permission, permissions.rows.contains(where: { $0.id == permission }) else { return .free }
        guard permissions.read || AppRuntime.isUITesting else { return .checking }
        guard let stated = permissions.stated(permission) else { return .absent }
        if self == .checkIns, stated == .on, !AppRuntime.shared.checkInModel.status.state.prompting { return .scheduleOff }
        return .stated(stated)
    }

    @MainActor
    func signal(_ needs: PhoneNeeds) -> SignalMark {
        switch access(needs) {
        case .free: .on
        case .checking: .checking
        case .stated: permission.flatMap { needs.permissions.mark(of: $0) } ?? .on
        case .device(.authorized): .on
        case .device(.notDetermined): .notAsked
        case .device, .scheduleOff: .off
        case .absent: SignalMark(kind: .idle, word: "Not in this build")
        }
    }

    @MainActor
    func permissionName(_ needs: PhoneNeeds) -> String? {
        if let device { return device == .audio ? "the microphone" : "the camera" }
        guard let permission else { return nil }
        return needs.permissions.rows.first(where: { $0.id == permission })?.name
    }
}
