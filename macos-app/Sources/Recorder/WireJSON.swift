import Evidence
import Foundation

public enum WireJSON {
    public static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(spell(date))
        }
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }

    public static func date(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }

    public static func spell(_ date: Date) -> String {
        UTCInstant.rfc3339(date)
    }
}
