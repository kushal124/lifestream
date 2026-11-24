import BrowserPages
import Cockpit
import CoreImage
import Evidence
import Foundation
import HomeLink
import Passwords
import Shipping

struct HostState: Encodable, Equatable {
    struct Inset: Encodable, Equatable {
        let left: Double
        let centre: Double

        static func of(buttons: CGRect, zoom: Double, fullScreen: Bool) -> Inset? {
            guard !fullScreen, zoom > 0 else { return nil }
            return Inset(left: buttons.maxX / zoom, centre: buttons.midY / zoom)
        }
    }

    struct Line: Encodable, Equatable {
        let signal: String
        let words: String
    }

    struct Reach: Encodable, Equatable {
        let state: String
        let revision: Int
        let tone: String?
        let title: String?
        let line: String?
        let meta: String?
        let acts: [Act]
        let last: String?
        let path: [Link]
        let checking: Bool

        struct Act: Encodable, Equatable {
            let `do`: String
            let label: String
        }

        struct Link: Encodable, Equatable {
            let id: String
            let name: String
            let state: String
            let value: String
            let fix: String?
            let act: Act?

            init(_ link: ReachWords.Link) {
                (id, name, value, fix) = (link.id, link.name, link.value, link.fix)
                act = link.act.map { Act(do: $0.rawValue, label: $0.label) }
                state = switch link.state {
                case .passed: "passed"
                case .failed: "failed"
                case .unchecked: "unchecked"
                }
            }

            private enum CodingKeys: String, CodingKey { case id, name, state, value, fix, act }

            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(id, forKey: .id)
                try container.encode(name, forKey: .name)
                try container.encode(state, forKey: .state)
                try container.encode(value, forKey: .value)
                try container.encode(fix, forKey: .fix)
                try container.encode(act, forKey: .act)
            }
        }

        init(_ snapshot: HomeLink.ReachSnapshot, clock: HomeClock, now: Date = Date()) {
            state = switch snapshot.reach {
            case .answering: "answering"
            case .waiting: "waiting"
            case .starting: "starting"
            case .unreachable: "unreachable"
            case .held: "held"
            case .needsUpdate: "update"
            case .passRefused: "refused"
            case .unpaired: "unpaired"
            }
            revision = snapshot.revision
            checking = snapshot.checking
            if let strip = ReachWords.strip(snapshot, device: .mac, clock: clock, now: now) {
                (tone, title, line, meta) = (strip.tone.rawValue, strip.title, strip.line, strip.meta)
                acts = strip.act.map { [Act(do: $0.do, label: $0.label)] } ?? []
            } else if let back = ReachWords.reached(snapshot, clock: clock, now: now) {
                (tone, title, line, meta, acts) = ("done", back.title, back.line, nil, [])
            } else {
                (tone, title, line, meta, acts) = (nil, nil, nil, nil, [])
            }
            let diagnosis = ReachWords.diagnosis(snapshot, device: .mac, clock: clock, now: now)
            last = diagnosis?.line
            path = diagnosis?.path.map(Link.init) ?? []
        }

