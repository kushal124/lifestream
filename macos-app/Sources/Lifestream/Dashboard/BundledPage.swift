import Foundation
import WebKit

final class BundledPage: NSObject, WKURLSchemeHandler {
    static let scheme = "lifestream-app"
    static let host = "page"
    static let iconHost = "icon"

    static let named = [
        "/marked.js": "dashboard/node_modules/marked/lib/marked.esm.js",
        "/purify.js": "dashboard/node_modules/dompurify/dist/purify.es.mjs",
        "/cockpit.css": "design/css/cockpit.css",
        "/kit.css": "design/css/kit.css",
        "/icons.json": "design/icons.json",
        "/geist.woff2": "design/river/geist.woff2",
    ]
    static let security = [
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: lifestream-app:; media-src 'self' blob:; connect-src 'self' https://tiles.openfreemap.org; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    ]
    static let types = ["html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css",
                        "svg": "image/svg+xml", "json": "application/json", "webp": "image/webp", "woff2": "font/woff2"]

    let release: URL
    let dashboard: URL
    private let viewerKey: () -> String?
    private lazy var session = URLSession(configuration: .ephemeral, delegate: Relay(self), delegateQueue: .main)
    private var relayed: [ObjectIdentifier: (page: any WKURLSchemeTask, task: URLSessionDataTask)] = [:]

    init(release: URL? = BundledRelease.inApp()?.folder, dashboard: URL, viewerKey: @escaping () -> String? = { ViewerKey.held() }) {
        self.release = Self.folder(release)
        self.dashboard = dashboard
        self.viewerKey = viewerKey
    }

    nonisolated static func folder(_ release: URL? = BundledRelease.inApp()?.folder) -> URL {
        release ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    func file(_ path: String) -> (url: URL, type: String)? {
        if let named = Self.named[path] {
            let url = release.appendingPathComponent(named)
            return Self.types[url.pathExtension].map { (url, $0) }
        }
        let relative = path == "/" ? "index.html" : String(path.dropFirst())
        let segments = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard !relative.isEmpty, !relative.contains("\0"), !segments.contains(where: { $0.isEmpty || $0.hasPrefix(".") }) else { return nil }
        let root = release.appendingPathComponent("dashboard/public").standardizedFileURL
        let url = root.appendingPathComponent(relative).standardizedFileURL
        guard url.path.hasPrefix(root.path + "/"), let type = Self.types[url.pathExtension] else { return nil }
        return (url, type)
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
        if url.host == Self.iconHost {
            let id = String(url.path.dropFirst()).removingPercentEncoding ?? ""
            guard let png = Detection.iconPNG(id) else {
                return answer(task, url, status: 404, type: "text/plain", body: Data("No icon".utf8))
            }
            return answer(task, url, status: 200, type: "image/png", body: png)
        }
        guard url.host == Self.host else { return answer(task, url, status: 404, type: "text/plain", body: Data("Not found".utf8)) }
        if url.path.hasPrefix("/api/") { return relay(task, url) }
        guard let (file, type) = file(url.path), let body = try? Data(contentsOf: file) else {
            return answer(task, url, status: 404, type: "text/plain", body: Data("Not found".utf8))
        }
        answer(task, url, status: 200, type: type, body: body)
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        relayed.removeValue(forKey: ObjectIdentifier(task))?.task.cancel()
    }

    private func answer(_ task: any WKURLSchemeTask, _ url: URL, status: Int, type: String, body: Data) {
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: Self.security.merging(["Content-Type": type]) { $1 })!
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }

    private func relay(_ page: any WKURLSchemeTask, _ url: URL) {
        var parts = URLComponents(url: dashboard, resolvingAgainstBaseURL: false)!
        parts.path = url.path
        parts.percentEncodedQuery = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery
        var request = URLRequest(url: parts.url!)
        request.httpMethod = page.request.httpMethod
        for (field, value) in page.request.allHTTPHeaderFields ?? [:]
        where !["origin", "host", "referer", "cookie", ViewerKey.header.lowercased()].contains(field.lowercased()) {
            request.setValue(value, forHTTPHeaderField: field)
        }
        if let key = viewerKey() { request.setValue(key, forHTTPHeaderField: ViewerKey.header) }
        request.httpBody = page.request.httpBody ?? page.request.httpBodyStream.map(Self.read)
        let task = session.dataTask(with: request)
        relayed[ObjectIdentifier(page)] = (page, task)
        task.resume()
    }

    private static func read(_ stream: InputStream) -> Data {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16_384)
        stream.open()
        defer { stream.close() }
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }

    private func page(of task: URLSessionTask) -> (any WKURLSchemeTask)? {
        relayed.values.first { $0.task === task }?.page
    }

    fileprivate func received(_ response: URLResponse, for task: URLSessionTask) {
        guard let page = page(of: task) else { return }
        let headers = (response as? HTTPURLResponse)?.allHeaderFields as? [String: String] ?? [:]
        page.didReceive(HTTPURLResponse(url: page.request.url!, statusCode: (response as? HTTPURLResponse)?.statusCode ?? 200,
                                        httpVersion: "HTTP/1.1", headerFields: headers)!)
    }

    fileprivate func received(_ data: Data, for task: URLSessionTask) {
        page(of: task)?.didReceive(data)
    }

    fileprivate func ended(_ task: URLSessionTask, _ error: Error?) {
        guard let page = page(of: task) else { return }
        relayed.removeValue(forKey: ObjectIdentifier(page))
        if task.response != nil {
            if let error { page.didFailWithError(error) } else { page.didFinish() }
            return
        }
        answer(page, page.request.url!, status: 503, type: "application/json",
               body: Data(#"{"error":"Lifestream is not running yet."}"#.utf8))
    }
}

private final class Relay: NSObject, URLSessionDataDelegate {
    weak var page: BundledPage?

    init(_ page: BundledPage) { self.page = page }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        MainActor.assumeIsolated { page?.received(response, for: dataTask) }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        MainActor.assumeIsolated { page?.received(data, for: dataTask) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        MainActor.assumeIsolated { page?.ended(task, error) }
    }
}
