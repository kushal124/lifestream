import Foundation

public enum ReachWords {
    public enum Tone: String, Sendable, Equatable {
        case warning, caution, waiting
    }

    public struct Act: Sendable, Equatable {
        public let `do`: String
        public let label: String

        public init(do: String, label: String) {
            self.do = `do`
            self.label = label
        }

        public static let tryAgain = Act(do: "probe", label: "Try again")
        public static let startLifestream = Act(do: "open", label: "Start Lifestream")
    }

    public struct Strip: Sendable, Equatable {
        public let tone: Tone
        public let title: String
        public let line: String?
        public let meta: String?
        public let act: Act?

        public init(tone: Tone, title: String, line: String?, meta: String?, act: Act?) {
            self.tone = tone
            self.title = title
            self.line = line
            self.meta = meta
            self.act = act
        }
    }

    public static let title = "Can't reach Lifestream"
    public static let notRunning = "Lifestream isn't running"
    public static let driveAway = "Lifestream's drive isn't connected"
    public static let notSent = "Not sent"
    public static let waiting = "Waiting for Lifestream."
    public static let saving = "Still saving to Lifestream"
    public static let unknown = "Lifestream didn't say whether this was saved."
    public static let unknownDone = "Lifestream didn't say whether this was done."
    public static let refused = "Lifestream didn't take this."
    public static let reachedFor: TimeInterval = 3

    public static func name(_ device: HomeLink.Kind) -> String {
        switch device {
        case .phone: "iPhone"
        case .mac: "Mac"
        }
    }

    public static func strip(_ snapshot: HomeLink.ReachSnapshot, device: HomeLink.Kind, clock: HomeClock,
                             now: Date = Date()) -> Strip? {
        let meta = snapshot.lastReached.map { since($0, clock: clock, now: now) }
        let named = name(device)
        var reach = snapshot.reach
        if case .waiting = reach, let shown = snapshot.episode?.shown, snapshot.episode?.ended == nil { reach = shown }
        switch reach {
        case .answering, .waiting:
            return nil
        case .unreachable(.driveAway, _):
            return Strip(tone: .warning, title: driveAway, line: "Connect its drive and it starts again", meta: meta,
                         act: device == .phone ? .tryAgain : nil)
        case .unreachable(.notRunning, _) where device == .mac && snapshot.routes?.here == true:
            return Strip(tone: .warning, title: notRunning, line: "Nothing is read or saved", meta: meta, act: .startLifestream)
        case .unreachable(let cause, _):
            let act: Act? = switch device {
            case .phone: .tryAgain
            case .mac: diagnosis(snapshot, device: device)?.path.contains { $0.failed && $0.act == .open } == true ? .startLifestream : nil
            }
            return Strip(tone: .warning, title: title, line: line(cause, device: device), meta: meta, act: act)
        case .held(let held):
            return Strip(tone: .warning, title: held.title, line: held.detail, meta: meta,
                         act: held.acts.first.map { Act(do: $0.do.rawValue, label: $0.label) })
        case .starting(let said, _):
            return Strip(tone: .waiting, title: said.title, line: said.line, meta: nil, act: nil)
        case .needsUpdate(.home):
            return Strip(tone: .caution, title: "Lifestream needs an update", line: "Update it on your Mac", meta: nil, act: nil)
        case .needsUpdate(.device):
            return Strip(tone: .caution, title: "Update Lifestream on this \(named)", line: "What it records waits here", meta: nil, act: nil)
        case .passRefused:
            return Strip(tone: .caution, title: "Lifestream no longer knows this \(named)", line: "Pair it again to send",
                         meta: nil, act: Act(do: "pair", label: "Pair again"))
        case .unpaired:
            guard device == .mac else { return nil }
            return Strip(tone: .caution, title: "This Mac isn't paired", line: "Pair it to send what it records", meta: nil, act: nil)
        }
    }

    public static func reached(_ snapshot: HomeLink.ReachSnapshot, clock: HomeClock, now: Date = Date()) -> (title: String, line: String?)? {
        guard snapshot.reach == .answering, let episode = snapshot.episode, episode.showedStrip, let ended = episode.ended,
              now.timeIntervalSince(ended) < reachedFor else { return nil }
        return back
    }

    public static let back: (title: String, line: String?) = ("Lifestream is back", nil)

