import Foundation
import HomeLink

typealias ConnectorsReport = HomeLink.StreamsReport

extension ConnectorsReport {
    enum Act: Equatable {
        case pause(String, history: Bool)
        case resume(String, history: Bool)
        case setting(String, member: String)
        case seal(String, member: String)
        case refresh(String)
        case endInstall(String)
        case retirePhone(String)
    }

    func offers(_ act: Act, here: String? = nil) -> Bool {
        switch act {
        case .pause(let id, let history):
            return connector(id).map { $0.setUp && !$0.copies.isEmpty && (history ? $0.pauses.isEmpty : $0.paused(.all) == nil) } ?? false
        case .resume(let id, let history):
            return connector(id)?.paused(history ? .history : .all) != nil
        case .setting(let id, let member):
            guard let connector = connector(id), let field = connector.members.first(where: { $0.key == member }),
                  let control = field.control, control != .secret else { return false }
            if control == .path, let only = field.where, only.unit != here { return false }
            return field.panel != nil || connector.processing?.rows.contains { $0.member == member || $0.privacy?.member == member } == true
        case .seal(let id, let member):
            guard let connector = connector(id), let field = connector.members.first(where: { $0.key == member }) else { return false }
            return field.control == .secret && field.panel != nil && !connector.routes.contains { $0.sets.contains(member) }
        case .refresh(let id):
            guard let refresh = connector(id)?.refreshNow else { return false }
            return refresh.blocked == nil
        case .endInstall(let pass):
            return devices.contains { $0.replaced.contains(pass) }
        case .retirePhone(let unit):
            return device(unit).map { $0.kind == .phone && !$0.retired } ?? false
        }
    }

    func device(_ unit: String) -> HomeLink.DeviceRow? {
        devices.first { $0.unit == unit }
    }

    func connector(_ id: String) -> Connector? {
        connectors.first { $0.id == id }
    }

    func member(_ id: String, _ key: String) -> Connector.Member? {
        connector(id)?.members.first { $0.key == key }
    }
}

typealias Connector = HomeLink.Connector


struct PairingAnswer: Decodable, Equatable, Sendable {
    let code: String
    var link: String? = nil
    var why: String? = nil
    var match: String? = nil
    let expiresMs: Int64

    enum CodingKeys: String, CodingKey {
        case code, link, why, match
        case expiresMs = "expires_ms"
    }
}
