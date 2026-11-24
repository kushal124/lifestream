import Foundation
import SwiftUI

public struct JSONTree: View {
    let root: JSONValue?
    let raw: String
    var openDepth = 2

    public init(_ data: Data) {
        root = JSONReader.parse(data)
        raw = root == nil ? String(decoding: data, as: UTF8.self) : ""
    }

    public init(object: Any) {
        root = JSONValue(object)
        raw = ""
    }

    public var body: some View {
        Group {
            if let root {
                JSONNode(key: nil, value: root, depth: 0, openDepth: openDepth)
            } else {
                Text(raw)
                    .foregroundStyle(Cockpit.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .cockpit(.monoData)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

indirect enum JSONValue: Sendable {
    case object([JSONMember])
    case array([JSONValue])
    case string(String)
    case number(String)
    case bool(Bool)
    case null

    init(_ object: Any) {
        switch object {
        case let dictionary as [String: Any]:
            self = .object(dictionary.keys.sorted().map { JSONMember(key: $0, value: JSONValue(dictionary[$0]!)) })
        case let array as [Any]:
            self = .array(array.map(JSONValue.init))
        case let string as String:
            self = .string(string)
        case let number as NSNumber:
            self = CFGetTypeID(number) == CFBooleanGetTypeID() ? .bool(number.boolValue) : .number(number.stringValue)
        default:
            self = .null
        }
    }

    var children: [JSONMember]? {
        switch self {
        case let .object(members): members
        case let .array(items): items.map { JSONMember(key: nil, value: $0) }
        default: nil
        }
    }

    var leafText: String {
        switch self {
        case let .string(value): "\"\(Self.escape(value))\""
        case let .number(text): text
        case let .bool(value): value ? "true" : "false"
        case .null: "null"
        case let .object(members): members.isEmpty ? "{}" : ""
        case let .array(items): items.isEmpty ? "[]" : ""
        }
    }

    static func escape(_ value: String) -> String {
        var out = ""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case let c where c.value < 0x20: out += String(format: "\\u%04x", c.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out
    }
}

struct JSONMember: Sendable {
    let key: String?
    let value: JSONValue
}

struct JSONReader {
    private let bytes: [UInt8]
    private var index = 0

    static func parse(_ data: Data) -> JSONValue? {
        var reader = JSONReader(bytes: Array(data))
        guard let value = reader.value(depth: 0) else { return nil }
        reader.skipSpace()
        return reader.index == reader.bytes.count ? value : nil
    }

    private init(bytes: [UInt8]) { self.bytes = bytes }

    private var peek: UInt8? { index < bytes.count ? bytes[index] : nil }

    private mutating func skipSpace() {
        while let byte = peek, byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D { index += 1 }
    }

    private mutating func eat(_ byte: Character) -> Bool {
        skipSpace()
        guard peek == byte.asciiValue else { return false }
        index += 1
        return true
    }

    private mutating func value(depth: Int) -> JSONValue? {
        guard depth < 256 else { return nil }
        skipSpace()
        switch peek {
        case UInt8(ascii: "{"):
            index += 1
            var members: [JSONMember] = []
            if eat("}") { return .object(members) }
            repeat {
                skipSpace()
                guard let key = string(), eat(":"), let item = value(depth: depth + 1) else { return nil }
                members.append(JSONMember(key: key, value: item))
            } while eat(",")
            return eat("}") ? .object(members) : nil
        case UInt8(ascii: "["):
            index += 1
            var items: [JSONValue] = []
            if eat("]") { return .array(items) }
            repeat {
                guard let item = value(depth: depth + 1) else { return nil }
                items.append(item)
            } while eat(",")
            return eat("]") ? .array(items) : nil
        case UInt8(ascii: "\""):
            return string().map(JSONValue.string)
        case UInt8(ascii: "t"): return literal("true", .bool(true))
        case UInt8(ascii: "f"): return literal("false", .bool(false))
        case UInt8(ascii: "n"): return literal("null", .null)
        default: return number()
        }
    }

    private mutating func literal(_ word: String, _ value: JSONValue) -> JSONValue? {
        let utf8 = Array(word.utf8)
        guard index + utf8.count <= bytes.count, Array(bytes[index..<index + utf8.count]) == utf8 else { return nil }
        index += utf8.count
        return value
    }

    private mutating func digits() -> Bool {
        let start = index
        while let byte = peek, byte >= 0x30, byte <= 0x39 { index += 1 }
        return index > start
    }

    private mutating func number() -> JSONValue? {
        let start = index
        if peek == UInt8(ascii: "-") { index += 1 }
        guard digits() else { return nil }
        if peek == UInt8(ascii: ".") { index += 1; guard digits() else { return nil } }
        if peek == UInt8(ascii: "e") || peek == UInt8(ascii: "E") {
            index += 1
            if peek == UInt8(ascii: "+") || peek == UInt8(ascii: "-") { index += 1 }
            guard digits() else { return nil }
        }
        return .number(String(decoding: bytes[start..<index], as: UTF8.self))
    }

    private mutating func hex4() -> UInt32? {
        guard index + 4 <= bytes.count, let value = UInt32(String(decoding: bytes[index..<index + 4], as: UTF8.self), radix: 16) else { return nil }
        index += 4
        return value
    }

    private mutating func string() -> String? {
        guard peek == UInt8(ascii: "\"") else { return nil }
        index += 1
        var out: [UInt8] = []
        while let byte = peek {
            index += 1
            switch byte {
            case UInt8(ascii: "\""):
                return String(decoding: out, as: UTF8.self)
            case UInt8(ascii: "\\"):
                guard let escape = peek else { return nil }
                index += 1
                switch escape {
                case UInt8(ascii: "\""), UInt8(ascii: "\\"), UInt8(ascii: "/"): out.append(escape)
                case UInt8(ascii: "b"): out.append(0x08)
                case UInt8(ascii: "f"): out.append(0x0C)
                case UInt8(ascii: "n"): out.append(0x0A)
                case UInt8(ascii: "r"): out.append(0x0D)
                case UInt8(ascii: "t"): out.append(0x09)
                case UInt8(ascii: "u"):
                    guard var code = hex4() else { return nil }
                    if (0xD800..<0xDC00).contains(code), peek == UInt8(ascii: "\\"), index + 1 < bytes.count, bytes[index + 1] == UInt8(ascii: "u") {
                        index += 2
                        guard let low = hex4(), (0xDC00..<0xE000).contains(low) else { return nil }
                        code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
                    }
                    out.append(contentsOf: Array(String(Unicode.Scalar(code) ?? "\u{FFFD}").utf8))
                default: return nil
                }
            case ..<0x20:
                return nil
            default:
                out.append(byte)
            }
        }
        return nil
    }
}

struct JSONNode: View {
    let key: String?
    let value: JSONValue
    let depth: Int
    let openDepth: Int
    @State private var open: Bool?
    @State private var shown = JSONNode.page
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let page = 100
    static let caret = Cockpit.Size.iconXs
    static let gap = Cockpit.Space.s1

    var body: some View {
        if let children = value.children, !children.isEmpty {
            container(children)
        } else {
            line(caret: false) {
                Text("\(keyText)\(Text(value.leafText).foregroundStyle(Cockpit.Color.text))")
            }
        }
    }

    private var isOpen: Bool { open ?? (depth < openDepth) }

    private var brackets: (String, String) {
        if case .array = value { ("[", "]") } else { ("{", "}") }
    }

    private var keyText: Text {
        guard let key else { return Text(verbatim: "") }
        return Text("\(Text(key).foregroundStyle(Cockpit.Color.textSecondary))\(Text(verbatim: ": ").foregroundStyle(Cockpit.Color.textTertiary))")
    }

    private func container(_ children: [JSONMember]) -> some View {
        let (left, right) = brackets
        let count = children.count.formatted(.number.grouping(.automatic))
        return VStack(alignment: .leading, spacing: Self.spacing) {
            Button {
                withAnimation(reduceMotion ? .easeInOut(duration: Cockpit.Duration.fast) : Cockpit.Ease.spring()) { open = !isOpen }
            } label: {
                line(caret: true) {
                    Text("\(keyText)\(Text(isOpen ? left : "\(left) \(count) \(right)").foregroundStyle(Cockpit.Color.textTertiary))")
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(key ?? (left == "[" ? "List" : "Object")), \(count) \(left == "[" ? "items" : "keys")")
            .accessibilityValue(isOpen ? "Open" : "Folded")
            if isOpen {
                VStack(alignment: .leading, spacing: Self.spacing) {
                    ForEach(Array(children.prefix(shown).enumerated()), id: \.offset) { _, child in
                        AnyView(JSONNode(key: child.key, value: child.value, depth: depth + 1, openDepth: openDepth))
                    }
                    if children.count > shown {
                        Button("Show \((children.count - shown).formatted(.number.grouping(.automatic))) more") { shown += Self.page }
                            .buttonStyle(.plain)
                            .cockpit(.footnote)
                            .foregroundStyle(Cockpit.Color.textSecondary)
                            .padding(.leading, Self.caret + Self.gap)
                    }
                }
                .padding(.leading, Self.caret + Self.gap)
                .background(alignment: .leading) {
                    Rectangle()
                        .fill(Cockpit.Color.rule)
                        .frame(width: Cockpit.Stroke.border)
                        .padding(.leading, Self.caret / 2)
                        .accessibilityHidden(true)
                }
                line(caret: false) { Text(right).foregroundStyle(Cockpit.Color.textTertiary) }
                    .accessibilityHidden(true)
            }
        }
    }

    private static let spacing: CGFloat = 2

    private func line(caret: Bool, @ViewBuilder text: () -> Text) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Self.gap) {
            Group {
                if caret {
                    Icon(isOpen ? .expand : .forward, size: .xs)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                } else {
                    Color.clear.frame(height: 1)
                }
            }
            .frame(width: Self.caret)
            text()
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