    public static func line(_ cause: HomeLink.Cause, device: HomeLink.Kind) -> String {
        switch cause {
        case .offline: return "This \(name(device)) is offline"
        case .tailscaleOff: return "Tailscale is off"
        case .wifiOnly: return "Not on your Mac's Wi\u{2011}Fi"
        case .notRunning: return device == .mac ? "Lifestream isn't running on its Mac" : "Lifestream isn't running on your Mac"
        case .driveAway: return driveAway
        case .local(let words): return words
        case .silent: return device == .mac ? "Lifestream isn't answering" : "Your Mac isn't answering"
        }
    }

    public struct Link: Sendable, Equatable {
        public enum State: Sendable, Equatable { case passed, failed, unchecked }

        public let id: String
        public let name: String
        public let state: State
        public let value: String
        public let fix: String?
        public let act: LinkAct?

        public init(id: String, name: String, state: State, value: String, fix: String? = nil, act: LinkAct? = nil) {
            self.id = id
            self.name = name
            self.state = state
            self.value = value
            self.fix = fix
            self.act = act
        }

        public var failed: Bool { state == .failed }
    }

    public enum LinkAct: String, Sendable, Equatable {
        case open, tailscale

        public var label: String { "Open" }
    }

    public static func diagnosis(_ snapshot: HomeLink.ReachSnapshot, device: HomeLink.Kind, clock: HomeClock? = nil,
                                 now: Date = Date()) -> (title: String, line: String?, path: [Link])? {
        guard case .unreachable(let cause, _) = snapshot.reach else { return nil }
        let last = clock.flatMap { clock in snapshot.lastReached.map { lastReached($0, clock: clock, now: now) } }
        let routes = snapshot.routes ?? HomeLink.Routes(online: nil, local: nil, tailscale: nil)
        let path = routes.here ? here(cause) : away(cause, routes: routes, device: device)
        return (title, last, path)
    }

    private static func unchecked(_ id: String, _ name: String) -> Link {
        Link(id: id, name: name, state: .unchecked, value: "Not checked")
    }

    private static func here(_ cause: HomeLink.Cause) -> [Link] {
        let lifestream = "Lifestream on this Mac", drive = "Lifestream's drive", home = "Lifestream"
        let running = Link(id: "lifestream", name: lifestream, state: .passed, value: "Running")
        let connected = Link(id: "drive", name: drive, state: .passed, value: "Connected")
        switch cause {
        case .notRunning:
            return [Link(id: "lifestream", name: lifestream, state: .failed, value: "Not running", fix: "Open it, and Lifestream starts again", act: .open),
                    connected, unchecked("home", home)]
        case .local(let words):
            return [Link(id: "lifestream", name: lifestream, state: .failed, value: "Stopped", fix: words, act: .open),
                    connected, unchecked("home", home)]
        case .driveAway:
            return [running,
                    Link(id: "drive", name: drive, state: .failed, value: "Not connected", fix: "Connect it, and Lifestream starts again"),
                    Link(id: "home", name: home, state: .unchecked, value: "Waits for its drive")]
        case .silent, .offline, .tailscaleOff, .wifiOnly:
            return [running, connected,
                    Link(id: "home", name: home, state: .failed, value: "Not answering", fix: "Lifestream asks it again on its own")]
        }
    }

