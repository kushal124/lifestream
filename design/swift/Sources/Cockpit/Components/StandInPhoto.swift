import CoreGraphics
import Foundation
import SwiftUI

public enum StandInPhoto {
    public static let scenes = 8

    public enum Scene: Int, CaseIterable, Sendable {
        case face, cafe, plate, dusk, park, window, sea, coffee
    }

    public static func image(_ seed: Int, size: Int = 192, height: Int? = nil) -> CGImage? {
        let key = Key(seed: wrap(seed), width: size, height: height ?? size)
        if let drawn = cache.withLock({ $0[key] }) { return drawn }
        let bytes = pixels(seed, size: key.width, height: key.height)
        guard let provider = CGDataProvider(data: Data(bytes) as CFData),
              let image = CGImage(width: key.width, height: key.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: key.width * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider,
                                  decode: nil, shouldInterpolate: true, intent: .defaultIntent)
        else { return nil }
        cache.withLock { $0[key] = image }
        return image
    }

    public static func pixels(_ seed: Int, size: Int = 192, height: Int? = nil) -> [UInt8] {
        let paint = painters[wrap(seed)]
        let width = size, height = height ?? size
        let side = Double(min(width, height))
        var out = [UInt8](repeating: 255, count: width * height * 4)
        for row in 0..<height {
            for column in 0..<width {
                let x = (Double(column) + 0.5 - Double(width - min(width, height)) / 2) / side
                let y = (Double(row) + 0.5 - Double(height - min(width, height)) / 2) / side
                let c = paint(x, y)
                let vignette = 1 - 0.28 * smooth(0.35, 0.8, hypot(x - 0.5, y - 0.5))
                let grain = (hash(Double(column), Double(row), Double(wrap(seed))) - 0.5) * 7
                let at = (row * width + column) * 4
                out[at] = clamp(c.0 * vignette + grain)
                out[at + 1] = clamp(c.1 * vignette + grain)
                out[at + 2] = clamp(c.2 * vignette + grain)
            }
        }
        return out
    }

    private struct Key: Hashable {
        let seed: Int
        let width: Int
        let height: Int
    }

    private static let cache = Locked<[Key: CGImage]>([:])

    private static func wrap(_ seed: Int) -> Int { ((seed % scenes) + scenes) % scenes }

    private static func clamp(_ value: Double) -> UInt8 { UInt8(max(0, min(255, value.rounded()))) }


    private typealias RGB = (Double, Double, Double)

    private static func smooth(_ e0: Double, _ e1: Double, _ x: Double) -> Double {
        let t = min(1, max(0, (x - e0) / (e1 - e0)))
        return t * t * (3 - 2 * t)
    }

    private static func mix(_ a: RGB, _ b: RGB, _ t: Double) -> RGB {
        (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t, a.2 + (b.2 - a.2) * t)
    }

    private static func disc(_ x: Double, _ y: Double, _ cx: Double, _ cy: Double, _ r: Double, _ soft: Double = 0.01) -> Double {
        1 - smooth(r - soft, r + soft, hypot(x - cx, y - cy))
    }

    private static func oval(_ x: Double, _ y: Double, _ cx: Double, _ cy: Double, _ rx: Double, _ ry: Double,
                             _ soft: Double = 0.01) -> Double {
        1 - smooth(1 - soft / rx, 1 + soft / rx, hypot((x - cx) / rx, (y - cy) / ry))
    }

    private static func box(_ x: Double, _ y: Double, _ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double,
                            _ soft: Double = 0.004) -> Double {
        smooth(x0 - soft, x0 + soft, x) * (1 - smooth(x1 - soft, x1 + soft, x)) * smooth(y0 - soft, y0 + soft, y)
            * (1 - smooth(y1 - soft, y1 + soft, y))
    }

    private static func hash(_ x: Double, _ y: Double, _ seed: Double) -> Double {
        let s = sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453
        return s - floor(s)
    }

