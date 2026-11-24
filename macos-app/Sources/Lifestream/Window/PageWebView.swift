import AppKit
import WebKit

final class PageWebView: WKWebView {
    private(set) var lastLeft: NSEvent?
    var takesFiles: @MainActor () -> (([URL]) -> Void)? = { nil }

    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        registerForDraggedTypes(Array(Set(registeredDraggedTypes + [.fileURL])))
    }

    @available(*, unavailable) required init?(coder: NSCoder) { nil }

    private func files(_ sender: any NSDraggingInfo) -> (urls: [URL], take: ([URL]) -> Void)? {
        guard let take = takesFiles(),
              let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
              !urls.isEmpty else { return nil }
        return (urls, take)
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        let page = super.draggingEntered(sender)
        return files(sender) != nil ? .copy : page
    }

    override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
        let page = super.draggingUpdated(sender)
        return files(sender) != nil ? .copy : page
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        guard let files = files(sender) else { return super.performDragOperation(sender) }
        super.draggingExited(sender)
        files.take(files.urls)
        return true
    }

    override func mouseDown(with event: NSEvent) {
        lastLeft = event
        super.mouseDown(with: event)
    }

    override func mouseDragged(with event: NSEvent) {
        lastLeft = event
        super.mouseDragged(with: event)
    }

    func perform(_ gesture: WindowGestures.Gesture) {
        guard let window else { return }
        switch gesture {
        case .drag:
            guard let event = lastLeft, WindowGestures.drags(event.type, pressed: NSEvent.pressedMouseButtons) else { return }
            window.performDrag(with: event)
        case .zoom:
            switch WindowGestures.doubleClick(UserDefaults.standard.string(forKey: WindowGestures.doubleClickKey)) {
            case .zoom: window.zoom(nil)
            case .miniaturize: window.miniaturize(nil)
            case .nothing: break
            }
        }
    }
}

enum WindowGestures {
    enum Gesture: String { case drag, zoom }

    static func asked(_ body: Any) -> Gesture? {
        guard let body = body as? [String: Any], body["type"] as? String == "act", body["act"] as? String == "window" else { return nil }
        return (body["do"] as? String).flatMap(Gesture.init(rawValue:))
    }

    enum DoubleClick: Equatable { case zoom, miniaturize, nothing }

    static let doubleClickKey = "AppleActionOnDoubleClick"

    static func drags(_ type: NSEvent.EventType, pressed buttons: Int) -> Bool {
        (type == .leftMouseDown || type == .leftMouseDragged) && buttons & 1 != 0
    }

    static func doubleClick(_ preference: String?) -> DoubleClick {
        switch preference {
        case "Minimize": return .miniaturize
        case "None": return .nothing
        default: return .zoom
        }
    }
}
