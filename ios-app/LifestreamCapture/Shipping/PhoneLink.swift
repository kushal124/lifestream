import Foundation
import HomeLink

enum PhoneLink {
    @MainActor static func device() -> HomeLink.Device {
        HomeLink.Device(kind: .phone,
                        version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0",
                        model: HardwareIdentity.marketingName, serial4: nil,
                        stamp: (Bundle.main.object(forInfoDictionaryKey: "LifestreamHomeFloor") as? String).flatMap { Int($0) })
    }

    @MainActor static func name(_ typed: String = "") -> String {
        let renamed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard renamed.isEmpty else { return renamed }
        let model = HardwareIdentity.marketingName
        return model == HardwareIdentity.machineModel ? "iPhone" : model
    }
}
