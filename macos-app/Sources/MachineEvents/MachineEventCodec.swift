import Evidence
import Foundation

enum MachineEventCodecError: Error, Equatable, CustomStringConvertible {
    case unrepresentableNumber(String)
    case notAnObject
    case members(String)
    case instant(String)
    case unknownEvent(String)
    case detailValue(String)

    var description: String {
        switch self {
        case .unrepresentableNumber(let key): return "detail \(key) is not a finite number"
        case .notAnObject: return "a machine event line is one JSON object"
        case .members(let detail): return "machine event members: \(detail)"
        case .instant(let value): return "\(value) is not an RFC 3339 UTC instant with milliseconds"
        case .unknownEvent(let name): return "\(name) is not a machine event name"
        case .detailValue(let key): return "detail \(key) is not a string, number or boolean"
        }
    }
}

enum MachineEventCodec {
    static func line(_ event: MachineEvent) throws -> String {
        var members: [String] = []
        for (key, value) in event.detail.sorted(by: { $0.key < $1.key }) {
            members.append("\(quoted(key)):\(try scalar(value, key))")
        }
        return "{\"at\":\(quoted(UTCInstant.rfc3339(event.at)))," +
            "\"event\":\(quoted(event.name.rawValue))," +
            "\"detail\":{\(members.joined(separator: ","))}}"
    }

    static func event(_ line: String) throws -> MachineEvent {
        guard let bytes = line.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: bytes),
              let object = value as? [String: Any] else {
            throw MachineEventCodecError.notAnObject
        }
        guard Set(object.keys) == ["at", "event", "detail"] else {
            throw MachineEventCodecError.members("must be exactly at, event, detail")
        }
        guard let at = object["at"] as? String, let instant = UTCInstant.date(rfc3339: at) else {
            throw MachineEventCodecError.instant(String(describing: object["at"] ?? ""))
        }
        guard let spelling = object["event"] as? String, let name = MachineEventName(rawValue: spelling) else {
            throw MachineEventCodecError.unknownEvent(String(describing: object["event"] ?? ""))
        }
        guard let raw = object["detail"] as? [String: Any] else {
            throw MachineEventCodecError.members("detail must be a JSON object")
        }
        var detail: [String: MachineEventValue] = [:]
        for (key, member) in raw { detail[key] = try detailValue(member, key) }
        return MachineEvent(at: instant, name: name, detail: detail)
    }

    private static func detailValue(_ member: Any, _ key: String) throws -> MachineEventValue {
        if let text = member as? String { return .text(text) }
        guard let number = member as? NSNumber else { throw MachineEventCodecError.detailValue(key) }
        if CFGetTypeID(number) == CFBooleanGetTypeID() { return .flag(number.boolValue) }
        return .number(number.doubleValue)
    }

    private static func scalar(_ member: MachineEventValue, _ key: String) throws -> String {
        switch member {
        case .text(let text): return quoted(text)
        case .flag(let flag): return flag ? "true" : "false"
        case .number(let number):
            guard number.isFinite else { throw MachineEventCodecError.unrepresentableNumber(key) }
            if number == number.rounded(), abs(number) < 9_007_199_254_740_992 {
                return String(Int64(number))
            }
            return "\(number)"
        }
    }

    private static func quoted(_ text: String) -> String {
        var out = "\""
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
        return out + "\""
    }
}
