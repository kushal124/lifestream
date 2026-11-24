import Foundation

extension HomeLink {
    public func refresh(connector: String) async throws -> RefreshAnswer {
        try await post("/v1/refresh", RefreshAsk(connector: connector))
    }

    public func seal(_ ask: SealAsk) async throws -> SealAnswer {
        try await post("/v1/seal", ask)
    }

    public func signIn(_ ask: SignInKeyAsk) async throws -> SignInAnswer {
        try await post("/v1/signin/key", ask, route: Self.signInRoute)
    }

    public func signIn(_ ask: SignInDeviceStartAsk) async throws -> SignInAnswer {
        try await post("/v1/signin/device/start", ask, route: Self.signInRoute)
    }

    public func signIn(_ ask: SignInDevicePollAsk) async throws -> SignInAnswer {
        try await post("/v1/signin/device/poll", ask, route: Self.signInRoute)
    }

    public func signIn(_ ask: SignInClientStartAsk) async throws -> SignInAnswer {
        try await post("/v1/signin/client/start", ask, route: Self.signInRoute)
    }

    public func signIn(_ ask: SignInClientFinishAsk) async throws -> SignInAnswer {
        try await post("/v1/signin/client/finish", ask, route: Self.signInRoute)
    }

    static let signInRoute = "POST /v1/signin/<way>"

    private func post<Body: Encodable, Answer: Decodable>(_ path: String, _ body: Body, route: String? = nil) async throws -> Answer {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let response = try await contact("POST", path, ["Content-Type": "application/json"], .json(try encoder.encode(body)),
                                         route: route)
        guard response.status == 200 else { throw failure(response) }
        do {
            return try JSONDecoder().decode(Answer.self, from: response.body)
        } catch {
            throw LinkFailure.unreadable(response.status)
        }
    }
}
