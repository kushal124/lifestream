import Evidence
import DeviceFiles
import Foundation
import CryptoKit

struct ArchiveSidecar: Codable {
    let imagePath: String
    let metadataSHA256: Data
    let reference: SegmentReference

    static func published(in bundle: URL, for observation: CaptureObservation, files: DeviceFiles) throws -> SegmentReference? {
        let url = bundle.appendingPathComponent(SpoolLayout.archiveSidecar)
        guard try SpoolFiles.exists(url) else {
            return nil
        }
        let bytes = try SpoolFiles.read(files, url, maximumBytes: SpoolLayout.maximumSidecarBytes)
        let sidecar = try SpoolJSON.decode(ArchiveSidecar.self, from: bytes)
        try sidecar.reference.validate()
        guard sidecar.describes(observation), sidecar.metadataSHA256 == (try metadataSHA256(of: bundle, files: files)) else {
            throw VideoArchiveError.invalidReference
        }
        return sidecar.reference
    }

    func describes(_ observation: CaptureObservation) -> Bool {
        observation.imageFile == imagePath
            && observation.capturedAt == reference.capturedAt
            && observation.width == reference.encoding.originalWidth
            && observation.height == reference.encoding.originalHeight
    }

    private static func metadataSHA256(of bundle: URL, files: DeviceFiles) throws -> Data {
        let url = bundle.appendingPathComponent(SpoolLayout.metadata)
        return Data(SHA256.hash(data: try SpoolFiles.read(files, url, maximumBytes: MetadataCodec.maximumPacketBytes)))
    }
}
