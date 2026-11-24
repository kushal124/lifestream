import Cockpit
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

enum AskPick: String, Identifiable {
    case library, camera, file
    var id: String { rawValue }

    struct Picked {
        let data: Data
        let ext: String
    }

    @MainActor static func synthetic(_ pick: AskPick) -> [Picked] {
        func scene(_ n: Int) -> Picked? {
            StandInPhoto.image(n, size: 1200, height: 900).flatMap { UIImage(cgImage: $0).jpegData(compressionQuality: 0.9) }
                .map { Picked(data: $0, ext: "jpg") }
        }
        switch pick {
        case .library: return [scene(1), scene(2)].compactMap { $0 }
        case .camera: return [scene(3)].compactMap { $0 }
        case .file:
            files += 1
            if files == 1 { return [Picked(data: Data([0xFF, 0xD8, 0xFF, 0xE0]) + Data(repeating: 0x5A, count: 4_000), ext: "jpg")] }
            guard let large = scene(4) else { return [] }
            return [Picked(data: large.data + Data(count: 26 * 1024 * 1024), ext: "jpg")]
        }
    }

    @MainActor private static var files = 0
}

struct LibraryPicker: UIViewControllerRepresentable {
    let limit: Int
    let picked: ([AskPick.Picked]) -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.filter = .images
        configuration.selectionLimit = max(1, limit)
        configuration.preferredAssetRepresentationMode = .current
        configuration.selection = .ordered
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(picked: picked) }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let picked: ([AskPick.Picked]) -> Void

        init(picked: @escaping ([AskPick.Picked]) -> Void) { self.picked = picked }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            let providers = results.map(\.itemProvider)
            let picked = picked
            Task { @MainActor in
                var all: [AskPick.Picked] = []
                for provider in providers {
                    if let one = await Self.read(provider) { all.append(one) }
                }
                picked(all)
            }
        }

        private static func read(_ provider: NSItemProvider) async -> AskPick.Picked? {
            guard let type = provider.registeredTypeIdentifiers.compactMap(UTType.init).first(where: { $0.conforms(to: .image) }) else { return nil }
            return await withCheckedContinuation { continuation in
                _ = provider.loadFileRepresentation(for: type) { url, _, _ in
                    let data = url.flatMap { try? Data(contentsOf: $0) }
                    continuation.resume(returning: data.map { AskPick.Picked(data: $0, ext: type.preferredFilenameExtension ?? "jpg") })
                }
            }
        }
    }
}

struct ImageFilePicker: UIViewControllerRepresentable {
    let picked: ([AskPick.Picked]) -> Void

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.image], asCopy: true)
        picker.allowsMultipleSelection = true
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(picked: picked) }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let picked: ([AskPick.Picked]) -> Void

        init(picked: @escaping ([AskPick.Picked]) -> Void) { self.picked = picked }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            picked(urls.compactMap { url in (try? Data(contentsOf: url)).map { AskPick.Picked(data: $0, ext: url.pathExtension.isEmpty ? "jpg" : url.pathExtension) } })
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            picked([])
        }
    }
}

extension View {
    func askPickers(_ pick: Binding<AskPick?>, limit: Int, picked: @escaping ([AskPick.Picked]) -> Void) -> some View {
        let library = Binding<Bool>(get: { pick.wrappedValue == .library }, set: { if !$0 { pick.wrappedValue = nil } })
        let file = Binding<Bool>(get: { pick.wrappedValue == .file }, set: { if !$0 { pick.wrappedValue = nil } })
        let camera = Binding<Bool>(get: { pick.wrappedValue == .camera }, set: { if !$0 { pick.wrappedValue = nil } })
        return sheet(isPresented: library) {
            LibraryPicker(limit: limit) { picked($0); pick.wrappedValue = nil }.ignoresSafeArea()
        }
        .sheet(isPresented: file) {
            ImageFilePicker { picked($0); pick.wrappedValue = nil }.ignoresSafeArea()
        }
        .fullScreenCover(isPresented: camera) {
            CameraPicker(onImage: { data, _ in picked([AskPick.Picked(data: data, ext: "jpg")]); pick.wrappedValue = nil },
                         onCancel: { pick.wrappedValue = nil })
                .ignoresSafeArea()
        }
    }
}
