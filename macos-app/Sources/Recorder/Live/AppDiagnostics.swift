import DeviceFiles
import Evidence
import Foundation
@preconcurrency import MetricKit
import os

public final class AppDiagnostics: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    private static let log = Logger(subsystem: "org.lifestreamprotocol.screen-capture", category: "diagnostics")
    private static let prefix = "diagnostics-"
    private let folder: URL
    private let plain: DeviceFiles
    private let pruner: DayFiles.Pruner

    public init(directory: URL, plain: DeviceFiles) {
        folder = directory.appendingPathComponent(ResourceAccount.folderName, isDirectory: true)
        self.plain = plain
        pruner = DayFiles.Pruner(in: folder, prefixes: [Self.prefix])
        super.init()
    }

    public func start() {
        MXMetricManager.shared.add(self)
    }

    public func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            for hang in payload.hangDiagnostics ?? [] {
                let seconds = hang.hangDuration.converted(to: .seconds).value
                Self.log.notice("hang: \(seconds, format: .fixed(precision: 2), privacy: .public) s, build \(hang.metaData.applicationBuildVersion, privacy: .public)")
            }
            let line = payload.jsonRepresentation() + Data("\n".utf8)
            pruner.prune(at: Date())
            let file = folder.appendingPathComponent(DayFiles.name(Self.prefix, at: payload.timeStampEnd))
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let handle = try plain.log(file)
                defer { handle.close() }
                try handle.append(line, flush: nil)
            } catch {
                Self.log.error("diagnostics not written: \(error.localizedDescription, privacy: .public)")
            }
        }
    }
}
