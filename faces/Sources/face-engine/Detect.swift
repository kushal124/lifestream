import Foundation

struct Detection {
    var box: [Double]
    var landmarks: [[Double]]
    var score: Double
}

enum Detect {
    struct Square {
        let side: Int
        let scaleX: Double
        let scaleY: Double
        let outputs: [[Float]]
    }

    static func faces(_ squares: [Square]) -> [Detection] {
        let largest = squares.map(\.side).max()
        var found: [Detection] = []
        for square in squares {
            found += candidates(square, smallest: square.side == largest ? 0 : Settings.largeFace)
        }
        let order = found.indices.sorted { (found[$0].score, $1) > (found[$1].score, $0) }
        var kept: [Detection] = []
        for candidate in order.map({ found[$0] }) where kept.allSatisfy({ overlap($0.box, candidate.box) <= Settings.overlapThreshold }) {
            kept.append(candidate)
        }
        return kept
    }

    private static func candidates(_ square: Square, smallest: Double) -> [Detection] {
        var found: [Detection] = []
        let (outputs, sx, sy) = (square.outputs, square.scaleX, square.scaleY)
        for (level, stride) in [8, 16, 32].enumerated() {
            let scores = outputs[level], distances = outputs[level + 3], offsets = outputs[level + 6]
            let cells = square.side / stride
            let s = Double(stride)
            for anchor in 0..<scores.count where Double(scores[anchor]) >= Settings.detectThreshold {
                let cell = anchor / 2
                let cx = Double(cell % cells) * s, cy = Double(cell / cells) * s
                let d = (0..<4).map { Double(distances[anchor * 4 + $0]) * s }
                guard max(d[0] + d[2], d[1] + d[3]) >= smallest else { continue }
                let box = [(cx - d[0]) / sx, (cy - d[1]) / sy, (cx + d[2]) / sx, (cy + d[3]) / sy]
                let landmarks = (0..<5).map { point in
                    [(cx + Double(offsets[anchor * 10 + 2 * point]) * s) / sx,
                     (cy + Double(offsets[anchor * 10 + 2 * point + 1]) * s) / sy]
                }
                found.append(Detection(box: box, landmarks: landmarks, score: Double(scores[anchor])))
            }
        }
        return found
    }

    static func overlap(_ a: [Double], _ b: [Double]) -> Double {
        let w = max(0, min(a[2], b[2]) - max(a[0], b[0]) + 1)
        let h = max(0, min(a[3], b[3]) - max(a[1], b[1]) + 1)
        let inter = w * h
        let area = { (r: [Double]) in (r[2] - r[0] + 1) * (r[3] - r[1] + 1) }
        return inter / (area(a) + area(b) - inter)
    }
}
