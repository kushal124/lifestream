import Foundation

public enum AppGroup {
    public static let identifier: String = {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "LifestreamAppGroup") as? String, group.hasPrefix("group.") else {
            preconditionFailure("this bundle's Info.plist states no LifestreamAppGroup: project.yml sets it from LIFESTREAM_APP_GROUP")
        }
        return group
    }()
}
