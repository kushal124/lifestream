import Foundation

extension HomeLink {
    public func state(account text: String) async throws -> FreshAnswer {
        guard device.kind == .phone else { throw LinkFailure.account }
        let account = try Self.account(text)
        let body = try JSONSerialization.data(withJSONObject: ["account": account], options: [.sortedKeys])
        let response = try await contact("POST", "/v1/account", ["Content-Type": "application/json"], .json(body))
        guard (200...299).contains(response.status) else {
            let refusal = failure(response)
            if refusal.code == "ACCOUNT_SET" { _ = try? await exchange() }
            throw refusal
        }
        return try await exchange()
    }
}