        private enum CodingKeys: String, CodingKey { case state, revision, tone, title, line, meta, acts, last, path, checking }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(state, forKey: .state)
            try container.encode(revision, forKey: .revision)
            try container.encode(tone, forKey: .tone)
            try container.encode(title, forKey: .title)
            try container.encode(line, forKey: .line)
            try container.encode(meta, forKey: .meta)
            try container.encode(acts, forKey: .acts)
            try container.encode(last, forKey: .last)
            try container.encode(path, forKey: .path)
            try container.encode(checking, forKey: .checking)
        }
    }

    struct GrantRow: Encodable, Equatable {
        let id: String
        let title: String
        let why: String
        let granted: Bool
        let asking: Bool
        let denied: Bool
        let optional: Bool

        init(_ grant: Grant, granted: Bool, asking: Bool = false, denied: Bool = false) {
            id = grant.rawValue
            title = grant.title
            why = grant.why
            self.granted = granted
            self.asking = asking && !granted
            self.denied = denied && !granted && !asking
            optional = grant.optional
        }

        static func all(_ grants: [Grant: Bool], asking: [Grant], denied: Set<Grant>) -> [GrantRow] {
            let now = asking.first { grants[$0] != true }
            return grants.isEmpty ? [] : Grant.listed.map { GrantRow($0, granted: grants[$0] == true, asking: now == $0, denied: denied.contains($0)) }
        }
    }

    struct NeedRow: Encodable, Equatable {
        struct Act: Encodable, Equatable {
            let id: String
            let label: String
            let tone: String
        }

        let id: String
        let line: String
        let detail: String?
        let acts: [Act]
        let home: Bool

        init(_ need: Need, saved: Bool) {
            id = need.key
            home = need.home
            line = need.line
            detail = need.said(saved: saved)
            acts = need.acts.map { Act(id: $0.button.rawValue, label: $0.label, tone: "caution") }
        }
    }

    struct Pairing: Encodable, Equatable, Sendable {
        let code: String
        let link: String?
        let qr: String?
        let why: String?
        let match: String?
        let expiresMs: Int64

        init(_ made: PairingAnswer, qr: String?) {
            code = made.code
            link = made.link
            self.qr = made.link == nil ? nil : qr
            why = made.link == nil ? made.why : nil
            match = made.match
            expiresMs = made.expiresMs
        }

        private enum CodingKeys: String, CodingKey {
            case code, link, qr, why, match
            case expiresMs = "expires_ms"
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(code, forKey: .code)
            try container.encode(link, forKey: .link)
            try container.encode(qr, forKey: .qr)
            try container.encode(why, forKey: .why)
            try container.encodeIfPresent(match, forKey: .match)
            try container.encode(expiresMs, forKey: .expiresMs)
        }
    }

    struct PhoneApp: Encodable, Equatable, Sendable {
        static let link = "https://testflight.apple.com/join/wA1AwVHv"
        static let shown = PhoneApp(link: link, qr: QRImage.dataURL(link))

        let link: String
        let qr: String?
    }

    struct Vault: Encodable, Equatable {
        let state: String
        var savedMs: Int64? = nil
        var keyed = false

        static func of(_ vault: VaultState?, need: Need?) -> Vault? {
            guard let vault else { return nil }
            guard vault.keyID != nil else { return Vault(state: "none", keyed: vault.keyed) }
            let saved = vault.saved?.confirmedMs
            switch need {
            case .allow?, .homeLocked(allow: true)?: return Vault(state: "locked", savedMs: saved, keyed: vault.keyed)
            case .unlock?, .homeLocked(allow: false)?: return Vault(state: "lost", savedMs: saved, keyed: vault.keyed)
            default: return Vault(state: vault.recovery == .confirmed ? "saved" : "unsaved", savedMs: saved, keyed: vault.keyed)
            }
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(state, forKey: .state)
            try container.encode(savedMs, forKey: .savedMs)
            if keyed { try container.encode(true, forKey: .keyed) }
        }

        private enum CodingKeys: String, CodingKey {
            case state, keyed
            case savedMs = "saved_ms"
        }
    }

    struct Apps: Encodable, Equatable {
        struct App: Encodable, Equatable {
            let id: String
            let name: String
            let icon: String
            let suggested: Bool
        }

        let offered: [App]
        let privateWindows: Bool

        static let passwordManagers = RecordingModes.passwordManagers

        static func of(apps installed: [Detection.App], named: [String],
                       language: String = Locale.preferredLanguages.first ?? "en") -> Apps {
            let names = Dictionary(installed.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
            let icons = Dictionary(installed.map { ($0.id, $0.icon) }, uniquingKeysWith: { first, _ in first })
            let byName = { (lhs: String, rhs: String) in names[lhs, default: lhs].localizedStandardCompare(names[rhs, default: rhs]) == .orderedAscending }
            let field = Set(named).subtracting(passwordManagers).sorted(by: byName)
            let others = installed.map(\.id).sorted(by: byName)
            var seen: Set<String> = [RecordingModes.ownApp]
            let ids = (passwordManagers + field + others).filter { seen.insert($0).inserted }
            let browsers = installed.compactMap { Browsers.profile($0.id) }
            return Apps(offered: ids.compactMap { id in names[id].map { App(id: id, name: $0, icon: icons[id, default: ""],
                                                                                  suggested: passwordManagers.contains(id)) } },
                        privateWindows: language.hasPrefix("en") && browsers.allSatisfy { $0.privateSignal != nil })
        }

        private enum CodingKeys: String, CodingKey {
            case offered
            case privateWindows = "private_windows"
        }
    }

    struct Found: Equatable {
        let browsers: [Detection.Browser]
        var apps: [Detection.App] = []
    }

    var inset: Inset?
    var recorder: Line
    var reach: Reach?
    var sending: String?
    var grants: [GrantRow] = []
    var needs: [NeedRow] = []
    var update: NeedRow?
    var folder: String?
    var signins: [String]?
    var browsers: [Detection.Browser]?
    var pairing: Pairing?
    var phoneApp: PhoneApp?
    var askLogin: AskLogin?
    var connectRequests: [ConnectRequest]?
    var agentRequests: [HomeLink.SignIn] = []
    var agentAsks: [HomeLink.AgentAsk] = []
    var unit: String?
    var apps: Apps?
    var placement: SetupHost.Placement?
    var machine: SetupHost.Machine?
    var accountName: String?
    var setup: SetupHost.Setup?
    var vault: Vault?
    var general: General.State?
    var backups: BackupList?
    init(recorder: RecorderPresentation) {
        self.recorder = Line(signal: recorder.signal.rawValue, words: recorder.label)
    }

    private enum CodingKeys: String, CodingKey {
        case inset, recorder, reach, sending, grants, needs, update, folder, signins, browsers, pairing, unit, apps, placement, machine, setup, vault
        case general, backups
        case askLogin = "ask_login"
        case connectRequests = "connect_requests"
        case agentRequests = "agent_requests"
        case agentAsks = "agent_asks"
        case phoneApp = "phone_app"
        case accountName = "account_name"
    }
}

