import Foundation

enum SpoolLayout {
    static let writerLock = ".writer.lock"
    static let hiddenPrefix = "."
    static let stagingPrefix = ".pending-"

    static let metadata = "observation.lsm"

    enum ImageFile: String, CaseIterable {
        case open = "image.open"
    }

    static let archiveSidecar = "image.archive"
    static let archiveSidecarStaging = ".archive-reference-pending"

    static let videoDirectory = ".video"
    static let openSegmentPrefix = ".open-"
    static let openFormat = "format"
    static let openSamples = "samples"
    static let preparedMovie = "movie.mov"
    static let journalStaging = "journal.tmp"
    static let journal = "journal.json"
    static let damagedPrefix = ".damaged-"
    static let damagedOpen = "open"
    static let damagedPending = "pending"

    static let textDirectory = ".text"
    static let textPosition = "position"
    static let textPositionStaging = "position.tmp"
    static let maximumPositionBytes = 32
    static let preparedTextSegment = "segment.lstext"
    static let preparedManifest = "manifest.json"
    static let maximumManifestBytes = 16 * 1024 * 1024

    static let maximumSidecarBytes = 32 * 1024
    static let maximumJournalBytes = 1024 * 1024

    static let captureTimeLimit: TimeInterval = 253402300800

    private static let dayPattern = #"^\d{4}-\d{2}-\d{2}$"#
    private static let bundlePattern =
        #"^\d{20}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#
    private static let segmentPattern =
        #"^\.video/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mov$"#
    private static let uuidPattern = #"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#
    private static let manifestPattern =
        #"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$"#

    private static let dayFormatterLock = NSLock()
    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func dayName(for date: Date) -> String {
        dayFormatterLock.lock()
        defer { dayFormatterLock.unlock() }
        return dayFormatter.string(from: date)
    }

    static func isDayName(_ name: String) -> Bool {
        name.range(of: dayPattern, options: .regularExpression) != nil
    }

    static func bundleName(capturedAt: Date, id: UUID) -> String {
        let stamp = String(format: "%020.0f", capturedAt.timeIntervalSince1970 * 1_000_000)
        return stamp + "-" + id.uuidString.lowercased()
    }

    static func names(_ name: String, capturedAt: Date) -> Bool {
        guard let microseconds = indexedMicroseconds(ofBundle: name) else { return false }
        return abs(Double(microseconds) - (capturedAt.timeIntervalSince1970 * 1_000_000).rounded()) < 1000
    }

    static func indexedSeconds(ofBundle name: String) -> Double? {
        guard name.range(of: bundlePattern, options: .regularExpression) != nil,
              let microseconds = UInt64(name.prefix(20)) else {
            return nil
        }
        return Double(microseconds) / 1_000_000
    }

    static func indexedMicroseconds(ofBundle name: String) -> Int? {
        guard name.range(of: bundlePattern, options: .regularExpression) != nil,
              let microseconds = Int(name.prefix(20)) else {
            return nil
        }
        return microseconds
    }

    static func textSegmentName(id: String) -> String {
        id + ".lstext"
    }

    static func textManifestName(id: String) -> String {
        id + ".json"
    }

    static func textManifestID(_ name: String) -> String? {
        guard name.range(of: manifestPattern, options: .regularExpression) != nil else {
            return nil
        }
        return String(name.dropLast(5))
    }

    static func segmentPath(id: String) -> String {
        videoDirectory + "/" + id + ".mov"
    }

    static func openSegmentPath(id: String) -> String {
        videoDirectory + "/" + openSegmentPrefix + id
    }

    static func damagedPath(id: String) -> String {
        videoDirectory + "/" + damagedPrefix + id
    }

    static func openSegmentID(_ name: String) -> String? {
        guard name.hasPrefix(openSegmentPrefix) else {
            return nil
        }
        let id = String(name.dropFirst(openSegmentPrefix.count))
        return id.range(of: uuidPattern, options: .regularExpression) != nil ? id : nil
    }

    static func isSegmentPath(_ path: String) -> Bool {
        path.range(of: segmentPattern, options: .regularExpression) != nil
    }

    struct ImagePath {
        let day: String
        let bundle: String
        let file: ImageFile

        var relativePath: String {
            day + "/" + bundle + "/" + file.rawValue
        }

        static func parse(_ path: String) -> ImagePath? {
            let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            guard parts.count == 3,
                  parts[0].range(of: dayPattern, options: .regularExpression) != nil,
                  parts[1].range(of: bundlePattern, options: .regularExpression) != nil,
                  let file = ImageFile(rawValue: parts[2]) else {
                return nil
            }
            return ImagePath(day: parts[0], bundle: parts[1], file: file)
        }
    }
}
