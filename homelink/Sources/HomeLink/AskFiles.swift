import Foundation

extension HomeLink {
    public func stage(photo file: URL) async throws -> Ask.Staged {
        let response = try await contact("POST", "/v1/ask/files", ["Content-Type": "application/octet-stream"], .file(file),
                                         timeout: Self.silence)
        guard (200...299).contains(response.status) else { throw failure(response) }
        return try Self.decoded(Ask.Staged.self, response)
    }

    public func openNote(_ note: String) async throws {
        try await self.note("POST", note, nil, .empty)
    }

    public func sendSecond(note: String, _ k: Int, file: URL) async throws {
        try await self.note("PUT", note, k, .file(file))
    }

    public func cancelNote(_ note: String) async throws {
        try await self.note("DELETE", note, nil, .empty)
    }

    private func note(_ method: String, _ note: String, _ k: Int?, _ body: HomeRequest.Body) async throws {
        guard Ask.isNote(note), let path = Self.encoded(note) else { throw LinkFailure.unusableID }
        let second = k.map { "/\($0)" } ?? ""
        let response = try await contact(method, "/v1/ask/notes/" + path + second,
                                         k == nil ? [:] : ["Content-Type": "application/octet-stream"], body, timeout: Self.silence,
                                         route: method + " /v1/ask/notes/<id>" + (k == nil ? "" : "/<k>"))
        guard (200...299).contains(response.status) else { throw failure(response) }
    }
}

extension HomeLink.Ask {
    static func isNote(_ id: String) -> Bool {
        id.count == 32 && id.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }

    public static func mint() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    public struct Question: Sendable, Equatable, Codable {
        public let submission: String
        public let words: String?
        public let photos: [String]
        public let voice: Voice?

        public enum Voice: Sendable, Equatable, Codable {
            case note(String, seconds: Int)
            case audio(String)
        }

        public init(submission: String = HomeLink.Ask.mint(), words: String?, photos: [String] = [], voice: Voice? = nil) {
            self.submission = submission
            self.words = words.flatMap { $0.isEmpty ? nil : $0 }
            self.photos = photos
            self.voice = voice
        }

        var body: [String: Any] {
            var body: [String: Any] = ["submission": submission]
            if let words { body["question"] = words }
            if !photos.isEmpty { body["photos"] = photos }
            switch voice {
            case .note(let note, let seconds)?: body["voice"] = ["note": note, "seconds": seconds]
            case .audio(let audio)?: body["voice"] = ["audio": audio]
            case nil: break
            }
            return body
        }
    }

    public struct Missing: Error, Sendable, Equatable {
        public let photos: [String]
        public let seconds: [Int]
        public let audio: [String]
        public let words: String?

        public init(photos: [String], seconds: [Int], audio: [String] = [], words: String? = nil) {
            self.photos = photos
            self.seconds = seconds
            self.audio = audio
            self.words = words
        }

        init?(_ response: HomeResponse) {
            guard response.status == 409,
                  let object = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any],
                  let missing = object["missing"] as? [String: Any] else { return nil }
            photos = missing["photos"] as? [String] ?? []
            seconds = (missing["seconds"] as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.intValue }
            audio = missing["audio"] as? [String] ?? []
            words = object["error"] as? String ?? object["message"] as? String
        }
    }

    public struct Staged: Decodable, Sendable, Equatable {
        public let file: String
        public let kind: String
        public let width: Int?
        public let height: Int?
        public let read: Bool?

        public init(file: String, kind: String = "photo", width: Int? = nil, height: Int? = nil, read: Bool? = nil) {
            self.file = file
            self.kind = kind
            self.width = width
            self.height = height
            self.read = read
        }

        public static func read(_ response: HomeResponse) throws -> Staged {
            guard (200...299).contains(response.status) else { throw refusal(response) }
            do {
                return try JSONDecoder().decode(Staged.self, from: response.body)
            } catch {
                throw LinkFailure.unreadable(response.status)
            }
        }

        static func refusal(_ response: HomeResponse) -> LinkFailure {
            let object = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any]
            let code = object?["code"] as? String ?? "HTTP_\(response.status)"
            let message = object?["message"] as? String ?? "Lifestream refused with \(response.status)"
            if response.status >= 500 {
                return .unavailable(code: code, message: object?["message"] as? String,
                                    retryAfter: response.header("Retry-After").flatMap(TimeInterval.init))
            }
            return .refused(status: response.status, code: code, message: message)
        }
    }
}
