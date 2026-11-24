import Evidence
import Foundation

public struct ControlRequest: Codable, Sendable {
    public var action: String
    public var durationSeconds: Double?
    public var mode: String?
    public var bundleID: String?
    public var site: String?
    public var name: String?
    public var code: String?

    public init(action: String, durationSeconds: Double? = nil, mode: String? = nil, bundleID: String? = nil,
                site: String? = nil, name: String? = nil, code: String? = nil) {
        self.action = action
        self.durationSeconds = durationSeconds
        self.mode = mode
        self.bundleID = bundleID
        self.site = site
        self.name = name
        self.code = code
    }

    func validatedAction() throws -> ControlAction {
        guard let action = ControlAction(rawValue: action) else { throw RecorderControlError.invalidRequest }
        if let duration = durationSeconds {
            guard action == .start, duration.isFinite, duration >= 1, duration <= 86400 else {
                throw RecorderControlError.invalidRequest
            }
        }
        if mode != nil || bundleID != nil || site != nil {
            guard action == .modes, modeChange != nil else { throw RecorderControlError.invalidRequest }
        }
        let pairing = name != nil || code != nil
        guard pairing == (action == .pair), !pairing || (name != nil && code != nil) else { throw RecorderControlError.invalidRequest }
        return action
    }

    var modeChange: (mode: RecordingMode, target: RecordingModeTarget)? {
        guard let spelled = mode, let mode = RecordingMode(rawValue: spelled) else { return nil }
        switch (bundleID, site) {
        case (let bundleID?, nil) where RecordingModes.isValidBundleID(bundleID): return (mode, .app(bundleID))
        case (nil, let site?) where Site(rule: site) != nil: return (mode, .site(site))
        default: return nil
        }
    }
}

public struct ControlResponse: Codable, Sendable {
    public var ok: Bool
    public var state: String
    public var message: String?
    public var captures: Int?
    public var gaps: Int?
    public var pendingFrames: Int?
    public var videoCompactionStatus: String?
    public var pendingVideoImages: Int?
    public var pendingVideoBytes: Int?
    public var shipping: String?
    public var modes: RecordingModeListing?
    public var home: ControlHome?

    public init(ok: Bool, state: String, message: String? = nil, captures: Int? = nil, gaps: Int? = nil,
                pendingFrames: Int? = nil, videoCompactionStatus: String? = nil, pendingVideoImages: Int? = nil, pendingVideoBytes: Int? = nil,
                shipping: String? = nil, modes: RecordingModeListing? = nil, home: ControlHome? = nil) {
        self.ok = ok
        self.state = state
        self.message = message
        self.captures = captures
        self.gaps = gaps
        self.pendingFrames = pendingFrames
        self.videoCompactionStatus = videoCompactionStatus
        self.pendingVideoImages = pendingVideoImages
        self.pendingVideoBytes = pendingVideoBytes
        self.shipping = shipping
        self.modes = modes
        self.home = home
    }
}

public struct ControlHome: Codable, Sendable, Equatable {
    public let home: String?
    public let pass: String
    public let unit: String?

    public init(home: String?, pass: String, unit: String?) {
        self.home = home
        self.pass = pass
        self.unit = unit
    }

    enum CodingKeys: String, CodingKey {
        case home, pass, unit
    }

    public func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: CodingKeys.self)
        try fields.encode(home, forKey: .home)
        try fields.encode(pass, forKey: .pass)
        try fields.encode(unit, forKey: .unit)
    }
}

enum ControlAction: String {
    case start, pause, status, shutdown, ship, modes, pair

    var clientDeadline: TimeInterval {
        switch self {
        case .pair: return 120
        case .ship: return 4 * 60 * 60
        case .pause, .shutdown: return 15
        case .start, .status, .modes: return 3
        }
    }
}
