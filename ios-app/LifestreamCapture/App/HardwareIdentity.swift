import Foundation
import LifestreamCaptureCore
import UIKit

@MainActor
enum HardwareIdentity {
    static var current: DeviceHardware {
        DeviceHardware(machineModel: machineModel, marketingName: marketingName, osVersion: osVersion)
    }

    static var machineModel: String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let mirror = Mirror(reflecting: systemInfo.machine)
        return mirror.children.reduce(into: "") { result, element in
            guard let byte = element.value as? Int8, byte != 0 else { return }
            result.append(Character(UnicodeScalar(UInt8(byte))))
        }
    }

    static var marketingName: String {
        marketingName(for: machineModel)
    }

    static func marketingName(for machineModel: String) -> String {
        switch machineModel {
        case "iPhone12,1": "iPhone 11"
        case "iPhone12,3": "iPhone 11 Pro"
        case "iPhone12,5": "iPhone 11 Pro Max"
        case "iPhone12,8": "iPhone SE (2nd generation)"
        case "iPhone13,1": "iPhone 12 mini"
        case "iPhone13,2": "iPhone 12"
        case "iPhone13,3": "iPhone 12 Pro"
        case "iPhone13,4": "iPhone 12 Pro Max"
        case "iPhone14,2": "iPhone 13 Pro"
        case "iPhone14,3": "iPhone 13 Pro Max"
        case "iPhone14,4": "iPhone 13 mini"
        case "iPhone14,5": "iPhone 13"
        case "iPhone14,6": "iPhone SE (3rd generation)"
        case "iPhone14,7": "iPhone 14"
        case "iPhone14,8": "iPhone 14 Plus"
        case "iPhone15,2": "iPhone 14 Pro"
        case "iPhone15,3": "iPhone 14 Pro Max"
        case "iPhone15,4": "iPhone 15"
        case "iPhone15,5": "iPhone 15 Plus"
        case "iPhone16,1": "iPhone 15 Pro"
        case "iPhone16,2": "iPhone 15 Pro Max"
        case "iPhone17,1": "iPhone 16 Pro"
        case "iPhone17,2": "iPhone 16 Pro Max"
        case "iPhone17,3": "iPhone 16"
        case "iPhone17,4": "iPhone 16 Plus"
        case "iPhone17,5": "iPhone 16e"
        case "iPhone18,1": "iPhone 17 Pro"
        case "iPhone18,2": "iPhone 17 Pro Max"
        case "iPhone18,3": "iPhone 17"
        case "iPhone18,4": "iPhone Air"
        case "i386", "x86_64", "arm64": "iPhone Simulator"
        default: machineModel
        }
    }

    static var osVersion: String {
        "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)"
    }
}
