import Foundation

public struct CaptureTimings: Codable, Equatable, Sendable {
    public var wakeLateMs: Int?
    public var prepareMs: Int?
    public var screenshotMs: Int?
    public var pageCheckMs: Int?
    public var ocrMs: Int?
    public var ocrTiles: Int?
    public var enrichMs: Int?
    public var captureMs: Int?
    public var publishMs: Int?
    public var statusMs: Int?
    public var attemptMs: Int?

    public init(wakeLateMs: Int? = nil, prepareMs: Int? = nil, screenshotMs: Int? = nil, pageCheckMs: Int? = nil,
                ocrMs: Int? = nil, ocrTiles: Int? = nil, enrichMs: Int? = nil, captureMs: Int? = nil,
                publishMs: Int? = nil, statusMs: Int? = nil, attemptMs: Int? = nil) {
        self.wakeLateMs = wakeLateMs
        self.prepareMs = prepareMs
        self.screenshotMs = screenshotMs
        self.pageCheckMs = pageCheckMs
        self.ocrMs = ocrMs
        self.ocrTiles = ocrTiles
        self.enrichMs = enrichMs
        self.captureMs = captureMs
        self.publishMs = publishMs
        self.statusMs = statusMs
        self.attemptMs = attemptMs
    }

    public mutating func merge(screen: CaptureTimings) {
        prepareMs = screen.prepareMs
        screenshotMs = screen.screenshotMs
        pageCheckMs = screen.pageCheckMs
        ocrMs = screen.ocrMs
        ocrTiles = screen.ocrTiles
        enrichMs = screen.enrichMs
    }

    public static func milliseconds(_ seconds: Double) -> Int {
        guard seconds.isFinite, seconds > 0 else { return 0 }
        return Int((seconds * 1000).rounded())
    }
}
