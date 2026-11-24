import Evidence
import Foundation

enum InputEventCodecError: Error, Equatable, CustomStringConvertible {
    case unrepresentableNumber(String)
    case notAnObject
    case members(String)
    case instant(String)
    case unknownEvent(String)
    case value(String)
    case appIndex(Int)
    case siteIndex(Int)

    var description: String {
        switch self {
        case .unrepresentableNumber(let key): return "\(key) is not a finite number"
        case .notAnObject: return "an input line is one JSON object"
        case .members(let detail): return "input members: \(detail)"
        case .instant(let value): return "\(value) is not an RFC 3339 UTC instant with milliseconds"
        case .unknownEvent(let name): return "\(name) is not an input event name"
        case .value(let key): return "\(key) has the wrong type or spelling"
        case .appIndex(let index): return "app index \(index) is outside apps"
        case .siteIndex(let index): return "site index \(index) is outside sites"
        }
    }
}

enum InputEventCodec {

    static func line(_ chunk: InputChunk) throws -> String {
        var out = "{\"at\":\(quoted(UTCInstant.rfc3339(chunk.at)))"
        out += ",\"until\":\(quoted(UTCInstant.rfc3339(chunk.until)))"
        out += ",\"layout\":\(quoted(chunk.layout))"
        out += ",\"apps\":[\(chunk.apps.map(quoted).joined(separator: ","))]"
        if !chunk.sites.isEmpty { out += ",\"sites\":[\(chunk.sites.map(quoted).joined(separator: ","))]" }
        out += ",\"events\":[\(try chunk.events.map(line).joined(separator: ","))]"
        if !chunk.activity.isEmpty {
            out += ",\"activity\":[\(chunk.activity.sorted(by: InputActivity.order).map(line).joined(separator: ","))]"
        }
        if chunk.lost > 0 { out += ",\"lost\":\(chunk.lost)" }
        if chunk.recovered { out += ",\"recovered\":true" }
        return out + "}"
    }

    static func line(_ activity: InputActivity) -> String {
        let site = activity.site.map { ",\"site\":\($0)" } ?? ""
        return "{\"app\":\(activity.app)\(site),\"keys\":\(activity.keys),\"clicks\":\(activity.clicks)," +
            "\"scrolls\":\(activity.scrolls),\"moves\":\(activity.moves)}"
    }

    static func line(_ event: InputEvent) throws -> String {
        var members = Members()
        members.integer("t", event.t)
        members.text("e", event.body.name.rawValue)
        switch event.body {
        case .keyDown(let key):
            members.integer("code", key.code)
            members.text("key", key.key)
            members.text("name", key.name)
            members.mods(key.mods)
            if key.isRepeat { members.flag("repeat", true) }
            members.text("hidden", key.hidden?.rawValue)
            members.integer("app", key.app)
            members.integer("site", event.site)
            members.integer("syn", key.syn)
            members.element(key.el)
        case .keyUp(let code, let app, let syn):
            members.integer("code", code)
            members.integer("app", app)
            members.integer("site", event.site)
            members.integer("syn", syn)
        case .flags(let code, let mods):
            members.integer("code", code)
            members.mods(mods)
        case .down(let pointer), .up(let pointer):
            members.text("button", pointer.button.spelling)
            try members.tenths("x", pointer.x)
            try members.tenths("y", pointer.y)
            members.integer("clicks", pointer.clicks)
            members.mods(pointer.mods)
            members.integer("app", pointer.app)
            members.integer("site", event.site)
            members.integer("syn", pointer.syn)
            members.element(pointer.el)
        case .move(let move):
            try members.tenths("x", move.x)
            try members.tenths("y", move.y)
            members.text("drag", move.drag?.spelling)
            members.integer("app", move.app)
            members.integer("site", event.site)
            members.integer("syn", move.syn)
        case .scroll(let scroll):
            try members.tenths("x", scroll.x)
            try members.tenths("y", scroll.y)
            try members.tenths("dx", scroll.dx)
            try members.tenths("dy", scroll.dy)
            if scroll.lines { members.flag("lines", true) }
            members.text("phase", scroll.phase?.rawValue)
            members.integer("app", scroll.app)
            members.integer("site", event.site)
            members.integer("syn", scroll.syn)
        case .activate(let app, let pid):
            members.integer("app", app)
            members.integer("site", event.site)
            members.integer("pid", pid)
        case .logStart(let inputMonitoring, let accessibility):
            members.flag("input_monitoring", inputMonitoring)
            members.flag("accessibility", accessibility)
        case .logStop:
            break
        case .secureInput(let on), .locked(let on):
            members.flag("on", on)
        case .tapRestart(let reason):
            members.text("reason", reason.rawValue)
        case .layout(let id):
            members.text("id", id)
        case .siteUnknown(let on):
            members.flag("on", on)
        }
        return members.object
    }

