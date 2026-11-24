import CoreGraphics
import CryptoKit
import Foundation
import XCTest
import Evidence
@testable import Spool

class SpoolFormatTests: SpoolFormCase {

    private func frame() -> RawFrame {
        let width = 64, height = 48
        var bytes = Data(repeating: 90, count: width * height * 4)
        for index in stride(from: 3, to: bytes.count, by: 4) { bytes[index] = 255 }
        return RawFrame(layout: FrameLayout(width: width, height: height, bytesPerRow: width * 4,
            bitmapInfo: SegmentCodec.bitmap, renderingIntent: 0,
            ICCData: CGColorSpace(name: CGColorSpace.sRGB)!.copyICCData()! as Data), data: bytes)
    }

    private func fullObservation() -> CaptureObservation {
        let app = CaptureApplication(bundleID: "com.example.editor", name: "Example Editor", pid: 4242)
        var observation = CaptureObservation(capturedAt: Date(timeIntervalSince1970: 1_700_000_000.123),
            displayID: 7, width: 64, height: 48, application: app,
            windows: [CaptureWindow(windowID: 11, title: "Synthetic window", application: app,
                                    bounds: CaptureRect(x: 0, y: 25, width: 640, height: 455))],
            ocr: [TextObservation(text: "SYNTHETIC TEXT", confidence: 0.5,
                                  bounds: CaptureRect(x: 0.25, y: 0.5, width: 0.25, height: 0.125))],
            reason: "foreground-pid-matched-around-image-acquisition; non-atomic-observation",
            capturedUntil: Date(timeIntervalSince1970: 1_700_000_000.456),
            displayBounds: CaptureRect(x: 0, y: 0, width: 640, height: 480), ocrStatus: "reused-exact-image")
        var accessibility = AccessibilitySnapshot(capturedAt: Date(timeIntervalSince1970: 1_700_000_000.2),
            status: "complete-scoped-app-reported",
            nodes: [AccessibilityNode(role: "AXWindow", text: "Synthetic window", bounds: CaptureRect(x: 0, y: 25, width: 640, height: 455),
                                      depth: 0, subrole: "AXStandardWindow", title: "Synthetic window", description: nil, value: nil,
                                      enabled: true, visible: true, focused: true, selected: false, expanded: nil, checked: nil),
                    AccessibilityNode(role: "AXWebArea", text: "Synthetic page", bounds: CaptureRect(x: 0, y: 60, width: 640, height: 420),
                                      depth: 1, title: "Synthetic page", url: "https://example.com/synthetic")],
            capturedUntil: Date(timeIntervalSince1970: 1_700_000_000.3))
        accessibility.targetWindowID = 11
        accessibility.targetWindowBounds = CaptureRect(x: 0, y: 25, width: 640, height: 455)
        accessibility.windowCorrelation = "unique-pid-and-window-geometry"
        accessibility.limitReasons = []
        accessibility.visitedElements = 1
        observation.accessibility = accessibility
        observation.displaySelection = CaptureDisplaySelection(policy: "relevant-display",
            reason: "foreground-window-midpoint", availableCount: 2)
        observation.inputIdleSeconds = 1.5
        observation.acquisition = CaptureAcquisition(backend: "screenshot",
            receivedAt: Date(timeIntervalSince1970: 1_700_000_000.4), freshness: "screenshot-request-completed")
        observation.ocrScope = CaptureOCRScope(requested: "display", effective: "display", focusedPID: 4242)
        observation.scaling = CaptureScaling.plan(width: 1280, height: 960, maximumHeight: 1440, maximumDimension: 4096)
        return observation
    }

