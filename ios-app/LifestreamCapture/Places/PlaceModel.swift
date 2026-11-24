import Foundation
import HomeLink
import LifestreamCaptureCore
import SwiftUI

@MainActor
final class PlacePhotosModel: ObservableObject {
    @Published private(set) var photos: [HomeLink.PlacePhoto] = []
    @Published private(set) var reading = true
    @Published private(set) var failure: LifeReader.Failure?
    private var next: String?
    private var etag: String?
    private var asking = false
    private var counting = false

    let slug: String
    private let life: LifeReader

    init(slug: String, life: LifeReader = AppRuntime.shared.life) {
        self.slug = slug
        self.life = life
    }

    func read() async {
        await page(after: nil)
    }

    func more() async {
        guard let next else { return }
        await page(after: next)
    }

    private func page(after: String?) async {
        guard !asking else { return }
        asking = true
        defer { asking = false }
        do {
            let first = after == nil
            if let page = try await life.placePhotos(slug: slug, after: after, etag: first ? etag : nil) {
                photos = first ? page.value.photos : photos + page.value.photos
                next = page.value.next
                if first {
                    etag = page.etag
                    counting = page.value.counting == true
                }
            }
            failure = nil
        } catch is CancellationError {
            return
        } catch {
            failure = error as? LifeReader.Failure ?? .refused(error.localizedDescription)
        }
        reading = counting
    }
}
