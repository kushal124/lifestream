import Foundation
import Security

public final class KeychainTrust: @unchecked Sendable {
    public static let name = "vault.machineKeyReadBy"
    public let build: String
    private let defaults: UserDefaults
    private let held: String

    public init(build: String = KeychainTrust.thisBuild, defaults: UserDefaults = .standard, record: String = KeychainTrust.name) {
        self.build = build
        self.defaults = defaults
        held = record
    }

    public static var thisBuild: String {
        team.map { "team:\($0)" } ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "")
    }

    static let team: String? = {
        var code: SecCode?
        var staticCode: SecStaticCode?
        var information: CFDictionary?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let team = (information as? [String: Any])?[kSecCodeInfoTeamIdentifier as String] as? String, !team.isEmpty else { return nil }
        return team
    }()

    public var allowed: Bool {
        build.isEmpty || defaults.string(forKey: held) == build
    }

    func record() {
        guard !build.isEmpty, defaults.string(forKey: held) != build else { return }
        defaults.set(build, forKey: held)
    }

    public func clear() {
        guard defaults.string(forKey: held) != nil else { return }
        defaults.removeObject(forKey: held)
    }
}