    private static let fullObservationJSON = #"{"accessibility":{"capturedAt":1700000000200,"capturedUntil":1700000000300,"limitReasons":[],"nodes":[{"bounds":{"height":455,"width":640,"x":0,"y":25},"depth":0,"enabled":true,"focused":true,"role":"AXWindow","selected":false,"subrole":"AXStandardWindow","text":"Synthetic window","title":"Synthetic window","visible":true},{"bounds":{"height":420,"width":640,"x":0,"y":60},"depth":1,"role":"AXWebArea","text":"Synthetic page","title":"Synthetic page","url":"https:\/\/example.com\/synthetic"}],"status":"complete-scoped-app-reported","targetWindowBounds":{"height":455,"width":640,"x":0,"y":25},"targetWindowID":11,"visitedElements":1,"windowCorrelation":"unique-pid-and-window-geometry"},"acquisition":{"backend":"screenshot","freshness":"screenshot-request-completed","receivedAt":1700000000400},"application":{"bundleID":"com.example.editor","name":"Example Editor","pid":4242},"capturedAt":1700000000123,"capturedUntil":1700000000456,"displayBounds":{"height":480,"width":640,"x":0,"y":0},"displayID":7,"displaySelection":{"availableCount":2,"policy":"relevant-display","reason":"foreground-window-midpoint"},"height":48,"imageFile":"DAY/BUNDLE/image.open","inputIdleSeconds":1.5,"ocr":[{"bounds":{"height":0.125,"width":0.25,"x":0.25,"y":0.5},"confidence":0.5,"text":"SYNTHETIC TEXT"}],"ocrScope":{"effective":"display","focusedPID":4242,"requested":"display"},"ocrStatus":"reused-exact-image","reason":"foreground-pid-matched-around-image-acquisition; non-atomic-observation","scaling":{"maximumDimension":4096,"maximumHeight":1440,"nativeHeight":960,"nativeWidth":1280,"requestedHeight":960,"requestedWidth":1280},"status":"captured","width":64,"windows":[{"application":{"bundleID":"com.example.editor","name":"Example Editor","pid":4242},"bounds":{"height":455,"width":640,"x":0,"y":25},"title":"Synthetic window","windowID":11}]}"#

