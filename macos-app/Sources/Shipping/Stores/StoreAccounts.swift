import Evidence
import Foundation
import HomeLink

enum StoreAccounts {
    struct Held: Equatable {
        let account: String
        let folder: String?
    }

    static let appleAccounts = "~/Library/Preferences/MobileMeAccounts.plist"

    static func read(_ store: HomeLink.MacStore, road: StoreFiles) -> [Held] {
        let spelled = store.spelled != false
        func kept(_ value: String) -> String? {
            if spelled { return MacAccounts.spelled(value) }
            return value.isEmpty || value.contains("/") ? nil : value
        }
        func tested(_ value: Any?, _ rule: HomeLink.MacStore.ValueRule) -> String? {
            guard var text = value as? String else { return nil }
            if let holds = rule.holds, !text.contains(holds) { return nil }
            if let before = rule.before {
                guard text.hasSuffix(before) else { return nil }
                text = String(text.dropLast(before.count))
            }
            if rule.digits == true, text.isEmpty || !text.allSatisfy({ $0.isASCII && $0.isNumber }) { return nil }
            return kept(text)
        }
        func bytes(_ path: String) -> Data? {
            guard let url = try? road.path(path), let opened = try? road.open(url, spelled: path) else { return nil }
            return try? opened.bytes()
        }
        switch store.account {
        case .local:
            return [Held(account: "local", folder: nil)]
        case .appleID:
            guard let list = try? road.path(appleAccounts) else { return [] }
            switch MacAccounts.appleID(list) {
            case .none: return [Held(account: "local", folder: nil)]
            case .account(let account): return [Held(account: account, folder: nil)]
            case .unknown: return []
            }
        case .plist(let path, let key, let rule):
            guard let data = bytes(path), let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                  let account = tested(plist[key], rule) else { return [] }
            return [Held(account: account, folder: nil)]
        case .json(let path, let at, let rule):
            guard let data = bytes(path), let object = try? JSONSerialization.jsonObject(with: data),
                  let account = tested(StoreValues.value(at: at.components(separatedBy: "."), in: object), rule) else { return [] }
            return [Held(account: account, folder: nil)]
        case .jsonKeys(let path, let at, let tests):
            guard let data = bytes(path), let object = try? JSONSerialization.jsonObject(with: data),
                  (tests ?? []).allSatisfy({ StoreValues.holds($0, object) }),
                  let keys = (StoreValues.value(at: at.components(separatedBy: "."), in: object) as? [String: Any])?.keys else { return [] }
            return keys.compactMap(kept).sorted().map { Held(account: $0, folder: nil) }
        case .folders(let path, let match, let holding, _):
            guard let root = try? road.path(path) else { return [] }
            let folders = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
            let base = path.hasSuffix("/") ? String(path.dropLast()) : path
            return folders.filter { folder in
                StoreFiles.matches(match, folder)
                    && (try? road.path("\(base)/<account>/\(holding)", account: folder)).map { FileFacts.isRegularFile($0.path) } == true
            }
            .compactMap { folder in kept(folder.lowercased().replacingOccurrences(of: " ", with: "-")).map { Held(account: $0, folder: folder) } }
            .sorted { $0.account < $1.account }
        }
    }
}

enum StoreValues {
    static func value(at path: [String], in root: Any) -> Any? {
        var value: Any? = root
        for key in path { value = (value as? [String: Any])?[key] }
        return value
    }

    static func holds(_ test: HomeLink.MacStore.Test, _ root: Any) -> Bool {
        let value = value(at: test.at.components(separatedBy: "."), in: root)
        if test.object == true { return value is [String: Any] }
        if let prefix = test.prefix { return (value as? String)?.hasPrefix(prefix) ?? false }
        switch test.equals {
        case .text(let text)?: return value as? String == text
        case .number(let number)?:
            guard let found = value as? NSNumber, CFGetTypeID(found) != CFBooleanGetTypeID() else { return false }
            return found.doubleValue == number
        case nil: return false
        }
    }
}

enum MacAccounts {
    enum AppleID: Equatable {
        case none
        case account(String)
        case unknown
    }

    static func appleID(_ list: URL) -> AppleID {
        let bytes: Data
        do {
            bytes = try Data(contentsOf: list)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return .none
        } catch {
            return .unknown
        }
        guard let plist = try? PropertyListSerialization.propertyList(from: bytes, format: nil) as? [String: Any] else {
            return .unknown
        }
        guard let accounts = plist["Accounts"] as? [[String: Any]], let first = accounts.first else { return .none }
        guard let id = first["AccountID"] as? String, let account = spelled(id) else { return .unknown }
        return .account(account)
    }

    static func spelled(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let account = trimmed.contains("@")
            ? trimmed.lowercased()
            : (trimmed.hasPrefix("+") ? "+" : "") + trimmed.filter { $0.isASCII && $0.isNumber }
        guard !account.isEmpty, account != "+",
              !account.contains(where: { ":/\\\0".contains($0) || $0.isWhitespace }) else { return nil }
        return account
    }
}
