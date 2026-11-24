import CryptoKit
import Foundation
import HomeLink

extension HomeLink.DeclaredStore {
    public var behindFullDiskAccess: Bool { grants.contains(.fullDiskAccess) }

    public var digest: String { StoreDigest.of(self) }
}

public enum StoreDigest {
    public static func of(_ declared: HomeLink.DeclaredStore) -> String {
        hashed(canonical(json(declared)))
    }

    public static func of(_ stores: [String: HomeLink.DeclaredStore]) -> String {
        hashed(canonical(stores.mapValues(json)))
    }

    private static func json(_ declared: HomeLink.DeclaredStore) -> Any {
        (try? JSONEncoder().encode(declared)).flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? NSNull()
    }

    private static func hashed(_ text: String) -> String {
        "sha256:" + SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func canonical(_ value: Any) -> String {
        var out = ""
        write(value, into: &out)
        return out
    }

    private static func write(_ value: Any, into out: inout String) {
        switch value {
        case let text as String:
            JSONText.writeString(text, into: &out)
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                out += number.boolValue ? "true" : "false"
            } else if let decimal = number as? NSDecimalNumber, let exact = Double(decimal.stringValue) {
                out += spelled(exact)
            } else {
                out += spelled(number.doubleValue)
            }
        case let list as [Any]:
            out += "["
            for (index, item) in list.enumerated() {
                if index > 0 { out += "," }
                write(item, into: &out)
            }
            out += "]"
        case let object as [String: Any]:
            out += "{"
            for (index, key) in object.keys.sorted(by: JSONText.javaScriptOrder).enumerated() {
                if index > 0 { out += "," }
                JSONText.writeString(key, into: &out)
                out += ":"
                write(object[key]!, into: &out)
            }
            out += "}"
        default:
            out += "null"
        }
    }

    static func spelled(_ value: Double) -> String {
        guard value.isFinite else { return "null" }
        if value == 0 { return "0" }
        let sign = value < 0 ? "-" : ""
        let described = "\(Swift.abs(value))"
        let parts = described.split(separator: "e", maxSplits: 1)
        let mantissa = String(parts[0])
        let power = parts.count == 2 ? Int(parts[1].replacingOccurrences(of: "+", with: ""))! : 0
        let dot = mantissa.firstIndex(of: ".")
        let whole = dot.map { String(mantissa[..<$0]) } ?? mantissa
        let fraction = dot.map { String(mantissa[mantissa.index(after: $0)...]) } ?? ""
        var digits = whole + fraction
        var n = whole.count + power
        while digits.hasPrefix("0") {
            digits.removeFirst()
            n -= 1
        }
        while digits.hasSuffix("0") { digits.removeLast() }
        let k = digits.count
        if k <= n && n <= 21 { return sign + digits + String(repeating: "0", count: n - k) }
        if 0 < n && n <= 21 {
            return sign + digits.prefix(n) + "." + digits.dropFirst(n)
        }
        if -6 < n && n <= 0 { return sign + "0." + String(repeating: "0", count: -n) + digits }
        let exponent = n - 1
        let head = k == 1 ? digits : digits.prefix(1) + "." + digits.dropFirst()
        return sign + head + "e" + (exponent < 0 ? "-" : "+") + String(Swift.abs(exponent))
    }
}
