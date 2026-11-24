import Foundation

enum PhoneWords {
    static func word(_ grant: String, _ state: PermissionsModel.Stated) -> String {
        GrantWords.all[grant]?[state] ?? ""
    }
}