    private struct Members {
        private var out = "{"
        private var first = true

        init() {
            out.reserveCapacity(160)
        }

        var object: String { out + "}" }

        private mutating func key(_ key: String) {
            if !first { out += "," }
            first = false
            out += "\""
            out += key
            out += "\":"
        }

        mutating func text(_ key: String, _ value: String?) {
            guard let value else { return }
            self.key(key)
            InputEventCodec.appendQuoted(value, to: &out)
        }

        mutating func integer(_ key: String, _ value: Int?) {
            guard let value else { return }
            self.key(key)
            out += String(value)
        }

        mutating func flag(_ key: String, _ value: Bool) {
            self.key(key)
            out += value ? "true" : "false"
        }

        mutating func tenths(_ key: String, _ value: Double) throws {
            let spelled = try InputEventCodec.tenths(value, key)
            self.key(key)
            out += spelled
        }

        mutating func mods(_ mods: [InputModifier]) {
            guard !mods.isEmpty else { return }
            key("mods")
            out += "["
            for (index, mod) in mods.sorted().enumerated() {
                if index > 0 { out += "," }
                InputEventCodec.appendQuoted(mod.rawValue, to: &out)
            }
            out += "]"
        }

        mutating func element(_ element: InputElement?) {
            guard let element else { return }
            key("el")
            out += InputEventCodec.object(element)
        }
    }

    private static func object(_ element: InputElement) -> String {
        var members: [(String, String)] = attributeMembers(element.attributes)
        if let action = element.action { members.append(("action", object(action))) }
        if let err = element.err { members.append(("err", quoted(err.spelling))) }
        if let ms = element.ms { members.append(("ms", String(ms))) }
        return "{\(members.sorted { $0.0 < $1.0 }.map { "\(quoted($0.0)):\($0.1)" }.joined(separator: ","))}"
    }

    private static func object(_ attributes: InputElementAttributes) -> String {
        let members = attributeMembers(attributes).sorted { $0.0 < $1.0 }
        return "{\(members.map { "\(quoted($0.0)):\($0.1)" }.joined(separator: ","))}"
    }

    private static func attributeMembers(_ attributes: InputElementAttributes) -> [(String, String)] {
        let pairs: [(String, String?)] = [
            ("role", attributes.role), ("subrole", attributes.subrole), ("title", attributes.title),
            ("desc", attributes.desc), ("id", attributes.id), ("url", attributes.url), ("value", attributes.value),
        ]
        return pairs.compactMap { key, value in value.map { (key, quoted($0)) } }
    }

    static func tenths(_ value: Double, _ key: String = "value") throws -> String {
        guard value.isFinite, abs(value) < 1e15 else { throw InputEventCodecError.unrepresentableNumber(key) }
        let scaled = Int64((value * 10).rounded())
        let sign = scaled < 0 ? "-" : ""
        let magnitude = scaled.magnitude
        return magnitude % 10 == 0 ? "\(sign)\(magnitude / 10)" : "\(sign)\(magnitude / 10).\(magnitude % 10)"
    }

    static func roundedToTenth(_ value: Double) -> Double {
        guard value.isFinite else { return 0 }
        let rounded = (value * 10).rounded() / 10
        return rounded == 0 ? 0 : rounded
    }

    static func quoted(_ text: String) -> String {
        var out = ""
        appendQuoted(text, to: &out)
        return out
    }

    static func appendQuoted(_ text: String, to out: inout String) {
        out += "\""
        guard text.utf8.contains(where: { $0 < 0x20 || $0 == 0x22 || $0 == 0x5C }) else {
            out += text
            out += "\""
            return
        }
        for character in text.unicodeScalars {
            switch character {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if character.value < 0x20 {
                    out += String(format: "\\u%04x", character.value)
                } else {
                    out.unicodeScalars.append(character)
                }
            }
        }
        out += "\""
    }