    private static let painters: [@Sendable (Double, Double) -> RGB] = [
        { x, y in
            var c = mix((150, 132, 116), (86, 74, 66), smooth(0, 1, (x + y) / 2))
            c = mix(c, mix((62, 70, 84), (40, 46, 58), x), oval(x, y, 0.5, 1.08, 0.46, 0.34, 0.02))
            c = mix(c, (176, 136, 112), (1 - smooth(0.1, 0.13, abs(x - 0.5))) * box(x, y, 0, 0.6, 1, 0.78, 0.02))
            let light = smooth(0.7, 0, hypot(x - 0.38, y - 0.34))
            c = mix(c, mix((150, 108, 86), (214, 170, 140), light), oval(x, y, 0.5, 0.44, 0.19, 0.24, 0.015))
            c = mix(c, (58, 44, 38), oval(x, y, 0.5, 0.36, 0.215, 0.17, 0.02) * (1 - smooth(0.32, 0.4, y + abs(x - 0.5) * 0.25)))
            return c
        },
        { x, y in
            var c = mix((58, 44, 36), (28, 22, 20), y)
            for (cx, cy, r, w) in [(0.2, 0.22, 0.09, 0.8), (0.52, 0.16, 0.06, 0.6), (0.78, 0.3, 0.11, 0.7), (0.36, 0.38, 0.05, 0.5),
                                   (0.9, 0.12, 0.05, 0.5)] {
                c = mix(c, (236, 186, 120), disc(x, y, cx, cy, r, 0.03) * w)
            }
            c = mix(c, mix((120, 90, 66), (84, 62, 46), (y - 0.62) * 2.6), smooth(0.62, 0.64, y))
            c = mix(c, (40, 30, 24), oval(x, y, 0.58, 0.9, 0.2, 0.04, 0.03) * 0.5)
            c = mix(c, (222, 216, 206), box(x, y, 0.45, 0.74, 0.67, 0.88, 0.006) * oval(x, y, 0.56, 0.74, 0.12, 0.16, 0.01))
            c = mix(c, (222, 216, 206), disc(x, y, 0.7, 0.79, 0.04, 0.006) * (1 - disc(x, y, 0.7, 0.79, 0.022, 0.006)))
            c = mix(c, (226, 222, 214), oval(x, y, 0.56, 0.74, 0.11, 0.03, 0.006))
            c = mix(c, (72, 44, 28), oval(x, y, 0.56, 0.742, 0.09, 0.02, 0.006))
            return c
        },
        { x, y in
            let grain = 0.5 + 0.5 * sin(y * 70 + sin(x * 9) * 2)
            var c = mix((132, 96, 64), (104, 74, 50), grain * 0.6)
            c = mix(c, (40, 30, 24), disc(x, y, 0.53, 0.53, 0.42, 0.06) * 0.35)
            c = mix(c, (232, 230, 226), disc(x, y, 0.5, 0.5, 0.38, 0.01))
            c = mix(c, (210, 208, 204), disc(x, y, 0.5, 0.5, 0.29, 0.01) * (1 - disc(x, y, 0.5, 0.5, 0.27, 0.01)))
            c = mix(c, (196, 150, 82), oval(x, y, 0.44, 0.46, 0.16, 0.11, 0.02))
            c = mix(c, (92, 132, 70), disc(x, y, 0.6, 0.58, 0.09, 0.02))
            c = mix(c, (176, 74, 52), disc(x, y, 0.4, 0.6, 0.05, 0.015))
            c = mix(c, (120, 156, 84), disc(x, y, 0.56, 0.38, 0.045, 0.015))
            return c
        },
        { x, y in
            var c = mix((44, 62, 96), (214, 140, 92), smooth(0.05, 0.62, y))
            let roofs = 0.3 + 0.12 * floor(abs(sin(floor(x * 7) * 12.9)) * 3) / 3
            let building = smooth(roofs - 0.004, roofs + 0.004, y)
            c = mix(c, (36, 34, 42), building)
            let lit = box((x * 14).truncatingRemainder(dividingBy: 1), (y * 18).truncatingRemainder(dividingBy: 1), 0.3, 0.3, 0.7, 0.75, 0.05)
                * (hash(floor(x * 14), floor(y * 18), 3) > 0.55 ? 1 : 0)
            c = mix(c, (232, 184, 112), lit * building * (1 - smooth(0.66, 0.68, y)) * 0.85)
            c = mix(c, mix((52, 50, 56), (30, 30, 34), (y - 0.7) * 3), smooth(0.69, 0.71, y))
            c = mix(c, (220, 200, 150), box(x, y, 0.46, 0.84, 0.54, 0.86, 0.01) * 0.6)
            return c
        },
        { x, y in
            var c = mix((168, 196, 220), (214, 222, 226), y * 1.6)
            let ground = smooth(0.56, 0.58, y)
            c = mix(c, mix((96, 128, 70), (64, 94, 52), (y - 0.56) * 2.2), ground)
            for (cx, cy, r) in [(0.18, 0.42, 0.18), (0.46, 0.36, 0.22), (0.8, 0.44, 0.17)] {
                let shade = smooth(0, r, hypot(x - cx + r * 0.3, y - cy + r * 0.3))
                c = mix(c, mix((92, 132, 74), (44, 70, 40), shade), disc(x, y, cx, cy, r, 0.02))
                c = mix(c, (66, 52, 40), box(x, y, cx - 0.012, cy + r * 0.7, cx + 0.012, 0.6, 0.004))
            }
            let path = 1 - smooth(0.06, 0.08, abs(x - 0.5 - (y - 0.58) * 0.9) - (y - 0.58) * 0.5)
            c = mix(c, (196, 186, 160), path * ground)
            return c
        },
        { x, y in
            var c = mix((92, 88, 84), (52, 50, 48), smooth(0, 1, hypot(x - 0.55, y - 0.4)))
            let pane = box(x, y, 0.3, 0.12, 0.84, 0.7, 0.01)
            c = mix(c, mix((236, 240, 238), (190, 204, 212), y), pane)
            c = mix(c, (70, 66, 62), pane * (box(x, y, 0.56, 0.12, 0.58, 0.7, 0.003) + box(x, y, 0.3, 0.4, 0.84, 0.42, 0.003)))
            c = mix(c, (150, 140, 128), box(x, y, 0.26, 0.7, 0.88, 0.74, 0.004))
            for (cx, cy, rx, ry) in [(0.4, 0.5, 0.06, 0.14), (0.47, 0.44, 0.05, 0.16), (0.34, 0.56, 0.07, 0.09), (0.5, 0.58, 0.06, 0.08)] {
                c = mix(c, (46, 70, 46), oval(x, y, cx, cy, rx, ry, 0.01))
            }
            c = mix(c, (168, 104, 78), box(x, y, 0.36, 0.62, 0.52, 0.72, 0.006))
            return c
        },
        { x, y in
            var c = mix((150, 178, 198), (222, 220, 210), smooth(0, 0.45, y))
            c = mix(c, (246, 230, 196), disc(x, y, 0.7, 0.3, 0.05, 0.03) * 0.8)
            c = mix(c, mix((70, 108, 128), (104, 146, 158), (y - 0.46) * 4), smooth(0.46, 0.465, y))
            let wave = sin(x * 9) * 0.02
            let foam = smooth(0.72 + wave, 0.74 + wave, y)
            c = mix(c, (236, 236, 228), foam * (1 - smooth(0.735, 0.75, y + wave)) * 0.8)
            c = mix(c, mix((210, 190, 156), (188, 166, 132), (y - 0.74) * 3), smooth(0.745, 0.755, y - wave))
            return c
        },
        { x, y in
            let vein = abs(sin(x * 6 + y * 3 + sin(y * 11) * 0.8))
            var c = mix((226, 224, 220), (200, 198, 194), smooth(0.97, 1, vein) * 0.5)
            c = mix(c, (150, 148, 144), disc(x, y, 0.56, 0.54, 0.3, 0.06) * 0.35)
            c = mix(c, (238, 236, 232), disc(x, y, 0.52, 0.5, 0.28, 0.008))
            c = mix(c, (238, 236, 232), box(x, y, 0.76, 0.46, 0.92, 0.54, 0.01))
            c = mix(c, (92, 58, 36), disc(x, y, 0.52, 0.5, 0.2, 0.008))
            c = mix(c, (196, 150, 106), disc(x, y, 0.52, 0.5, 0.13, 0.05) * 0.8)
            c = mix(c, (226, 196, 160), oval(x, y, 0.52, 0.5, 0.05, 0.08, 0.03) * 0.7)
            return c
        },
    ]
}

private final class Locked<Value>: @unchecked Sendable {
    private var value: Value
    private let lock = NSLock()

    init(_ value: Value) {
        self.value = value
    }

    func withLock<T>(_ body: (inout Value) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}
