import Foundation
import ImageIO
import UniformTypeIdentifiers
func pixels(_ image: CGImage) -> Data {
    var data = Data(count: image.width * image.height * 4)
    data.withUnsafeMutableBytes { bytes in
        let context = CGContext(data: bytes.baseAddress, width: image.width, height: image.height,
            bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    }
    return data
}
var rows: [[String: Any]] = []
for (sample, path) in CommandLine.arguments.dropFirst().enumerated() {
    autoreleasepool {
        let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil)!
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
        let reference = pixels(image)
        for (name, filter) in [("default", -1), ("none", 8), ("sub", 16), ("up", 32), ("all", 248)] {
            for nested in [false, true] {
                let output = NSMutableData()
                let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil)!
                let options: CFDictionary? = filter < 0 ? nil : (nested ?
                    [kCGImagePropertyPNGDictionary: [kCGImagePropertyPNGCompressionFilter: filter]] as CFDictionary :
                    [kCGImagePropertyPNGCompressionFilter: filter] as CFDictionary)
                let began = ProcessInfo.processInfo.systemUptime
                CGImageDestinationAddImage(destination, image, options)
                let succeeded = CGImageDestinationFinalize(destination)
                let elapsed = ProcessInfo.processInfo.systemUptime - began
                let decodedSource = CGImageSourceCreateWithData(output, nil)!
                let decoded = CGImageSourceCreateImageAtIndex(decodedSource, 0, nil)!
                rows.append(["sample":sample,"filter":name,"nested":nested,"bytes":output.length,
                    "encodeMilliseconds":elapsed*1000,"pixelIdentical":pixels(decoded)==reference,"success":succeeded])
            }
        }
    }
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys]))