    private static let chunkMembers: Set<String> = ["at", "until", "layout", "apps", "sites", "events", "activity",
                                                    "lost", "recovered"]
    static let activityMembers: Set<String> = ["app", "keys", "clicks", "scrolls", "moves"]

    static func chunk(_ line: String) throws -> InputChunk {
        let object = try jsonObject(line)
        guard Set(object.keys).isSubset(of: chunkMembers) else {
            throw InputEventCodecError.members("a chunk has only \(chunkMembers.sorted().joined(separator: ", "))")
        }
        let at = try instant(object["at"])
        let until = try instant(object["until"])
        guard let layout = object["layout"] as? String else { throw InputEventCodecError.value("layout") }
        guard let apps = object["apps"] as? [Any], let names = apps as? [String] else {
            throw InputEventCodecError.value("apps")
        }
        var sites: [String] = []
        if let value = object["sites"] {
            guard let hosts = value as? [String], !hosts.isEmpty, Set(hosts).count == hosts.count,
                  hosts.allSatisfy(RecordingModes.isValidSite) else { throw InputEventCodecError.value("sites") }
            sites = hosts
        }
        guard let rawEvents = object["events"] as? [Any] else { throw InputEventCodecError.value("events") }
        var events: [InputEvent] = []
        for raw in rawEvents {
            guard let member = raw as? [String: Any] else { throw InputEventCodecError.notAnObject }
            let event = try event(member)
            for index in event.body.appIndices where !names.indices.contains(index) {
                throw InputEventCodecError.appIndex(index)
            }
            if let site = event.site, !sites.indices.contains(site) { throw InputEventCodecError.siteIndex(site) }
            events.append(event)
        }
        var activity: [InputActivity] = []
        if let value = object["activity"] {
            guard let entries = value as? [Any], !entries.isEmpty else { throw InputEventCodecError.value("activity") }
            for entry in entries {
                guard let member = entry as? [String: Any] else { throw InputEventCodecError.value("activity") }
                let counted = try self.activity(member)
                guard names.indices.contains(counted.app) else { throw InputEventCodecError.appIndex(counted.app) }
                if let site = counted.site, !sites.indices.contains(site) { throw InputEventCodecError.siteIndex(site) }
                if let previous = activity.last, !InputActivity.order(previous, counted) {
                    throw InputEventCodecError.value("activity")
                }
                activity.append(counted)
            }
        }
        var lost = 0
        if let value = object["lost"] {
            lost = try integer(value, "lost")
            guard lost > 0 else { throw InputEventCodecError.value("lost") }
        }
        var recovered = false
        if let value = object["recovered"] {
            guard try flag(value, "recovered") else { throw InputEventCodecError.value("recovered") }
            recovered = true
        }
        return InputChunk(at: at, until: until, layout: layout, apps: names, sites: sites, events: events,
                          activity: activity, lost: lost, recovered: recovered)
    }

    static func activity(_ object: [String: Any]) throws -> InputActivity {
        guard Set(object.keys).subtracting(["site"]) == activityMembers else {
            throw InputEventCodecError.members("an activity entry is exactly app, site, keys, clicks, scrolls, moves")
        }
        var site: Int?
        if let value = object["site"] {
            site = try integer(value, "site")
            guard site ?? -1 >= 0 else { throw InputEventCodecError.value("site") }
        }
        let counted = InputActivity(app: try integer(object["app"], "app"), site: site,
                                    keys: try integer(object["keys"], "keys"),
                                    clicks: try integer(object["clicks"], "clicks"),
                                    scrolls: try integer(object["scrolls"], "scrolls"),
                                    moves: try integer(object["moves"], "moves"))
        guard counted.app >= 0, counted.keys >= 0, counted.clicks >= 0, counted.scrolls >= 0, counted.moves >= 0,
              counted.keys + counted.clicks + counted.scrolls + counted.moves > 0 else {
            throw InputEventCodecError.value("activity")
        }
        return counted
    }

    static func event(_ line: String) throws -> InputEvent {
        try event(try jsonObject(line))
    }

