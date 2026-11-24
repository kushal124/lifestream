import AppKit

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: swift make-icon.swift OUTPUT.iconset\n".utf8))
    exit(2)
}
let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

let logoGround = "#08141A"
let logoStreams = "#DDEEF2"
let logoTile = "M 285.00 100.00 L 739.00 100.00 C 853.70 100.00 924.00 170.30 924.00 285.00 L 924.00 739.00 C 924.00 853.70 853.70 924.00 739.00 924.00 L 285.00 924.00 C 170.30 924.00 100.00 853.70 100.00 739.00 L 100.00 285.00 C 100.00 170.30 170.30 100.00 285.00 100.00 Z"
let logoDarks = [
    "M 1.14 0.18 C 1.14 0.18 1.13 0.18 1.13 0.18 C 1.13 0.18 1.12 0.17 1.11 0.17 C 1.10 0.17 1.09 0.16 1.08 0.16 C 1.06 0.15 1.04 0.15 1.01 0.15 C 0.98 0.15 0.94 0.14 0.88 0.14 C 0.83 0.14 0.75 0.15 0.65 0.18 C 0.54 0.22 0.41 0.29 0.23 0.38 C 0.05 0.46 -0.19 0.56 -0.55 0.59 L -0.30 -0.30 L 1.60 -0.30 Z",
    "M 1.14 0.18 C 1.14 0.18 1.13 0.18 1.13 0.18 C 1.12 0.18 1.12 0.18 1.11 0.17 C 1.10 0.17 1.09 0.17 1.07 0.17 C 1.06 0.17 1.03 0.17 1.00 0.19 C 0.97 0.21 0.94 0.24 0.90 0.29 C 0.86 0.35 0.82 0.43 0.80 0.55 C 0.77 0.67 0.77 0.84 0.76 1.05 C 0.75 1.25 0.72 1.51 0.56 1.84 L 1.60 1.60 L 1.60 0.18 Z",
    "M -0.48 0.83 C -0.32 0.79 -0.19 0.74 -0.08 0.69 C 0.03 0.64 0.13 0.59 0.21 0.54 C 0.29 0.49 0.35 0.44 0.42 0.39 C 0.48 0.35 0.53 0.31 0.58 0.28 C 0.63 0.25 0.67 0.23 0.71 0.22 C 0.75 0.20 0.79 0.19 0.82 0.18 C 0.85 0.17 0.88 0.17 0.90 0.16 C 0.92 0.16 0.94 0.16 0.96 0.16 C 0.94 0.16 0.92 0.16 0.90 0.17 C 0.88 0.17 0.85 0.18 0.82 0.19 C 0.79 0.20 0.75 0.21 0.71 0.23 C 0.67 0.25 0.63 0.27 0.58 0.31 C 0.54 0.34 0.48 0.38 0.43 0.43 C 0.37 0.48 0.30 0.53 0.23 0.59 C 0.15 0.65 0.06 0.71 -0.04 0.77 C -0.15 0.83 -0.28 0.89 -0.43 0.94 Z",
    "M -0.21 1.29 C -0.07 1.21 0.04 1.12 0.13 1.04 C 0.22 0.96 0.29 0.88 0.35 0.80 C 0.41 0.73 0.46 0.66 0.50 0.60 C 0.55 0.54 0.59 0.48 0.63 0.44 C 0.67 0.39 0.70 0.36 0.73 0.33 C 0.77 0.30 0.80 0.27 0.82 0.26 C 0.85 0.24 0.88 0.22 0.90 0.21 C 0.92 0.20 0.94 0.19 0.96 0.19 C 0.94 0.19 0.92 0.20 0.90 0.22 C 0.88 0.23 0.85 0.25 0.83 0.27 C 0.80 0.29 0.77 0.32 0.74 0.36 C 0.72 0.39 0.69 0.44 0.66 0.49 C 0.63 0.54 0.60 0.61 0.56 0.68 C 0.53 0.75 0.50 0.83 0.46 0.92 C 0.41 1.00 0.36 1.10 0.29 1.20 C 0.22 1.30 0.13 1.41 0.01 1.52 Z",
]
let logoDarksSmall = [
    "M 1.14 0.18 C 1.14 0.18 1.13 0.18 1.13 0.18 C 1.13 0.18 1.12 0.17 1.11 0.17 C 1.10 0.17 1.09 0.16 1.08 0.16 C 1.06 0.15 1.04 0.15 1.01 0.15 C 0.98 0.15 0.94 0.14 0.88 0.14 C 0.83 0.14 0.75 0.15 0.65 0.18 C 0.54 0.22 0.41 0.29 0.23 0.38 C 0.05 0.46 -0.19 0.56 -0.55 0.59 L -0.30 -0.30 L 1.60 -0.30 Z",
    "M 1.14 0.18 C 1.14 0.18 1.13 0.18 1.13 0.18 C 1.12 0.18 1.12 0.18 1.11 0.17 C 1.10 0.17 1.09 0.17 1.07 0.17 C 1.06 0.17 1.03 0.17 1.00 0.19 C 0.97 0.21 0.94 0.24 0.90 0.29 C 0.86 0.35 0.82 0.43 0.80 0.55 C 0.77 0.67 0.77 0.84 0.76 1.05 C 0.75 1.25 0.72 1.51 0.56 1.84 L 1.60 1.60 L 1.60 0.18 Z",
    "M -0.50 0.78 C -0.34 0.75 -0.20 0.71 -0.09 0.66 C 0.02 0.62 0.12 0.56 0.20 0.52 C 0.28 0.47 0.35 0.42 0.41 0.38 C 0.47 0.34 0.53 0.30 0.58 0.27 C 0.63 0.25 0.67 0.23 0.71 0.21 C 0.75 0.20 0.79 0.19 0.82 0.18 C 0.85 0.17 0.88 0.17 0.90 0.16 C 0.92 0.16 0.94 0.16 0.96 0.16 C 0.94 0.16 0.92 0.16 0.90 0.17 C 0.88 0.17 0.85 0.18 0.82 0.19 C 0.79 0.20 0.75 0.21 0.71 0.23 C 0.68 0.25 0.63 0.28 0.59 0.32 C 0.54 0.35 0.49 0.39 0.43 0.44 C 0.37 0.49 0.31 0.55 0.24 0.61 C 0.16 0.67 0.08 0.74 -0.03 0.80 C -0.13 0.86 -0.26 0.93 -0.41 0.98 Z",
    "M -0.29 1.19 C -0.14 1.12 -0.02 1.04 0.08 0.97 C 0.17 0.90 0.25 0.82 0.32 0.75 C 0.38 0.68 0.44 0.62 0.49 0.56 C 0.53 0.51 0.58 0.46 0.62 0.42 C 0.66 0.37 0.70 0.34 0.73 0.31 C 0.76 0.29 0.80 0.27 0.82 0.25 C 0.85 0.23 0.88 0.22 0.90 0.21 C 0.92 0.20 0.94 0.19 0.96 0.19 C 0.94 0.19 0.92 0.21 0.90 0.22 C 0.88 0.23 0.85 0.25 0.83 0.28 C 0.80 0.30 0.78 0.33 0.75 0.37 C 0.72 0.41 0.70 0.45 0.67 0.51 C 0.64 0.57 0.62 0.63 0.59 0.71 C 0.56 0.78 0.53 0.86 0.50 0.96 C 0.46 1.05 0.42 1.15 0.36 1.25 C 0.30 1.36 0.22 1.48 0.11 1.60 Z",
]

