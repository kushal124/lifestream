import Cockpit
import ImageIO
import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct NoteAttachmentStrip: View {
    let attachments: [NoteAttachment]
    let urlForAttachment: (NoteAttachment) -> URL
    let onRemove: (NoteAttachment) -> Void
    @ScaledMetric(relativeTo: .body) private var thumbnailSize: CGFloat = 96

    @State private var previewing: IdentifiedURL?

    var body: some View {
        if !attachments.isEmpty {
            VStack(spacing: 0) {
                Rectangle()
                    .fill(Cockpit.Color.rule)
                    .frame(height: Cockpit.Stroke.border)
                strip
            }
            .sheet(item: $previewing) { item in
                QuickLookPreview(url: item.url)
            }
        }
    }

    private var strip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Cockpit.Space.s3) {
                    ForEach(attachments, id: \.id) { attachment in
                        Button {
                            previewing = IdentifiedURL(id: attachment.id, url: urlForAttachment(attachment))
                        } label: {
                            attachmentCard(attachment)
                        }
                        .contextMenu {
                            Button("Open") {
                                previewing = IdentifiedURL(
                                    id: attachment.id,
                                    url: urlForAttachment(attachment)
                                )
                            }
                            Button("Remove", role: .destructive) { onRemove(attachment) }
                        }
                        .accessibilityIdentifier(
                            "notes.attachment.\(attachment.id.uuidString.lowercased())"
                        )
                        .accessibilityLabel(attachment.filename)
                    }
                }
                .padding(.horizontal, Cockpit.Space.s5)
                .padding(.vertical, Cockpit.Space.s3)
        }
    }

    @ViewBuilder
    private func attachmentCard(_ attachment: NoteAttachment) -> some View {
        let url = urlForAttachment(attachment)
        let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.sm, style: .continuous)
        if UTType(attachment.uti)?.conforms(to: .image) == true {
            AttachmentThumbnail(url: url)
                .frame(width: thumbnailSize, height: thumbnailSize)
                .clipShape(shape)
                .overlay { shape.strokeBorder(Cockpit.Color.rule, lineWidth: Cockpit.Stroke.border) }
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Text(url.pathExtension.isEmpty ? "File" : url.pathExtension)
                    .cockpit(.monoLabel)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                Spacer(minLength: Cockpit.Space.s1)
                Text(attachment.filename)
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.text)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.byteCount), countStyle: .file))
                    .cockpit(.monoData)
                    .foregroundStyle(Cockpit.Color.textSecondary)
            }
            .padding(Cockpit.Space.s3)
            .frame(width: thumbnailSize * 1.5, height: thumbnailSize, alignment: .topLeading)
            .background(Cockpit.Color.raised, in: shape)
        }
    }
}

private struct AttachmentThumbnail: View {
    let url: URL
    @State private var thumbnail: UIImage?

    var body: some View {
        Group {
            if let thumbnail {
                Image(uiImage: thumbnail).resizable().scaledToFill()
            } else {
                Cockpit.Color.raised
            }
        }
        .task(id: url) {
            let image = await Task.detached(priority: .utility) {
                guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
                    return nil as CGImage?
                }
                return CGImageSourceCreateThumbnailAtIndex(
                    source, 0,
                    [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceThumbnailMaxPixelSize: 600,
                    ] as CFDictionary)
            }.value
            guard !Task.isCancelled else { return }
            thumbnail = image.map { UIImage(cgImage: $0) }
        }
    }
}

struct IdentifiedURL: Identifiable {
    let id: UUID
    let url: URL
}

struct QuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        context.coordinator.url = url
        controller.reloadData()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(url: url)
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL

        init(url: URL) {
            self.url = url
        }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(
            _ controller: QLPreviewController,
            previewItemAt index: Int
        ) -> any QLPreviewItem {
            url as NSURL
        }
    }
}

struct CameraPicker: UIViewControllerRepresentable {
    var onImage: (Data, String) -> Void
    var onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onImage: onImage, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        picker.allowsEditing = false
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let onImage: (Data, String) -> Void
        let onCancel: () -> Void

        init(onImage: @escaping (Data, String) -> Void, onCancel: @escaping () -> Void) {
            self.onImage = onImage
            self.onCancel = onCancel
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.originalImage] as? UIImage,
                let data = image.jpegData(compressionQuality: 0.9)
            {
                onImage(data, "photo.jpg")
            } else {
                onCancel()
            }
        }
    }
}