    static let members: [InputEventName: [String]] = [
        .keyDown: ["code", "key", "name", "mods", "repeat", "hidden", "app", "site", "syn", "el"],
        .keyUp: ["code", "app", "site", "syn"],
        .flags: ["code", "mods"],
        .down: ["button", "x", "y", "clicks", "mods", "app", "site", "syn", "el"],
        .up: ["button", "x", "y", "clicks", "mods", "app", "site", "syn"],
        .move: ["x", "y", "drag", "app", "site", "syn"],
        .scroll: ["x", "y", "dx", "dy", "lines", "phase", "app", "site", "syn"],
        .activate: ["app", "site", "pid"],
        .logStart: ["input_monitoring", "accessibility"],
        .logStop: [],
        .secureInput: ["on"],
        .locked: ["on"],
        .tapRestart: ["reason"],
        .layout: ["id"],
        .siteUnknown: ["on"],
    ]

    private static func event(_ object: [String: Any]) throws -> InputEvent {
        guard let spelling = object["e"] as? String, let name = InputEventName(rawValue: spelling) else {
            throw InputEventCodecError.unknownEvent(String(describing: object["e"] ?? ""))
        }
        let allowed = Set(["t", "e"] + (members[name] ?? []))
        guard Set(object.keys).isSubset(of: allowed) else {
            throw InputEventCodecError.members("\(spelling) carries only \(allowed.sorted().joined(separator: ", "))")
        }
        let t = try integer(object["t"], "t")
        guard t >= 0 else { throw InputEventCodecError.value("t") }
        let read = Reader(object: object)
        let body: InputEventBody
        switch name {
        case .keyDown:
            let key = InputKeyDown(
                code: try read.optionalInteger("code"), key: try read.optionalText("key"),
                name: try read.optionalText("name"), mods: try read.mods(),
                isRepeat: try read.trueFlag("repeat"),
                hidden: try read.optionalText("hidden").map {
                    guard let reason = InputHiddenReason(rawValue: $0) else { throw InputEventCodecError.value("hidden") }
                    return reason
                },
                app: try read.optionalIndex("app"), syn: try read.optionalIndex("syn"), el: try read.element())
            if key.hidden != nil, key.code != nil || key.key != nil || !key.mods.isEmpty {
                throw InputEventCodecError.members("a hidden key_down carries no code, no key and no mods")
            }
            body = .keyDown(key)
        case .keyUp:
            body = .keyUp(code: try read.optionalInteger("code"), app: try read.optionalIndex("app"),
                          syn: try read.optionalIndex("syn"))
        case .flags:
            body = .flags(code: try integer(object["code"], "code"), mods: try read.mods())
        case .down, .up:
            guard let spelledButton = object["button"] as? String, let button = InputButton(spelling: spelledButton) else {
                throw InputEventCodecError.value("button")
            }
            let pointer = InputPointer(
                button: button, x: try read.number("x"), y: try read.number("y"),
                clicks: try integer(object["clicks"], "clicks"), mods: try read.mods(),
                app: try read.optionalIndex("app"), syn: try read.optionalIndex("syn"),
                el: name == .down ? try read.element() : nil)
            body = name == .down ? .down(pointer) : .up(pointer)
        case .move:
            let drag = try read.optionalText("drag").map {
                guard let button = InputButton(spelling: $0) else { throw InputEventCodecError.value("drag") }
                return button
            }
            body = .move(InputMove(x: try read.number("x"), y: try read.number("y"), drag: drag,
                                   app: try read.optionalIndex("app"), syn: try read.optionalIndex("syn")))
        case .scroll:
            let phase = try read.optionalText("phase").map {
                guard let phase = InputScrollPhase(rawValue: $0) else { throw InputEventCodecError.value("phase") }
                return phase
            }
            body = .scroll(InputScroll(x: try read.number("x"), y: try read.number("y"),
                                       dx: try read.number("dx"), dy: try read.number("dy"),
                                       lines: try read.trueFlag("lines"), phase: phase,
                                       app: try read.optionalIndex("app"), syn: try read.optionalIndex("syn")))
        case .activate:
            guard let app = try read.optionalIndex("app") else { throw InputEventCodecError.value("app") }
            body = .activate(app: app, pid: try integer(object["pid"], "pid"))
        case .logStart:
            body = .logStart(inputMonitoring: try flag(object["input_monitoring"], "input_monitoring"),
                             accessibility: try flag(object["accessibility"], "accessibility"))
        case .logStop:
            body = .logStop
        case .secureInput:
            body = .secureInput(on: try flag(object["on"], "on"))
        case .locked:
            body = .locked(on: try flag(object["on"], "on"))
        case .tapRestart:
            guard let spelled = object["reason"] as? String, let reason = InputTapRestartReason(rawValue: spelled) else {
                throw InputEventCodecError.value("reason")
            }
            body = .tapRestart(reason)
        case .layout:
            guard let id = object["id"] as? String else { throw InputEventCodecError.value("id") }
            body = .layout(id: id)
        case .siteUnknown:
            body = .siteUnknown(on: try flag(object["on"], "on"))
        }
        let site = try read.optionalIndex("site")
        if site != nil, body.appIndices.isEmpty { throw InputEventCodecError.members("site without app") }
        return InputEvent(t: t, body: body, site: site)
    }

