import Foundation
import HomeLink
import UIKit

actor CannedFeedback {
    static let shared = CannedFeedback()
    static let act = "Report a problem"
    static let answer = """
        Question: Where did I have dinner on Friday?
        Answer: At [[Place 1]] with [[Person 1]] [r1].
        Steps:
          search {q: dinner, day: 2026-09-04} → r1 (40 ms)
        Model: canned, thinking low, 2 s, done

        """

    private var drafts: Set<String> = []
    private var kept: Set<String> = []

    static func page() -> Data? {
        fixture("page")
    }

    static func reportable(_ rows: [[String: Any]]) -> [[String: Any]] {
        guard opened else { return rows }
        return rows.map { row in
            guard var health = row["health"] as? [String: Any], health["state"] as? String == "broken", let id = row["id"] as? String else {
                return row
            }
            var row = row
            health["acts"] = (health["acts"] as? [[String: Any]] ?? []) + [["do": "report", "label": act, "of": id]]
            row["health"] = health
            return row
        }
    }

    func perform(_ request: HomeRequest, names: [String: String]) -> HomeResponse {
        guard Self.opened, request.method == "POST" else { return Self.reply(404, ["code": "NOT_FOUND", "message": "feedback is closed"]) }
        switch request.url.path {
        case "/v1/feedback/draft":
            guard let asked = Self.object(request), let id = asked["id"] as? String, let about = asked["about"] as? [String: Any] else {
                return Self.reply(422, ["code": "BAD_REQUEST", "message": "a draft is {id, about}"])
            }
            drafts.insert(id)
            return Self.reply(200, Self.draft(about, names: names))
        case "/v1/feedback/screenshot":
            let id = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "id" }?.value
            guard let id, drafts.contains(id) else { return Self.reply(404, ["code": "NOT_FOUND", "message": "no such draft"]) }
            guard case .bytes(let bytes) = request.body, let image = UIImage(data: bytes) else {
                return Self.reply(415, ["code": "FILE_KIND", "message": "not a picture"])
            }
            return Self.reply(200, ["width": Int(image.size.width * image.scale), "height": Int(image.size.height * image.scale)])
        case "/v1/feedback/send":
            guard let asked = Self.object(request), let id = asked["id"] as? String else {
                return Self.reply(422, ["code": "BAD_REQUEST", "message": "a send is {id, text, email, keep}"])
            }
            guard kept.contains(id) || drafts.remove(id) != nil else { return Self.reply(404, ["code": "NOT_FOUND", "message": "no such draft"]) }
            kept.insert(id)
            return Self.reply(200, ["id": id])
        default:
            return Self.reply(404, ["code": "NOT_FOUND", "message": "no such route"])
        }
    }

    private static var opened: Bool {
        page().flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }?["open"] as? Bool == true
    }

    private static func draft(_ about: [String: Any], names: [String: String]) -> [String: Any] {
        var made = fixture("draft").flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] } ?? ["attachments": [Any](), "email": NSNull()]
        let kinds = page().flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }?["kinds"] as? [[String: Any]] ?? []
        func title(_ kind: String) -> String { kinds.first { $0["kind"] as? String == kind }?["title"] as? String ?? kind }
        var attachments = made["attachments"] as? [[String: Any]] ?? []
        switch about["kind"] as? String {
        case "chat":
            attachments.insert(["kind": "answer", "title": title("answer"), "text": answer, "counts": ["Place": 1, "Person": 1]], at: 0)
        case "connector":
            let id = about["connector"] as? String ?? ""
            let name = names[id] ?? id
            attachments.insert(["kind": "connector", "title": title("connector").replacingOccurrences(of: "{name}", with: name),
                                "text": "Connector: \(name) (\(id))\nState: broken\n", "counts": [String: Int]()], at: 0)
        default:
            break
        }
        made["attachments"] = attachments
        return made
    }

    private static func fixture(_ name: String) -> Data? {
        Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "feedback").flatMap { try? Data(contentsOf: $0) }
    }

    private static func object(_ request: HomeRequest) -> [String: Any]? {
        guard case .json(let body) = request.body else { return nil }
        return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    }

    private static func reply(_ status: Int, _ object: [String: Any]) -> HomeResponse {
        HomeResponse(status: status, body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data())
    }
}
