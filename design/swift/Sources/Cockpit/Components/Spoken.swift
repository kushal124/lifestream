import Foundation

enum Spoken {
    static func read(_ text: String) -> String {
        text.replacingOccurrences(of: " · ", with: ", ")
            .replacingOccurrences(of: "–", with: " to ")
            .replacingOccurrences(of: " → ", with: " to ")
            .split(separator: " ")
            .map(said)
            .joined(separator: " ")
    }

    private static func said(_ word: Substring) -> String {
        guard let part = word.wholeMatch(of: /(<?)(\d[\d,.]*)([hms])(,?)/) else { return String(word) }
        let (_, under, number, unit, comma) = part.output
        let name = unit == "h" ? "hour" : unit == "m" ? "minute" : "second"
        return (under.isEmpty ? "" : "under ") + number + " " + name + (number == "1" ? "" : "s") + comma
    }

    static func join(_ parts: String?...) -> String {
        parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}