    private struct Reader {
        let object: [String: Any]

        func optionalText(_ key: String) throws -> String? {
            guard let value = object[key] else { return nil }
            guard let text = value as? String else { throw InputEventCodecError.value(key) }
            return text
        }

        func optionalInteger(_ key: String) throws -> Int? {
            guard let value = object[key] else { return nil }
            return try integer(value, key)
        }

        func optionalIndex(_ key: String) throws -> Int? {
            guard let index = try optionalInteger(key) else { return nil }
            guard index >= 0 else { throw InputEventCodecError.value(key) }
            return index
        }

        func number(_ key: String) throws -> Double {
            guard let number = object[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite else { throw InputEventCodecError.value(key) }
            return number.doubleValue
        }

        func trueFlag(_ key: String) throws -> Bool {
            guard let value = object[key] else { return false }
            guard try flag(value, key) else { throw InputEventCodecError.value(key) }
            return true
        }

        func mods() throws -> [InputModifier] {
            guard let value = object["mods"] else { return [] }
            guard let spellings = value as? [String], !spellings.isEmpty else { throw InputEventCodecError.value("mods") }
            let mods = try spellings.map {
                guard let modifier = InputModifier(rawValue: $0) else { throw InputEventCodecError.value("mods") }
                return modifier
            }
            guard mods == Array(Set(mods)).sorted() else { throw InputEventCodecError.value("mods") }
            return mods
        }

        func element() throws -> InputElement? {
            guard let value = object["el"] else { return nil }
            guard let member = value as? [String: Any] else { throw InputEventCodecError.value("el") }
            return try InputEventCodec.element(member)
        }
    }

    private static let attributeKeys: Set<String> = ["role", "subrole", "title", "desc", "id", "url", "value"]

    private static func element(_ object: [String: Any]) throws -> InputElement {
        guard Set(object.keys).isSubset(of: attributeKeys.union(["action", "ms", "err"])) else {
            throw InputEventCodecError.members("el carries only element attributes, action, ms and err")
        }
        var element = InputElement(attributes: try attributes(object))
        if let action = object["action"] {
            guard let member = action as? [String: Any], Set(member.keys).isSubset(of: attributeKeys) else {
                throw InputEventCodecError.value("action")
            }
            element.action = try attributes(member)
        }
        if let ms = object["ms"] { element.ms = try integer(ms, "ms") }
        if let err = object["err"] {
            guard let spelling = err as? String, let error = InputLookupError(spelling: spelling) else {
                throw InputEventCodecError.value("err")
            }
            element.err = error
        }
        return element
    }

    private static func attributes(_ object: [String: Any]) throws -> InputElementAttributes {
        func text(_ key: String) throws -> String? {
            guard let value = object[key] else { return nil }
            guard let text = value as? String else { throw InputEventCodecError.value(key) }
            return text
        }
        return InputElementAttributes(role: try text("role"), subrole: try text("subrole"), title: try text("title"),
                                      desc: try text("desc"), id: try text("id"), url: try text("url"),
                                      value: try text("value"))
    }

    static func jsonObject(_ line: String) throws -> [String: Any] {
        guard let bytes = line.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: bytes),
              let object = value as? [String: Any] else {
            throw InputEventCodecError.notAnObject
        }
        return object
    }

    private static func instant(_ value: Any?) throws -> Date {
        guard let text = value as? String, let date = UTCInstant.date(rfc3339: text) else {
            throw InputEventCodecError.instant(String(describing: value ?? ""))
        }
        return date
    }

    static func integer(_ value: Any?, _ key: String) throws -> Int {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue == number.doubleValue.rounded(),
              abs(number.doubleValue) < 9_007_199_254_740_992 else {
            throw InputEventCodecError.value(key)
        }
        return number.intValue
    }

    static func flag(_ value: Any?, _ key: String) throws -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
            throw InputEventCodecError.value(key)
        }
        return number.boolValue
    }
}
