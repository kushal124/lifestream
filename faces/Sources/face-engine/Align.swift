import Foundation

struct AlignedFace {
    let pixels: [UInt8]

    static let side = 112
    static let template: [(Double, Double)] = [
        (38.2946, 51.6963), (73.5318, 51.5014), (56.0252, 71.7366), (41.5493, 92.3655), (70.7299, 92.2041),
    ]

    init(_ picture: Picture, landmarks: [[Double]]) {
        let n = Double(landmarks.count)
        let sx = landmarks.map { $0[0] }.reduce(0, +) / n, sy = landmarks.map { $0[1] }.reduce(0, +) / n
        let dx = Self.template.map { $0.0 }.reduce(0, +) / n, dy = Self.template.map { $0.1 }.reduce(0, +) / n
        var a = 0.0, b = 0.0, norm = 0.0
        for (point, target) in zip(landmarks, Self.template) {
            let x = point[0] - sx, y = point[1] - sy, u = target.0 - dx, v = target.1 - dy
            a += x * u + y * v
            b += x * v - y * u
            norm += x * x + y * y
        }
        a /= max(norm, 1e-12)
        b /= max(norm, 1e-12)
        let tx = dx - (a * sx - b * sy), ty = dy - (b * sx + a * sy)
        let det = a * a + b * b
        let ia = a / max(det, 1e-12), ib = -b / max(det, 1e-12)
        var pixels = [UInt8](repeating: 0, count: Self.side * Self.side * 3)
        for y in 0..<Self.side {
            for x in 0..<Self.side {
                let px = Double(x) - tx, py = Double(y) - ty
                let fx = ((ia * px - ib * py) * 32).rounded(), fy = ((ib * px + ia * py) * 32).rounded()
                guard abs(fx) < 1e9, abs(fy) < 1e9 else { continue }
                let qx = Int(fx), qy = Int(fy)
                let x0 = qx >> 5, y0 = qy >> 5
                let wx = Float(qx & 31) / 32, wy = Float(qy & 31) / 32
                for c in 0..<3 {
                    let top = picture.value(x0, y0, c) * (1 - wx) + picture.value(x0 + 1, y0, c) * wx
                    let bottom = picture.value(x0, y0 + 1, c) * (1 - wx) + picture.value(x0 + 1, y0 + 1, c) * wx
                    pixels[(y * Self.side + x) * 3 + c] = UInt8(min(255, max(0, (top * (1 - wy) + bottom * wy).rounded())))
                }
            }
        }
        self.pixels = pixels
    }

    var blur: Double {
        let side = Self.side
        var luma = [Double](repeating: 0, count: side * side)
        for i in 0..<(side * side) {
            let r = Double(pixels[i * 3]), g = Double(pixels[i * 3 + 1]), b = Double(pixels[i * 3 + 2])
            luma[i] = (0.299 * r + 0.587 * g + 0.114 * b).rounded()
        }
        func at(_ x: Int, _ y: Int) -> Double {
            let mx = x < 0 ? -x : (x >= side ? 2 * side - 2 - x : x)
            let my = y < 0 ? -y : (y >= side ? 2 * side - 2 - y : y)
            return luma[my * side + mx]
        }
        var sum = 0.0, squares = 0.0
        for y in 0..<side {
            for x in 0..<side {
                let value = at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1) - 4 * at(x, y)
                sum += value
                squares += value * value
            }
        }
        let count = Double(side * side)
        return squares / count - (sum / count) * (sum / count)
    }

    func write(into batch: inout [Float], slot: Int) {
        let plane = Self.side * Self.side
        for i in 0..<plane {
            for c in 0..<3 {
                batch[slot * 3 * plane + c * plane + i] = (Float(pixels[i * 3 + c]) - 127.5) / 127.5
            }
        }
    }
}