    func testAnImageObservationIsABundleOfAnOpenImageAndCompressedMetadata() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let stored = try store.append(observation: fullObservation(), image: .raw(frame()))
        let path = try XCTUnwrap(stored.imageFile)
        let parts = path.split(separator: "/").map(String.init)
        XCTAssertEqual(parts.count, 3)
        XCTAssertEqual(parts[0], "2023-11-14")
        XCTAssertNotNil(parts[1].range(of: #"^00001700000000123000-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#,
                                         options: .regularExpression), parts[1])
        XCTAssertEqual(parts[2], "image.open")
        let bundle = root.appendingPathComponent(parts[0]).appendingPathComponent(parts[1])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: bundle.path).sorted(),
                       ["image.open", "observation.lsm"])
        for name in ["observation.lsm", "image.open"] { try assertInForm(bundle.appendingPathComponent(name)) }
        let packet = try kept(bundle.appendingPathComponent("observation.lsm"))
        XCTAssertEqual(packet.prefix(8), Data("LSMETA01".utf8))
        let json = String(decoding: try MetadataCodec.decode(packet), as: UTF8.self)
            .replacingOccurrences(of: parts[0] + "\\/" + parts[1] + "\\/", with: "DAY/BUNDLE/")
        XCTAssertEqual(json, Self.fullObservationJSON)

        let opened = String(decoding: try kept(bundle.appendingPathComponent("image.open")), as: UTF8.self)
        let id = try XCTUnwrap((try JSONSerialization.jsonObject(with: Data(opened.utf8)) as? [String: Any])?["segment"] as? String)
        XCTAssertEqual(opened.replacingOccurrences(of: String(id), with: "SEGMENT"), #"{"ordinal":0,"segment":"SEGMENT"}"#)
        let segment = root.appendingPathComponent(".video/.open-" + id)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: segment.path).sorted(), ["format", "samples"])
        let format = String(decoding: try kept(segment.appendingPathComponent("format")), as: UTF8.self)
        let base64 = try XCTUnwrap((try JSONSerialization.jsonObject(with: Data(format.utf8)) as? [String: Any])?["extensions"] as? String)
        XCTAssertEqual(Data(base64Encoded: base64)?.prefix(8), Data("bplist00".utf8))
        let extensions = base64.replacingOccurrences(of: "/", with: "\\/")
        XCTAssertEqual(format.replacingOccurrences(of: String(extensions), with: "EXTENSIONS"),
                       #"{"displayID":7,"encoding":{"codec":"hevc-lossy-v1","colorSpace":"sRGB-converted","encodedHeight":48,"encodedWidth":64,"hardwareEncoder":true,"originalHeight":48,"originalWidth":64,"quality":0.65},"extensions":"EXTENSIONS","version":1}"#)

        for name in ["format", "samples"] { try assertInForm(segment.appendingPathComponent(name)) }
        let log = try kept(segment.appendingPathComponent("samples"))
        func word(_ offset: Int) -> Int { log[offset..<(offset + 4)].reversed().reduce(0) { $0 << 8 | Int($1) } }
        XCTAssertEqual(word(0), log.count - 4)
        XCTAssertEqual(word(4), 0)
        XCTAssertEqual(word(8), path.utf8.count)
        XCTAssertEqual(log[12..<(12 + path.utf8.count)], Data(path.utf8))
        let attachments = 12 + path.utf8.count
        XCTAssertEqual(log[(attachments + 4)..<(attachments + 12)], Data("bplist00".utf8))
        let sample = attachments + 4 + word(attachments)
        XCTAssertEqual(sample + 4 + word(sample) + 32, log.count)
        XCTAssertEqual(log.suffix(32), Data(SHA256.hash(data: log.dropLast(32))))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).sorted(),
                       [".text", ".video", ".writer.lock", "2023-11-14"],
                       "the writer makes .text/ when it opens the spool")
    }

    func testASegmentSetAsideIsKeptUnderItsDamagedName() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let stored = try store.append(observation: fullObservation(), image: .raw(frame()))
        let bundle = root.appendingPathComponent(try XCTUnwrap(stored.imageFile)).deletingLastPathComponent()
        let id = try SpoolJSON.decode(OpenImage.self, from: kept(bundle.appendingPathComponent("image.open"))).segment
        let open = root.appendingPathComponent(".video/.open-" + id)
        try keep(Data("synthetic garbage".utf8), at: open.appendingPathComponent("format"))
        let samples = try kept(open.appendingPathComponent("samples"))
        XCTAssertEqual(try VideoCompaction.compact(store: store, flush: true).imageCount, 0)
        let video = root.appendingPathComponent(".video")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: video.path), [".damaged-" + id])
        XCTAssertEqual(SpoolLayout.damagedPath(id: id), ".video/.damaged-" + id)
        let damaged = video.appendingPathComponent(".damaged-" + id)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: damaged.path), ["open"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: damaged.appendingPathComponent("open").path).sorted(),
                       ["format", "samples"])
        XCTAssertEqual(try kept(damaged.appendingPathComponent("open/format")), Data("synthetic garbage".utf8))
        XCTAssertEqual(try kept(damaged.appendingPathComponent("open/samples")), samples)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: bundle.path).sorted(), ["image.open", "observation.lsm"])
        XCTAssertEqual(try CaptureStore(directory: root, files: files, scratch: scratch, readOnly: true).read().map(\.imageFile), [stored.imageFile])
    }

    func testAFrameNoEncoderTakesIsAGapStatingWhy() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, observationDecoder: { try SpoolJSON.decode(CaptureObservation.self, from: $0) },
                                     makeEncoder: { _ in throw VideoArchiveError.hardwareUnavailable })
        XCTAssertThrowsError(try store.append(observation: fullObservation(), image: .raw(frame()))) { error in
            guard case CaptureStoreError.videoEncoderUnavailable = error else { return XCTFail("\(error)") }
        }
        XCTAssertEqual(CaptureGapReason.videoEncoderUnavailable.rawValue, "video-encoder-unavailable")
        XCTAssertFalse(CaptureGapReason.videoEncoderUnavailable.isExpectedWait)
        XCTAssertEqual(try store.status().recordCount, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".video").path))
    }

    func testAGapIsABundleOfMetadataAlone() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let gap = CaptureObservation(capturedAt: Date(timeIntervalSince1970: 1_700_000_000), displayID: 0,
                                     width: 0, height: 0, status: "gap", reason: "storage_backpressure")
        try store.append(observation: gap, image: nil)
        let day = root.appendingPathComponent("2023-11-14")
        let bundles = try FileManager.default.contentsOfDirectory(atPath: day.path)
        XCTAssertEqual(bundles.count, 1)
        let bundle = day.appendingPathComponent(bundles[0])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: bundle.path), ["observation.lsm"])
        let json = String(decoding: try MetadataCodec.decode(kept(bundle.appendingPathComponent("observation.lsm"))), as: UTF8.self)
        XCTAssertEqual(json, #"{"capturedAt":1700000000000,"displayID":0,"height":0,"ocr":[],"ocrStatus":"not-run","reason":"storage_backpressure","status":"gap","width":0,"windows":[]}"#)
    }

    func testAnActivityOnlyObservationIsABundleOfMetadataAlone() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let chat = CaptureApplication(bundleID: "com.example.chat", name: "Example Chat", pid: 4343)
        let editor = CaptureApplication(bundleID: "com.example.editor", name: "Example Editor", pid: 4242)
        let observation = CaptureObservation(capturedAt: Date(timeIntervalSince1970: 1_700_000_000.123), displayID: 0,
            width: 0, height: 0, application: chat,
            windows: [CaptureWindow(windowID: 12, title: nil, application: chat,
                                    bounds: CaptureRect(x: 0, y: 25, width: 640, height: 455)),
                      CaptureWindow(windowID: 11, title: "Synthetic window", application: editor,
                                    bounds: CaptureRect(x: 700, y: 25, width: 400, height: 300))],
            status: ObservationStatus.activityOnly.rawValue, reason: CaptureGapReason.foregroundAppActivityOnly.rawValue)
        try store.append(observation: observation, image: nil)
        let day = root.appendingPathComponent("2023-11-14")
        let bundles = try FileManager.default.contentsOfDirectory(atPath: day.path)
        XCTAssertEqual(bundles.count, 1)
        let bundle = day.appendingPathComponent(bundles[0])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: bundle.path), ["observation.lsm"])
        let json = String(decoding: try MetadataCodec.decode(kept(bundle.appendingPathComponent("observation.lsm"))), as: UTF8.self)
        XCTAssertEqual(json, #"{"application":{"bundleID":"com.example.chat","name":"Example Chat","pid":4343},"capturedAt":1700000000123,"displayID":0,"height":0,"ocr":[],"ocrStatus":"not-run","reason":"foreground-app-activity-only","status":"activity_only","width":0,"windows":[{"application":{"bundleID":"com.example.chat","name":"Example Chat","pid":4343},"bounds":{"height":455,"width":640,"x":0,"y":25},"windowID":12},{"application":{"bundleID":"com.example.editor","name":"Example Editor","pid":4242},"bounds":{"height":300,"width":400,"x":700,"y":25},"title":"Synthetic window","windowID":11}]}"#)
        XCTAssertEqual(try store.status().recordCount, 1)
    }

    func testAnActivitySiteObservationStatesTheHostAndEveryWindowItsSite() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let browser = CaptureApplication(bundleID: "com.example.browser", name: "Example Browser", pid: 4444)
        var observation = CaptureObservation(capturedAt: Date(timeIntervalSince1970: 1_700_000_000.123), displayID: 0,
            width: 0, height: 0, application: browser,
            windows: [CaptureWindow(windowID: 12, title: nil, application: browser,
                                    bounds: CaptureRect(x: 0, y: 25, width: 640, height: 455), site: "chat.example"),
                      CaptureWindow(windowID: 13, title: "Synthetic news", application: browser,
                                    bounds: CaptureRect(x: 700, y: 25, width: 400, height: 300), site: "news.example")],
            status: ObservationStatus.activityOnly.rawValue, reason: CaptureGapReason.foregroundSiteActivityOnly.rawValue)
        observation.site = "chat.example"
        try store.append(observation: observation, image: nil)
        let day = root.appendingPathComponent("2023-11-14")
        let bundle = day.appendingPathComponent(try XCTUnwrap(try FileManager.default.contentsOfDirectory(atPath: day.path).first))
        let json = String(decoding: try MetadataCodec.decode(kept(bundle.appendingPathComponent("observation.lsm"))), as: UTF8.self)
        XCTAssertEqual(json, #"{"application":{"bundleID":"com.example.browser","name":"Example Browser","pid":4444},"capturedAt":1700000000123,"displayID":0,"height":0,"ocr":[],"ocrStatus":"not-run","reason":"foreground-site-activity-only","site":"chat.example","status":"activity_only","width":0,"windows":[{"application":{"bundleID":"com.example.browser","name":"Example Browser","pid":4444},"bounds":{"height":455,"width":640,"x":0,"y":25},"site":"chat.example","windowID":12},{"application":{"bundleID":"com.example.browser","name":"Example Browser","pid":4444},"bounds":{"height":300,"width":400,"x":700,"y":25},"site":"news.example","title":"Synthetic news","windowID":13}]}"#)
    }

    func testAnExcludedPageIsABundleOfMetadataStatingItsReasonAndCause() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let at = Date(timeIntervalSince1970: 1_700_000_000.123)
        try store.append(observation: ForegroundPageGap(page: .unknown, cause: .walkDeadline).observation(at: at), image: nil)
        try store.append(observation: ForegroundPageGap(page: .privateWindow, cause: nil)
            .observation(at: at.addingTimeInterval(2)), image: nil)
        try store.append(observation: ForegroundPageGap(page: .site(Site(rule: "bank.example")!), cause: nil)
            .observation(at: at.addingTimeInterval(4)), image: nil)
        let day = root.appendingPathComponent("2023-11-14")
        let json = try FileManager.default.contentsOfDirectory(atPath: day.path).sorted().map { name in
            String(decoding: try MetadataCodec.decode(kept(day.appendingPathComponent(name)
                .appendingPathComponent("observation.lsm"))), as: UTF8.self)
        }
        XCTAssertEqual(json, [
            #"{"capturedAt":1700000000123,"displayID":0,"height":0,"ocr":[],"ocrStatus":"not-run","pageCause":"walk-deadline","reason":"foreground-page-unreadable","status":"excluded","width":0,"windows":[]}"#,
            #"{"capturedAt":1700000002123,"displayID":0,"height":0,"ocr":[],"ocrStatus":"not-run","reason":"foreground-private-window","status":"excluded","width":0,"windows":[]}"#,
            #"{"capturedAt":1700000004123,"displayID":0,"height":0,"ocr":[],"ocrStatus":"not-run","reason":"foreground-site-rule-excluded","status":"excluded","width":0,"windows":[]}"#,
        ])
    }

    func testAMissedDeadlineGapStatesTheOverrunningAttemptsSteps() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        var gap = CaptureObservation(capturedAt: Date(timeIntervalSince1970: 1_700_000_000.123), displayID: 0,
                                     width: 0, height: 0, status: "gap", reason: "capture-deadline-missed; count=1")
        gap.timings = CaptureTimings(wakeLateMs: 0, prepareMs: 11, screenshotMs: 22, pageCheckMs: 33, ocrMs: 3000,
                                     ocrTiles: 4, enrichMs: 3100, captureMs: 3500, publishMs: 10, statusMs: 4,
                                     attemptMs: 3514)
        try store.append(observation: gap, image: nil)
        let day = root.appendingPathComponent("2023-11-14")
        let bundle = day.appendingPathComponent(try XCTUnwrap(try FileManager.default.contentsOfDirectory(atPath: day.path).first))
        let json = String(decoding: try MetadataCodec.decode(kept(bundle.appendingPathComponent("observation.lsm"))), as: UTF8.self)
        XCTAssertEqual(json, #"{"capturedAt":1700000000123,"displayID":0,"height":0,"ocr":[],"ocrStatus":"not-run","reason":"capture-deadline-missed; count=1","status":"gap","timings":{"attemptMs":3514,"captureMs":3500,"enrichMs":3100,"ocrMs":3000,"ocrTiles":4,"pageCheckMs":33,"prepareMs":11,"publishMs":10,"screenshotMs":22,"statusMs":4,"wakeLateMs":0},"width":0,"windows":[]}"#)
    }

    func testTheFrontWindowStatesAnIDOrWhyItHasNone() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let chat = CaptureApplication(bundleID: "com.example.chat", name: "Example Chat", pid: 4343)
        let window = CaptureWindow(windowID: 12, title: nil, application: chat, bounds: CaptureRect(x: 0, y: 25, width: 640, height: 455))
        for (offset, front) in [CaptureFrontWindow(windowID: 12), CaptureFrontWindow(cause: .noFocusedWindow)].enumerated() {
            var observation = CaptureObservation(capturedAt: Date(timeIntervalSince1970: 1_700_000_000.123 + Double(offset) * 2),
                displayID: 0, width: 0, height: 0, application: chat, windows: [window],
                status: ObservationStatus.activityOnly.rawValue, reason: CaptureGapReason.foregroundAppActivityOnly.rawValue)
            observation.frontWindow = front
            try store.append(observation: observation, image: nil)
        }
        let day = root.appendingPathComponent("2023-11-14")
        let json = try FileManager.default.contentsOfDirectory(atPath: day.path).sorted().map { name in
            String(decoding: try MetadataCodec.decode(kept(day.appendingPathComponent(name)
                .appendingPathComponent("observation.lsm"))), as: UTF8.self)
        }
        XCTAssertEqual(json, [
            #"{"application":{"bundleID":"com.example.chat","name":"Example Chat","pid":4343},"capturedAt":1700000000123,"displayID":0,"frontWindow":{"windowID":12},"height":0,"ocr":[],"ocrStatus":"not-run","reason":"foreground-app-activity-only","status":"activity_only","width":0,"windows":[{"application":{"bundleID":"com.example.chat","name":"Example Chat","pid":4343},"bounds":{"height":455,"width":640,"x":0,"y":25},"windowID":12}]}"#,
            #"{"application":{"bundleID":"com.example.chat","name":"Example Chat","pid":4343},"capturedAt":1700000002123,"displayID":0,"frontWindow":{"cause":"no-focused-window"},"height":0,"ocr":[],"ocrStatus":"not-run","reason":"foreground-app-activity-only","status":"activity_only","width":0,"windows":[{"application":{"bundleID":"com.example.chat","name":"Example Chat","pid":4343},"bounds":{"height":455,"width":640,"x":0,"y":25},"windowID":12}]}"#,
        ])
    }

    func testASecureInputGapStatesWhichFieldWithheldIt() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let at = Date(timeIntervalSince1970: 1_700_000_000.123)
        for (offset, reason) in [CaptureGapReason.secureFieldFocused, .secureFieldInFrontWindow, .secureInputEnabled].enumerated() {
            try store.append(observation: .gap(at: at.addingTimeInterval(Double(offset) * 2), reason: reason.rawValue),
                             image: nil)
        }
        let day = root.appendingPathComponent("2023-11-14")
        let json = try FileManager.default.contentsOfDirectory(atPath: day.path).sorted().map { name in
            String(decoding: try MetadataCodec.decode(kept(day.appendingPathComponent(name)
                .appendingPathComponent("observation.lsm"))), as: UTF8.self)
        }
        XCTAssertEqual(json, [
            #"{"capturedAt":1700000000123,"displayID":0,"height":0,"ocr":[],"ocrStatus":"not-run","reason":"secure-field-focused","status":"gap","width":0,"windows":[]}"#,
            #"{"capturedAt":1700000002123,"displayID":0,"height":0,"ocr":[],"ocrStatus":"not-run","reason":"secure-field-in-front-window","status":"gap","width":0,"windows":[]}"#,
            #"{"capturedAt":1700000004123,"displayID":0,"height":0,"ocr":[],"ocrStatus":"not-run","reason":"secure-input-enabled","status":"gap","width":0,"windows":[]}"#,
        ])
    }

    func testFractionalCaptureInstantsAreTheFixtureTheHomeImports() throws {
        let instant = Date(timeIntervalSince1970: 1_790_848_157.303_890_9)
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        var gap = CaptureObservation(capturedAt: instant, displayID: 0, width: 0, height: 0, status: "gap",
                                     reason: "capture-deadline-missed; count=1")
        gap.capturedUntil = instant.addingTimeInterval(2.000_731_5)
        gap.timings = CaptureTimings(wakeLateMs: 0, prepareMs: 11, screenshotMs: 22, pageCheckMs: 33, ocrMs: 3000,
                                     ocrTiles: 4, enrichMs: 3100, captureMs: 3500, publishMs: 10, statusMs: 4,
                                     attemptMs: 3514)
        try store.append(observation: gap, image: nil)
        let day = root.appendingPathComponent("2026-10-01")
        let bundle = day.appendingPathComponent(try XCTUnwrap(try FileManager.default.contentsOfDirectory(atPath: day.path).first))
        let gapJSON = String(decoding: try MetadataCodec.decode(kept(bundle.appendingPathComponent("observation.lsm"))),
                             as: UTF8.self)

        let frames = try [(UInt32(1), 0.000_010_1), (UInt32(2), 0.000_090_3)].map { display, offset in
            var frame = fullObservation()
            frame.displayID = display
            frame.capturedAt = instant.addingTimeInterval(2.1 + offset)
            frame.capturedUntil = frame.capturedAt.addingTimeInterval(0.031_25)
            frame.accessibility?.capturedAt = frame.capturedAt.addingTimeInterval(0.040_2)
            frame.accessibility?.capturedUntil = frame.capturedAt.addingTimeInterval(0.090_7)
            frame.acquisition = CaptureAcquisition(backend: "screenshot", receivedAt: frame.capturedAt.addingTimeInterval(0.029_9),
                                                   freshness: "screenshot-request-completed")
            frame.site = "video.example"
            frame.frontWindow = CaptureFrontWindow(windowID: 11)
            frame.imageFile = "2026-10-01/00001790848159403000-00000000-0000-4000-8000-00000000000\(display)/image.lsf"
            return String(decoding: try SpoolJSON.encode(frame), as: UTF8.self)
        }
        let lines = ([gapJSON] + frames).map { $0 + "\n" }.joined()
        XCTAssertTrue(gapJSON.contains(#""capturedAt":1790848157303.89"#), gapJSON)

        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/connect/macos-app/screen/test/recorder-observations.jsonl")
        if ProcessInfo.processInfo.environment["LIFESTREAM_WRITE_FIXTURES"] == "1" {
            try FileManager.default.createDirectory(at: fixture.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(lines.utf8).write(to: fixture)
        }
        XCTAssertEqual(String(decoding: try Data(contentsOf: fixture), as: UTF8.self), lines,
                       "the encoder's spelling changed: rewrite the fixture and make the home read it")
    }

    func testAFrameIsReadFromAClosedMovieKeptInThisForm() throws {
        let writer = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        let stored = try writer.append(observation: fullObservation(), image: .raw(frame()))
        let report: VideoCompactionReport
        do {
            report = try VideoCompaction.compact(store: writer, flush: true)
        } catch VideoArchiveError.hardwareUnavailable {
            throw XCTSkip("Hardware HEVC encoder unavailable")
        }
        XCTAssertEqual(report.imageCount, 1)
        let bundle = root.appendingPathComponent(try XCTUnwrap(stored.imageFile)).deletingLastPathComponent()
        let movies = try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent(".video"), includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "mov" }
        XCTAssertEqual(movies.count, 1)
        let reads = [bundle.appendingPathComponent("observation.lsm"), bundle.appendingPathComponent("image.archive")] + movies
        for url in reads { try assertInForm(url) }

        let reader = try CaptureStore(directory: root, files: files, scratch: scratch, readOnly: true)
        let observation = try XCTUnwrap(reader.read().first)
        XCTAssertEqual(observation.imageEncoding?.codec, "hevc-lossy-v1")
        SpoolFixtures.assertPixels(try reader.readImage(for: observation), near: 90)
        XCTAssertTrue(scratchIsEmpty(), "the movie's plain copy is gone once the frame is read")
    }

    func testCompactionReplacesPendingPixelsWithAStableSidecarAndMovie() async throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 0.65)
        let stored = try store.append(observation: fullObservation(), image: .raw(frame()))
        _ = try await store.compactPendingVideo(flush: true)
        let bundle = root.appendingPathComponent(try XCTUnwrap(stored.imageFile)).deletingLastPathComponent()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: bundle.path).sorted(), ["image.archive", "observation.lsm"])
        let movies = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".video").path)
        XCTAssertEqual(movies.count, 1)
        XCTAssertNotNil(movies[0].range(of: #"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mov$"#, options: .regularExpression))
        let sidecar = String(decoding: try kept(bundle.appendingPathComponent("image.archive")), as: UTF8.self)
        let segment = ".video/" + movies[0]
        let redacted = sidecar.replacingOccurrences(of: stored.imageFile!.replacingOccurrences(of: "/", with: "\\/"), with: "IMAGE")
            .replacingOccurrences(of: segment.replacingOccurrences(of: "/", with: "\\/"), with: "SEGMENT")
            .replacingOccurrences(of: #""metadataSHA256":"[^"]+""#, with: #""metadataSHA256":"HASH""#, options: .regularExpression)
            .replacingOccurrences(of: #""segmentSHA256":"[^"]+""#, with: #""segmentSHA256":"HASH""#, options: .regularExpression)
        XCTAssertEqual(redacted, #"{"imagePath":"IMAGE","metadataSHA256":"HASH","reference":{"capturedAt":1700000000123,"encoding":{"codec":"hevc-lossy-v1","colorSpace":"sRGB-converted","encodedHeight":48,"encodedWidth":64,"hardwareEncoder":true,"originalHeight":48,"originalWidth":64,"quality":0.65},"frameCount":1,"ordinal":0,"segment":"SEGMENT","segmentSHA256":"HASH","version":1}}"#)
        let reread = try CaptureStore(directory: root, files: files, scratch: scratch, readOnly: true).read()
        XCTAssertEqual(reread.first?.imageEncoding?.codec, "hevc-lossy-v1")
    }

    func testTextCompactionWritesASegmentWhoseHeaderAndManifestArePinned() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 0.65)
        try store.append(observation: fullObservation(), image: nil)
        XCTAssertEqual(try TextCompaction.compact(store: store, now: Date(timeIntervalSince1970: 1_700_000_400)).segmentCount, 1)
        let text = root.appendingPathComponent(".text")
        let names = try FileManager.default.contentsOfDirectory(atPath: text.path).sorted()
        XCTAssertEqual(names.count, 3)
        let uuid = #"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"#
        XCTAssertEqual(names.map { $0.replacingOccurrences(of: uuid, with: "UUID", options: .regularExpression) },
                       ["UUID.json", "UUID.lstext", "position"])
        XCTAssertEqual(String(decoding: try kept(text.appendingPathComponent("position")), as: UTF8.self),
                       "1700000100000000", "the end of the window finished, in microseconds, digits alone")
        let body = try ScreenText.decompress(try kept(text.appendingPathComponent(names[1])))
        let header = String(decoding: body.prefix(through: try XCTUnwrap(body.firstIndex(of: 0x0A))), as: UTF8.self)
        let redact = { (text: String) in
            text.replacingOccurrences(of: uuid, with: "UUID", options: .regularExpression)
                .replacingOccurrences(of: #"\b[0-9a-f]{64}\b"#, with: "HEX", options: .regularExpression)
                .replacingOccurrences(of: #""segmentSHA256":"[^"]+""#, with: #""segmentSHA256":"HASH""#, options: .regularExpression)
        }
        XCTAssertEqual(redact(header), #"{"format":"org.lifestreamprotocol.screen-text/1","window":[1699999800000000,1700000100000000],"arrays":[[0,176],[176,100],[276,394]],"frames":[{"bundle":"2023-11-14/00001700000000123000-UUID","displayID":7,"observationSHA256":"HEX","splices":[{"at":1107,"before":",\"windows\":","array":0,"after":""},{"at":746,"before":",\"ocr\":","array":1,"after":""},{"at":92,"before":",\"nodes\":","array":2,"after":""}]}]}"# + "\n")
        XCTAssertEqual(redact(String(decoding: try kept(text.appendingPathComponent(names[0])), as: UTF8.self)),
                       #"{"segment":"UUID.lstext","segmentSHA256":"HASH","window":[1699999800000000,1700000100000000],"frames":[{"bundle":"2023-11-14/00001700000000123000-UUID","ordinal":0,"observationSHA256":"HEX"}],"frameCount":1}"#)
    }
}

final class SpoolFormatKeyedTests: SpoolFormatTests {
    override class var keyed: Bool { true }
}
