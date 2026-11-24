import Foundation
import WebKit

enum DownloadNaming {
    static func sanitized(_ suggested: String) -> String {
        let last = suggested.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        var name = last.replacingOccurrences(of: ":", with: "-")
            .filter { !$0.isNewline && $0 != "\0" }
            .trimmingCharacters(in: .whitespaces)
        while name.hasPrefix(".") { name.removeFirst() }
        return name.isEmpty ? "download" : name
    }

    static func uniqueURL(in directory: URL, suggested: String, exists: (URL) -> Bool) -> URL {
        let name = sanitized(suggested)
        let ext = (name as NSString).pathExtension
        let stem = (name as NSString).deletingPathExtension
        var candidate = directory.appendingPathComponent(name)
        var number = 2
        while exists(candidate) {
            let numbered = "\(stem) \(number)" + (ext.isEmpty ? "" : ".\(ext)")
            candidate = directory.appendingPathComponent(numbered)
            number += 1
        }
        return candidate
    }
}

@MainActor final class DashboardDownloads: NSObject, WKDownloadDelegate {
    private var destinations: [ObjectIdentifier: URL] = [:]

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping @MainActor (URL?) -> Void) {
        let files = FileManager.default
        guard let folder = files.urls(for: .downloadsDirectory, in: .userDomainMask).first else {
            completionHandler(nil)
            return
        }
        let destination = DownloadNaming.uniqueURL(in: folder, suggested: suggestedFilename) {
            files.fileExists(atPath: $0.path)
        }
        destinations[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let destination = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([destination])
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        destinations.removeValue(forKey: ObjectIdentifier(download))
    }
}
