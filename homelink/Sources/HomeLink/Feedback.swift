import Foundation

extension HomeLink {
    public enum Feedback {
        public enum About: Sendable, Hashable {
            case menu
            case chat(String, n: Int)
            case connector(String)

            var said: [String: Any] {
                switch self {
                case .menu: ["kind": "menu"]
                case .chat(let chat, let n): ["kind": "chat", "chat": chat, "n": n]
                case .connector(let connector): ["kind": "connector", "connector": connector]
                }
            }
        }

        public struct Size: Decodable, Sendable, Equatable {
            public let width: Int
            public let height: Int

            public init(width: Int, height: Int) {
                self.width = width
                self.height = height
            }
        }

        public enum Held: Sendable, Equatable {
            case held(Size)
            case forgotten
        }

        public enum Sent: Sendable, Equatable {
            case sent
            case forgotten
        }

        public static func mint() -> String {
            UUID().uuidString.lowercased()
        }

        static func isID(_ id: String) -> Bool {
            guard id.count == 36, id == id.lowercased(), let uuid = UUID(uuidString: id) else { return false }
            let bytes = uuid.uuid
            return bytes.6 >> 4 == 4 && bytes.8 >> 6 == 0b10
        }

        static let gone = "NOT_FOUND"
    }

    public func feedbackDraft(id: String, about: Feedback.About) async throws -> Pages.FeedbackDraft {
        let response = try await feedback("draft", id, ["id": id, "about": about.said])
        guard response.status == 200 else { throw failure(response) }
        return try Self.decoded(Pages.FeedbackDraft.self, response)
    }

    public func feedbackScreenshot(id: String, jpeg: Data) async throws -> Feedback.Held {
        guard Feedback.isID(id) else { throw LinkFailure.unusableID }
        let response = try await contact("POST", "/v1/feedback/screenshot" + Self.query([("id", id)]), ["Content-Type": "image/jpeg"],
                                         .bytes(jpeg))
        if forgotten(response) { return .forgotten }
        guard response.status == 200 else { throw failure(response) }
        return .held(try Self.decoded(Feedback.Size.self, response))
    }

    public func feedbackSend(id: String, text: String, email: String?, keep: [Pages.FeedbackKind]) async throws -> Feedback.Sent {
        let kinds = keep.filter { $0 != .unknown }.map(\.rawValue)
        let response = try await feedback("send", id, ["id": id, "text": text, "email": email ?? NSNull(), "keep": kinds])
        if forgotten(response) { return .forgotten }
        guard response.status == 200 else { throw failure(response) }
        return .sent
    }

    private func feedback(_ call: String, _ id: String, _ body: [String: Any]) async throws -> HomeResponse {
        guard Feedback.isID(id) else { throw LinkFailure.unusableID }
        let said = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return try await contact("POST", "/v1/feedback/" + call, ["Content-Type": "application/json"], .json(said))
    }

    private func forgotten(_ response: HomeResponse) -> Bool {
        response.status == 404 && failure(response).code == Feedback.gone
    }
}
