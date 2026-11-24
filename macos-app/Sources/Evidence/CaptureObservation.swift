import Foundation


public struct CaptureRect: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct CaptureApplication: Codable, Equatable, Sendable {
    public var bundleID: String?
    public var name: String?
    public var pid: Int32

    public init(bundleID: String?, name: String?, pid: Int32) {
        self.bundleID = bundleID
        self.name = name
        self.pid = pid
    }
}

public struct CaptureWindow: Codable, Equatable, Sendable {
    public var windowID: UInt32
    public var title: String?
    public var application: CaptureApplication?
    public var bounds: CaptureRect
    public var site: String?

    public init(windowID: UInt32, title: String?, application: CaptureApplication?, bounds: CaptureRect,
                site: String? = nil) {
        self.windowID = windowID
        self.title = title
        self.application = application
        self.bounds = bounds
        self.site = site
    }
}

public struct CaptureFrontWindow: Codable, Equatable, Sendable {
    public var windowID: UInt32?
    public var cause: String?

    public init(windowID: UInt32) {
        self.windowID = windowID
    }

    public init(cause: FrontWindowCause) {
        self.cause = cause.rawValue
    }
}

public enum FrontWindowCause: String, Sendable, CaseIterable {
    case noFocusedWindow = "no-focused-window"
    case focusedWindowUnreadable = "focused-window-unreadable"
    case windowNumberUnreadable = "window-number-unreadable"
    case notListed = "not-listed"
}

public struct TextObservation: Codable, Equatable, Sendable {
    public var text: String
    public var confidence: Float
    public var bounds: CaptureRect

    public init(text: String, confidence: Float, bounds: CaptureRect) {
        self.text = text
        self.confidence = confidence
        self.bounds = bounds
    }
}

public enum ObservationStatus: String, Sendable {
    case captured
    case gap
    case excluded
    case activityOnly = "activity_only"
}

public struct CaptureObservation: Codable, Equatable, Sendable {
    public var capturedAt: Date
    public var displayID: UInt32
    public var width: Int
    public var height: Int
    public var application: CaptureApplication?
    public var windows: [CaptureWindow]
    public var ocr: [TextObservation]
    public var accessibility: AccessibilitySnapshot?
    public var status: String
    public var reason: String?
    public var imageFile: String?
    public var imageEncoding: CaptureVideoProvenance?
    public var capturedUntil: Date?
    public var displayBounds: CaptureRect?
    public var displaySelection: CaptureDisplaySelection?
    public var ocrStatus: String
    public var inputIdleSeconds: Double?
    public var acquisition: CaptureAcquisition?
    public var ocrScope: CaptureOCRScope?
    public var scaling: CaptureScaling?
    public var site: String?
    public var pageCause: String?
    public var timings: CaptureTimings?
    public var frontWindow: CaptureFrontWindow?

    public init(
        capturedAt: Date,
        displayID: UInt32,
        width: Int,
        height: Int,
        application: CaptureApplication? = nil,
        windows: [CaptureWindow] = [],
        ocr: [TextObservation] = [],
        accessibility: AccessibilitySnapshot? = nil,
        status: String = "captured",
        reason: String? = nil,
        imageFile: String? = nil,
        capturedUntil: Date? = nil,
        displayBounds: CaptureRect? = nil,
        ocrStatus: String? = nil
    ) {
        self.capturedAt = capturedAt
        self.displayID = displayID
        self.width = width
        self.height = height
        self.application = application
        self.windows = windows
        self.ocr = ocr
        self.accessibility = accessibility
        self.status = status
        self.reason = reason
        self.imageFile = imageFile
        self.capturedUntil = capturedUntil
        self.displayBounds = displayBounds
        self.ocrStatus = ocrStatus ?? (status == "captured" ? "complete" : "not-run")
    }

    public static func gap(
        at date: Date,
        displayID: UInt32 = 0,
        reason: String,
        status: ObservationStatus = .gap
    ) -> CaptureObservation {
        CaptureObservation(
            capturedAt: date,
            displayID: displayID,
            width: 0,
            height: 0,
            status: status.rawValue,
            reason: reason
        )
    }
}

public struct CaptureResult: Equatable, Sendable {
    public var observation: CaptureObservation
    public let image: CaptureImage?

    public init(observation: CaptureObservation, image: CaptureImage?) {
        self.observation = observation
        self.image = image
    }
}

public enum CaptureAttempt {
    case done([CaptureResult])
    case recognizing(timings: CaptureTimings?, finish: @MainActor () async -> [CaptureResult])
}