    private static func away(_ cause: HomeLink.Cause, routes: HomeLink.Routes, device: HomeLink.Kind) -> [Link] {
        let named = name(device), phone = device == .phone
        var links: [Link] = []
        let end = phone ? (id: "mac", name: "Your Mac") : (id: "home", name: "Lifestream")
        let wifi = phone ? "Your Mac's Wi\u{2011}Fi" : "Lifestream's Wi\u{2011}Fi"
        let tailscale = "Tailscale on this \(named)"
        if cause == .offline {
            links.append(Link(id: "online", name: "This \(named) online", state: .failed, value: "Offline",
                              fix: "Lifestream is read again once it's back online"))
            if routes.local != nil { links.append(unchecked("wifi", wifi)) }
            if routes.tailscale != nil { links.append(unchecked("tailscale", tailscale)) }
            return links + [unchecked(end.id, end.name)]
        }
        links.append(routes.online == true ? Link(id: "online", name: "This \(named) online", state: .passed, value: "Connected")
                     : unchecked("online", "This \(named) online"))
        switch routes.local {
        case true?: links.append(Link(id: "wifi", name: wifi, state: .passed, value: "On it"))
        case false? where cause == .wifiOnly:
            links.append(Link(id: "wifi", name: wifi, state: .failed, value: "Not on it",
                              fix: "Lifestream answers only there. Join it, or set up Tailscale on both"))
        case false?: links.append(Link(id: "wifi", name: wifi, state: .unchecked, value: "Not on it"))
        case nil: break
        }
        switch routes.tailscale {
        case true?: links.append(Link(id: "tailscale", name: tailscale, state: .passed, value: "On"))
        case false? where cause == .tailscaleOff:
            links.append(Link(id: "tailscale", name: tailscale, state: .failed, value: "Off",
                              fix: phone ? "Turn it on, or join your Mac's Wi\u{2011}Fi" : "Turn it on, or join the Wi\u{2011}Fi of the Mac Lifestream runs on",
                              act: phone ? .tailscale : nil))
        case false?: links.append(Link(id: "tailscale", name: tailscale, state: .unchecked, value: "Off"))
        case nil: break
        }
        switch cause {
        case .silent, .notRunning, .driveAway:
            links.append(Link(id: end.id, name: end.name, state: .failed, value: "Not answering",
                              fix: phone ? "Check that it's awake, on the same Wi\u{2011}Fi or on Tailscale"
                                  : "Check that the Mac it runs on is awake, on the same Wi\u{2011}Fi or on Tailscale"))
        case .local(let words):
            links.append(Link(id: end.id, name: end.name, state: .failed, value: "Not answering", fix: words))
        case .offline, .tailscaleOff, .wifiOnly:
            links.append(unchecked(end.id, end.name))
        }
        return links
    }

    static func fix(_ cause: HomeLink.Cause, device: HomeLink.Kind) -> String? {
        switch cause {
        case .offline: "Lifestream is read again once it's back online."
        case .tailscaleOff: "Turn it on in the Tailscale app, or join your Mac's Wi\u{2011}Fi."
        case .wifiOnly: "Lifestream answers only on your Mac's Wi\u{2011}Fi. Join it, or set up Tailscale on both to reach it from anywhere."
        case .silent where device == .phone: "Check that your Mac is awake, on the same Wi\u{2011}Fi or on Tailscale."
        case .silent, .notRunning, .driveAway, .local: nil
        }
    }

    public static func pairing(_ cause: HomeLink.Cause) -> (title: String, fix: String) {
        switch cause {
        case .offline:
            (line(cause, device: .phone), "Join your Mac's Wi\u{2011}Fi, then try again.")
        case .tailscaleOff:
            (line(cause, device: .phone), fix(cause, device: .phone) ?? "")
        case .wifiOnly:
            (line(cause, device: .phone),
             "Your Mac answers only on its Wi\u{2011}Fi. Join it, or set up Tailscale on both to reach it from anywhere.")
        // external: macOS's firewall asks whether the door may take connections; until the person allows it, the Mac is silent on the Wi-Fi.
        case .silent, .notRunning, .driveAway, .local:
            ("Can't reach your Mac",
             "Check that your Mac is awake, and that this iPhone is on the same Wi\u{2011}Fi, or that both are on Tailscale.")
        }
    }

    public static func menuLine(_ snapshot: HomeLink.ReachSnapshot, clock: HomeClock, now: Date = Date()) -> String? {
        guard let strip = strip(snapshot, device: .mac, clock: clock, now: now) else { return nil }
        guard case .unreachable = snapshot.reach else { return strip.title }
        return [strip.title == title ? strip.line : strip.title, strip.meta].compactMap { $0 }.joined(separator: " · ")
    }

    public static func notification(_ reach: HomeLink.Reach, device: HomeLink.Kind) -> (title: String, body: String)? {
        switch reach {
        case .unreachable(let cause, _): (title, line(cause, device: device))
        case .held(let held): (held.title, held.detail)
        default: nil
        }
    }

    public static func stale(lastReached: Date, clock: HomeClock, now: Date = Date()) -> String {
        "\(title) \(since(lastReached, clock: clock, now: now)) · What this iPhone records waits on it"
    }

    public static func since(_ at: Date, clock: HomeClock, now: Date = Date()) -> String {
        let day = clock.dayAt(at)
        guard day.day != clock.dayAt(now).day else { return "since " + format(at, "HH:mm", in: day.zone) }
        return "since " + format(at, "EEE d MMM", in: day.zone)
    }

