import Foundation
import HomeLink
import LifestreamCaptureCore

extension CaptureStore {
    static func restored(root: URL, processInstanceID: UUID = UUID(), volume: Volume? = nil) async throws -> CaptureStore {
        let store = try CaptureStore(root: root, processInstanceID: processInstanceID, volume: volume)
        try await store.restore(Restore(pass: "p-restored", unit: "unit-0001"), pass: "p-restored")
        return store
    }
}
