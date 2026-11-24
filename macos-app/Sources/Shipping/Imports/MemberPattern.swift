import Foundation

public enum MemberPattern {
    public static func matches(_ pattern: String, _ name: String) -> Bool {
        guard let expression = expression(pattern) else { return false }
        return expression.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
    }

    public static func any(_ patterns: [String], in members: [String]) -> Bool {
        members.contains { member in patterns.contains { matches($0, member) } }
    }

    static func body(_ pattern: String) -> String {
        let parts = pattern.split(separator: "/", omittingEmptySubsequences: false)
        return parts.enumerated().map { at, part in
            let last = at == parts.count - 1
            if part == "**" { return last ? "[^/]+(?:/[^/]+)*" : "(?:[^/]+/)*" }
            return part.split(separator: "*", omittingEmptySubsequences: false)
                .map { NSRegularExpression.escapedPattern(for: String($0)) }
                .joined(separator: "[^/]*") + (last ? "" : "/")
        }.joined()
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var made: [String: NSRegularExpression] = [:]

    private static func expression(_ pattern: String) -> NSRegularExpression? {
        lock.withLock {
            if let made = made[pattern] { return made }
            guard let expression = try? NSRegularExpression(pattern: "^(?:[^/]+/)*" + body(pattern) + "\\z", options: [.caseInsensitive]) else {
                return nil
            }
            made[pattern] = expression
            return expression
        }
    }
}