func color(_ hex: String) -> CGColor {
    let v = Int(hex.dropFirst(), radix: 16)!
    return CGColor(srgbRed: CGFloat(v >> 16 & 255) / 255, green: CGFloat(v >> 8 & 255) / 255,
                   blue: CGFloat(v & 255) / 255, alpha: 1)
}

func path(_ data: String, _ transform: CGAffineTransform) -> CGPath {
    let path = CGMutablePath()
    var tokens = data.split(separator: " ")[...]
    func point() -> CGPoint {
        let x = Double(tokens.removeFirst())!, y = Double(tokens.removeFirst())!
        return CGPoint(x: x, y: y).applying(transform)
    }
    while let command = tokens.popFirst() {
        switch command {
        case "M": path.move(to: point())
        case "L": path.addLine(to: point())
        case "C": let c1 = point(), c2 = point(); path.addCurve(to: point(), control1: c1, control2: c2)
        default: path.closeSubpath()
        }
    }
    return path
}

func render(pixels: Int) throws -> Data {
    let size = CGFloat(pixels)
    guard let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw CocoaError(.fileWriteUnknown)
    }
    let canvas = CGAffineTransform(a: size / 1024, b: 0, c: 0, d: -size / 1024, tx: 0, ty: size)
    let tile = path(logoTile, canvas)
    let unit = CGAffineTransform(a: 824, b: 0, c: 0, d: 824, tx: 100, ty: 100).concatenating(canvas)
    context.addPath(tile)
    context.clip()
    context.addPath(tile)
    context.setFillColor(color(logoStreams))
    context.fillPath()
    context.setFillColor(color(logoGround))
    for dark in pixels <= 32 ? logoDarksSmall : logoDarks {
        context.addPath(path(dark, unit))
        context.fillPath()
    }
    guard let image = context.makeImage(),
          let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        throw CocoaError(.fileWriteUnknown)
    }
    return png
}

for points in [16, 32, 128, 256, 512] {
    try render(pixels: points).write(to: folder.appendingPathComponent("icon_\(points)x\(points).png"))
    try render(pixels: points * 2).write(to: folder.appendingPathComponent("icon_\(points)x\(points)@2x.png"))
}
