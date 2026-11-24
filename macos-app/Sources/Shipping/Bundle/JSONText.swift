import Foundation

indirect enum JSONText: Equatable {
    case null
    case bool(Bool)
    case int(Int)
    case string(String)
    case array([JSONText])
    case object([(String, JSONText)])

    static func == (lhs: JSONText, rhs: JSONText) -> Bool { lhs.text == rhs.text }

    var text: String {
        var out = ""
        write(into: &out)
        return out
    }

    var data: Data { Data(text.utf8) }

    private func write(into out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let value): out += value ? "true" : "false"
        case .int(let value): out += String(value)
        case .string(let value): Self.writeString(value, into: &out)
        case .array(let items):
            out += "["
            for (index, item) in items.enumerated() {
                if index > 0 { out += "," }
                item.write(into: &out)
            }
            out += "]"
        case .object(let members):
            out += "{"
            for (index, (key, value)) in members.enumerated() {
                if index > 0 { out += "," }
                Self.writeString(key, into: &out)
                out += ":"
                value.write(into: &out)
            }
            out += "}"
        }
    }

    static func writeString(_ value: String, into out: inout String) {
        out += "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case _ where scalar.value < 0x20: out += String(format: "\\u%04x", scalar.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        out += "\""
    }

    static func javaScriptOrder(_ left: String, _ right: String) -> Bool {
        left.utf16.lexicographicallyPrecedes(right.utf16)
    }
}
