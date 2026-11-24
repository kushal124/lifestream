import Evidence
import Foundation

public enum AudioSpool {
    public static let directoryName = "audio"
    static let audioSuffix = ".m4a"
    static let sealedSuffix = ".json"
    static let openSuffix = ".open.json"
    static let tornSuffix = ".torn"

    public static func sealedRecordings(in directory: URL) -> [String] {
        let names = Set((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [])
        return names.compactMap { name -> String? in
            guard name.hasSuffix(sealedSuffix), !name.hasSuffix(openSuffix) else { return nil }
            let stem = String(name.dropLast(sealedSuffix.count))
            return names.contains(stem + audioSuffix) ? stem : nil
        }.sorted()
    }

    public static func shippableRecordings(in directory: URL) -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        let oldestOpen = names.filter { $0.hasSuffix(openSuffix) }.map { String($0.dropLast(openSuffix.count)) }.min()
        let sealed = sealedRecordings(in: directory)
        guard let oldestOpen else { return sealed }
        return sealed.filter { $0 < oldestOpen }
    }

    public static func oldestOpenRecording(in directory: URL) -> Date? {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.filter { $0.hasSuffix(openSuffix) }.map { String($0.dropLast(openSuffix.count)) }
            .min().flatMap(instant(ofStem:))
    }

    public static func audioName(_ stem: String) -> String { stem + audioSuffix }
    public static func sidecarName(_ stem: String) -> String { stem + sealedSuffix }
    static func openName(_ stem: String) -> String { stem + openSuffix }

    static func freshStem(for instant: Date, track: AudioTrack, in directory: URL, writing scratch: URL? = nil) -> String {
        let base = UTCInstant.basic(instant)
        var stem = "\(base).\(track.rawValue)"
        var attempt = 2
        let manager = FileManager.default
        while [audioName(stem), sidecarName(stem), openName(stem), audioName(stem) + tornSuffix]
            .contains(where: { manager.fileExists(atPath: directory.appendingPathComponent($0).path) })
            || scratch.map({ manager.fileExists(atPath: $0.appendingPathComponent(audioName(stem)).path) }) == true {
            stem = "\(base).\(track.rawValue)-\(attempt)"
            attempt += 1
        }
        return stem
    }

    public static func instant(ofStem stem: String) -> Date? {
        UTCInstant.date(basic: String(stem.prefix(20)))
    }
}
