import Cockpit
import CoreLocation
import HealthKit
import LifestreamCaptureCore
@preconcurrency import Photos
import UIKit

struct FirstRunFind: Equatable {
    var line: String?
    var count: Int?
    var photos: [UIImage] = []
    var initials: [String]?
    var newest: [PHAsset] = []
}

enum FirstRunFinds {
    static func read(_ source: PhoneSource) async -> FirstRunFind {
        if UITestGrants.script != nil { return scripted(source) }
        switch source {
        case .location, .screenTime: return FirstRunFind(line: "Recording from now.")
        case .motion: return await motion()
        case .health: return await health()
        case .photos: return photos()
        case .contacts: return await contacts()
        default: return FirstRunFind()
        }
    }

    static func place() async -> CLLocationCoordinate2D? {
        if UITestGrants.script != nil { return CLLocationCoordinate2D(latitude: 37.3349, longitude: -122.0090) }
        if AppRuntime.isUITesting { return nil }
        return await AppRuntime.shared.locationRecorder.firstFix()?.coordinate
    }

    private static let on = FirstRunFind(line: "On.")


    private static func motion() async -> FirstRunFind {
        guard let sweep = await AppRuntime.shared.motionRecorder.lastSweep, let steps = sweep.stepsToday else {
            return FirstRunFind(line: "Recording from now.")
        }
        return FirstRunFind(line: "\(Words.count(steps, "step")) today\(Words.dot)\(Words.count(sweep.daysRead, "day")) read.")
    }


    private static func health() async -> FirstRunFind {
        guard HKHealthStore.isHealthDataAvailable() else { return FirstRunFind() }
        let store = HKHealthStore()
        var parts: [String] = []
        if let steps = HKObjectType.quantityType(forIdentifier: .stepCount), let first = await oldest(steps, in: store) {
            parts.append("steps since \(Calendar.current.component(.year, from: first))")
        }
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis), await oldest(sleep, in: store) != nil {
            parts.append("sleep")
        }
        if let heart = HKObjectType.quantityType(forIdentifier: .heartRate), await oldest(heart, in: store) != nil {
            parts.append("heart")
        }
        guard let first = parts.first else { return FirstRunFind() }
        parts[0] = first.prefix(1).uppercased() + first.dropFirst()
        return FirstRunFind(line: parts.joined(separator: Words.dot) + ".")
    }

    private static func oldest(_ type: HKSampleType, in store: HKHealthStore) async -> Date? {
        await withCheckedContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: nil, limit: 1,
                                      sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]) { _, samples, _ in
                continuation.resume(returning: samples?.first?.startDate)
            }
            store.execute(query)
        }
    }


    private static func photos() -> FirstRunFind {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let assets = PHAsset.fetchAssets(with: options)
        let count = assets.count
        var line = photosAndVideos(count)
        if let oldest = assets.lastObject?.creationDate { line += "\(Words.dot)back to \(Calendar.current.component(.year, from: oldest))" }
        var newest: [PHAsset] = []
        assets.enumerateObjects { asset, index, stop in
            newest.append(asset)
            if index >= 7 { stop.pointee = true }
        }
        return FirstRunFind(line: line + ".", count: count, newest: newest)
    }

    static func photosAndVideos(_ count: Int) -> String {
        Words.count(count, "photo or video", plural: "photos and videos")
    }

    static func thumbnails(_ assets: [PHAsset]) async -> [UIImage] {
        var pictures: [UIImage] = []
        for asset in assets {
            if let picture = await thumbnail(asset) { pictures.append(picture) }
        }
        return pictures
    }

    private static func thumbnail(_ asset: PHAsset) async -> UIImage? {
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = false
        let side: CGFloat = 240
        return await withCheckedContinuation { continuation in
            PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: side, height: side), contentMode: .aspectFill,
                                                  options: options) { image, _ in
                continuation.resume(returning: image)
            }
        }
    }


    private static func contacts() async -> FirstRunFind {
        guard let glance = await ContactsGlance.read() else { return on }
        return FirstRunFind(line: Words.count(glance.count, "contact") + ".", count: glance.count, initials: glance.initials)
    }


    private static func scripted(_ source: PhoneSource) -> FirstRunFind {
        let limited = UITestGrants.answered[source.permission ?? ""] == "limited"
        switch source {
        case .location, .screenTime: return FirstRunFind(line: "Recording from now.")
        case .motion: return FirstRunFind(line: "\(Words.count(4_120, "step")) today\(Words.dot)\(Words.count(7, "day")) read.")
        case .health:
            return UITestGrants.answered["health"] == "on" ? FirstRunFind(line: "Steps since 2019\(Words.dot)sleep\(Words.dot)heart.") : FirstRunFind()
        case .photos:
            let count = limited ? 3 : 22_700
            let pictures = (0..<min(8, count)).compactMap { StandInPhoto.image($0).map { UIImage(cgImage: $0) } }
            return FirstRunFind(line: "\(photosAndVideos(count))\(Words.dot)back to 2014.", count: count, photos: pictures)
        case .contacts:
            let count = limited ? 12 : 1_240
            return FirstRunFind(line: Words.count(count, "contact") + ".", count: count, initials: ["A", "M", "J", "R", "S"])
        default: return FirstRunFind()
        }
    }
}