struct AskLogin: Codable, Equatable, Sendable {
    struct Subscription: Codable, Equatable, Sendable {
        enum State: String, Codable, Sendable {
            case absent, fetching
            case signedOut = "signed_out", signingIn = "signing_in", signedIn = "signed_in"
            case failed
        }

        let state: State
        var bytes: Int64? = nil
        var total: Int64? = nil
        var attempt: String? = nil
        var url: String? = nil
        var code: String? = nil
        var account: String? = nil
        var plan: String? = nil
        var why: String? = nil

        var underWay: Bool { state == .fetching || state == .signingIn }
    }

    let chatgpt: Subscription
    let claude: Subscription

    subscript(of: HostAct.Subscription) -> Subscription {
        switch of {
        case .chatgpt: chatgpt
        case .claude: claude
        }
    }

    var underWay: [HostAct.Subscription] { HostAct.Subscription.allCases.filter { self[$0].underWay } }

    func forgetting(_ cancelled: Set<HostAct.Subscription>) -> AskLogin {
        func kept(_ subscription: Subscription, _ of: HostAct.Subscription) -> Subscription {
            guard cancelled.contains(of) else { return subscription }
            if subscription.state == .signingIn { return Subscription(state: .signedOut) }
            var forgotten = subscription
            forgotten.attempt = nil
            forgotten.url = nil
            forgotten.code = nil
            return forgotten
        }
        return AskLogin(chatgpt: kept(chatgpt, .chatgpt), claude: kept(claude, .claude))
    }
}

struct ConnectRequest: Codable, Equatable, Sendable {
    let id: String
    let browser: String
}

enum QRImage {
    static let module: CGFloat = 8
    static let quiet: CGFloat = 4

    static func dataURL(_ text: String) -> String? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let code = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: module, y: module)) else { return nil }
        let ground = CIImage(color: .white).cropped(to: code.extent.insetBy(dx: -quiet * module, dy: -quiet * module))
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let png = CIContext().pngRepresentation(of: code.composited(over: ground), format: .RGBA8, colorSpace: space) else { return nil }
        return "data:image/png;base64," + png.base64EncodedString()
    }
}

@MainActor final class AskLoginLine {
    private var last: [HostAct.Subscription: Task<Void, Never>] = [:]

    func queue(_ of: HostAct.Subscription, _ act: @escaping @Sendable () async throws -> AskLogin) -> Task<AskLogin, Error> {
        let before = last[of]
        let mine = Task { () async throws -> AskLogin in
            await before?.value
            return try await act()
        }
        last[of] = Task { _ = try? await mine.value }
        return mine
    }
}

@MainActor final class StatusLines: ObservableObject {
    @Published var recorder: RecorderPresentation
    @Published var shipper: ShipperStatus?
    @Published var reach: HomeLink.ReachSnapshot?

    init(recorder: RecorderPresentation) {
        self.recorder = recorder
    }
}

struct AskLoginDoor: Sendable {
    let read: @Sendable () async throws -> AskLogin
    let post: @Sendable (HostAct.AskLoginAct) async throws -> AskLogin
    let line: AskLoginLine

    @MainActor static func live(_ link: @escaping @Sendable () throws -> HomeLink) -> AskLoginDoor {
        AskLoginDoor(read: { try decode(try await link().askLogin()) },
                     post: { act in try decode(try await link().askLogin(try act.body())) },
                     line: AskLoginLine())
    }

    @MainActor func queue(_ act: HostAct.AskLoginAct) -> Task<AskLogin, Error> {
        let post = post
        return line.queue(act.subscription) { try await post(act) }
    }

    @MainActor func send(_ act: HostAct.AskLoginAct) async throws -> AskLogin {
        try await queue(act).value
    }

    static func decode(_ body: Data) throws -> AskLogin {
        guard let login = try? JSONDecoder().decode(AskLogin.self, from: body) else { throw LinkFailure.unreadable(200) }
        return login
    }
}