    public static func lastReached(_ at: Date, clock: HomeClock, now: Date = Date()) -> String {
        let day = clock.dayAt(at)
        let time = format(at, "HH:mm", in: day.zone)
        guard day.day != clock.dayAt(now).day else { return "Last reached " + time }
        return "Last reached " + format(at, "EEE d MMM", in: day.zone) + " · " + time
    }

    public static func act(_ state: HomeLink.RequestState) -> HomeLink.ActSaid? {
        switch state {
        case .inFlight: nil
        case .reach, .failed: .notSent
        case .wait(let words, _), .refused(let words): .refused(words)
        case .saving: .saving
        case .unknown(let words): .unknown(words)
        }
    }

    public static func unanswered(again: Bool, began: Bool) -> String {
        again ? began ? saving : unknown : unknownDone
    }

    public static func door(_ code: String) -> String? {
        switch code {
        case "ASK_DOWN": "Chat isn't answering on your Mac"
        case "DISK_LOW": diskLow
        default: nil
        }
    }

    private static let diskLow = "Waiting for space on Lifestream's disk"

    public static func sending(_ outcome: String, device: HomeLink.Kind, long: Bool = false) -> String? {
        let named = name(device)
        switch (outcome, device) {
        case ("shipped", .phone): return "Received by Lifestream."
        case ("nothing_new", .phone): return "Nothing new to send."
        case ("Nothing sent yet", .phone): return "Nothing sent yet."
        case ("uploading", .phone): return "Sending."
        case ("no_home", .phone): return "Pair with Lifestream to start sending."
        case ("handed_over", .phone): return "This install was replaced. Everything it held is in Lifestream. You can delete this app."
        case ("shipped", _), ("nothing_new", _), ("nothing_due", _), ("busy", _), ("waiting", _), ("unreachable", _), ("no_home", _):
            return nil
        case _ where outcome.hasPrefix("stale"):
            return nil
        case _ where outcome.hasPrefix("conflict"):
            return "Lifestream didn't take what this \(named) sent. Lifestream sends it again at the next sync."
        default:
            break
        }
        let held = outcome.hasPrefix("held "), refused = outcome.hasPrefix("refused ")
        let code = held ? String(outcome.dropFirst(5)) : refused ? String(outcome.dropFirst(8)) : outcome
        switch (code, device) {
        case ("FULL_DISK_ACCESS", _), ("ON_BATTERY", _), ("HISTORY", _), ("UPLOAD_ACTIVE", _), ("HOME_TOO_OLD", _),
             ("DEVICE_TOO_OLD", _), ("PRINCIPAL_UNKNOWN", _), ("DISK_FULL", _):
            return nil
        case ("DISK_LOW", _): return diskLow
        case ("CLOCK_AHEAD", .phone):
            return "This iPhone's clock is ahead of Lifestream's. Set Date & Time to automatic, and this iPhone sends again."
        case ("CLOCK_AHEAD", .mac): return "This Mac's clock is ahead of Lifestream's. Set the time automatically in System Settings."
        case ("PRINCIPAL_SCOPE", _): return "Lifestream doesn't let this \(named) send that. Pair it again."
        case ("BUNDLE_TOO_LARGE", _): return "Something this \(named) recorded was too large for Lifestream. The rest still syncs."
        case ("local_storage", .phone) where long:
            return "This iPhone hasn't been able to send for over an hour. Lifestream shows the problem."
        case ("local_storage", .phone): return "This iPhone couldn't finish sending. It tries again at its next wake."
        case ("LOCAL_STORAGE", .mac): return "This Mac couldn't read what it recorded. Check that its disk has space."
        case ("LOCAL_ACCESS", .mac): return "This Mac couldn't read one of its apps. Lifestream tries again at the next sync."
        case (_, .phone) where held && long:
            return "Lifestream has refused what this iPhone sends for over an hour. It shows the problem."
        case (_, .phone) where held:
            return "Lifestream held back the last send. This iPhone sends it again within the hour."
        case (_, .phone) where refused:
            return "Lifestream didn't accept this iPhone's last request. This iPhone asks again on its own."
        default:
            return "Lifestream didn't take what this \(named) sent"
        }
    }

    private static func format(_ date: Date, _ pattern: String, in zone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_GB")
        formatter.timeZone = zone
        formatter.dateFormat = pattern
        return formatter.string(from: date)
    }
}
