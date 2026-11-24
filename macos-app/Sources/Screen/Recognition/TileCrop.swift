import CoreGraphics
import Evidence
import Foundation

struct TileCrop: Sendable {
    let tile: Tile
    let width: Int
    let height: Int
    let bitmapInfo: UInt32
    let renderingIntent: Int32
    let profile: Data
    let pixels: Data

    init(tile: Tile, width: Int, height: Int, bitmapInfo: UInt32, renderingIntent: Int32, profile: Data,
         pixels: Data) {
        self.tile = tile
        self.width = width
        self.height = height
        self.bitmapInfo = bitmapInfo
        self.renderingIntent = renderingIntent
        self.profile = profile
        self.pixels = pixels
    }

    init(_ frame: RawFrame, _ tile: Tile) {
        let left = Int(tile.crop.minX) * 4, length = Int(tile.crop.width) * 4
        var pixels = Data(count: length * Int(tile.crop.height))
        pixels.withUnsafeMutableBytes { out in
            frame.data.withUnsafeBytes { raw in
                for (row, y) in (Int(tile.crop.minY)..<Int(tile.crop.maxY)).enumerated() {
                    let start = y * frame.layout.bytesPerRow + left
                    out.baseAddress!.advanced(by: row * length)
                        .copyMemory(from: raw.baseAddress!.advanced(by: start), byteCount: length)
                }
            }
        }
        self.init(tile: tile, width: Int(tile.crop.width), height: Int(tile.crop.height),
                  bitmapInfo: frame.layout.bitmapInfo, renderingIntent: frame.layout.renderingIntent,
                  profile: frame.layout.ICCData, pixels: pixels)
    }

    func image() -> CGImage? {
        guard width > 0, height > 0, pixels.count == width * 4 * height,
              let space = CGColorSpace(iccData: profile as CFData),
              let intent = CGColorRenderingIntent(rawValue: renderingIntent),
              let provider = CGDataProvider(data: pixels as CFData) else { return nil }
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                       space: space, bitmapInfo: CGBitmapInfo(rawValue: bitmapInfo), provider: provider, decode: nil,
                       shouldInterpolate: false, intent: intent)
    }

    func recognize() -> [TextObservation]? {
        image().flatMap { VisionRecognizer.recognizeCrop($0, tile) }
    }
}
