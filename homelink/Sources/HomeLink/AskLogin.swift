import Foundation

extension HomeLink {
    public func askLogin() async throws -> Data {
        guard let response = try await get("/v1/ask/login") else { throw LinkFailure.unreadable(304) }
        return response.body
    }

    public func askLogin(_ body: Data) async throws -> Data {
        let response = try await contact("POST", "/v1/ask/login", ["Content-Type": "application/json"], .json(body), timeout: Self.silence)
        guard response.status == 200 || response.status == 202 else { throw failure(response) }
        return response.body
    }
}
