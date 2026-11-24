import Foundation
import CoreGraphics

private struct Snapshot {
    let image: CGImage
    let bytes: Data
}
@main struct CropProviderLayoutDiagnostic {
    static func pixel(x: Int, y: Int) -> [UInt8] { [UInt8(x%251),UInt8(y%251),UInt8((x+y)%251),255] }
    private static func source(change: (Int,Int)?, padded: Bool) -> Snapshot? {
        let width = 101, height = 73, stride = width*4+(padded ? 28 : 0)
        var bytes = Data(repeating:0xA7,count:stride*height)
        bytes.withUnsafeMutableBytes { raw in
            let p = raw.bindMemory(to:UInt8.self)
            for y in 0..<height { for x in 0..<width {
                let rgba = pixel(x:x,y:y)
                for component in 0..<4 { p[y*stride+x*4+component] = rgba[component] }
            }}
            if let (x,y) = change { p[y*stride+x*4] ^= 0x7F }
        }
        guard let provider = CGDataProvider(data:bytes as CFData), let space = CGColorSpace(name:CGColorSpace.sRGB),
              let image = CGImage(width:width,height:height,bitsPerComponent:8,bitsPerPixel:32,bytesPerRow:stride,
                space:space,bitmapInfo:CGBitmapInfo(rawValue:CGBitmapInfo.byteOrder32Little.rawValue|CGImageAlphaInfo.premultipliedFirst.rawValue),
                provider:provider,decode:nil,shouldInterpolate:false,intent:.defaultIntent) else { return nil }
        return Snapshot(image:image,bytes:bytes)
    }
    static func render(_ image: CGImage) -> Data? {
        guard let space = CGColorSpace(name:CGColorSpace.sRGB),
              let context = CGContext(data:nil,width:image.width,height:image.height,bitsPerComponent:8,bytesPerRow:image.width*4,
                space:space,bitmapInfo:CGBitmapInfo.byteOrder32Little.rawValue|CGImageAlphaInfo.premultipliedFirst.rawValue) else { return nil }
        context.interpolationQuality = .none; context.setBlendMode(.copy)
        context.draw(image,in:CGRect(x:0,y:0,width:image.width,height:image.height))
        guard let data = context.data else { return nil }
        return Data(bytes:data,count:image.width*4*image.height)
    }
    static func activeRows(_ image: CGImage, data: Data) -> Data? {
        guard image.bytesPerRow >= image.width*4,
              data.count >= (image.height-1)*image.bytesPerRow+image.width*4 else { return nil }
        var packed = Data(); packed.reserveCapacity(image.width*image.height*4)
        for y in 0..<image.height { packed.append(data[(y*image.bytesPerRow)..<(y*image.bytesPerRow+image.width*4)]) }
        return packed
    }
    static func expected(rect: CGRect, change: (Int,Int)?, flipRows: Bool) -> Data {
        let x0 = Int(rect.minX),y0 = Int(rect.minY),width = Int(rect.width),height = Int(rect.height)
        var output = Data()
        for row in 0..<height {
            let y = y0+(flipRows ? height-1-row : row)
            for x in x0..<(x0+width) {
                var value = pixel(x:x,y:y)
                if let change, change.0 == x && change.1 == y { value[0] ^= 0x7F }
                output.append(contentsOf:value)
            }
        }
        return output
    }
    static func main() throws {
        let rects = [CGRect(x:17,y:11,width:37,height:23),CGRect(x:0,y:0,width:37,height:23),CGRect(x:0,y:11,width:101,height:23)]
        var rows: [[String:Any]] = []
        for padded in [false,true] {
            for (index,rect) in rects.enumerated() {
                let outsideSameRow = rect.maxX < 100 ? (Int(rect.maxX)+2,Int(rect.minY)+3) : (1,72)
                let variants: [(String,(Int,Int)?)] = [("base",nil),("outside-far",(100,72)),("outside-same-row",outsideSameRow),("inside",(Int(rect.minX)+3,Int(rect.minY)+3))]
                var providers: [String:Data] = [:], active: [String:Data] = [:], renders: [String:Data] = [:]
                var details: [[String:Any]] = []
                for (name,change) in variants {
                    guard let original = source(change:change,padded:padded),let cropped = original.image.cropping(to:rect),
                          let raw = cropped.dataProvider?.data,let rendered = render(cropped) else {
                        details.append(["variant":name,"error":"synthetic-image-crop-or-render-failed"]); continue
                    }
                    let data = raw as Data, packed = activeRows(cropped,data:data)
                    providers[name] = data; active[name] = packed; renders[name] = rendered
                    details.append(["variant":name,"width":cropped.width,"height":cropped.height,
                        "bytesPerRow":cropped.bytesPerRow,"providerBytes":data.count,"packedPixelBytes":cropped.width*cropped.height*4,
                        "sourceBytesPerRow":original.image.bytesPerRow,"sourceProviderBytes":original.bytes.count,
                        "providerEqualsEntireSource":data==original.bytes,
                        "activeRowsAssumingOriginZeroMatchExpected":packed == expected(rect:rect,change:change,flipRows:false),
                        "renderMatchesExpectedForwardRows":rendered == expected(rect:rect,change:change,flipRows:false),
                        "renderMatchesExpectedReversedRows":rendered == expected(rect:rect,change:change,flipRows:true),
                        "activeRowsEqualRenderedCrop":packed == rendered])
                }
                var comparisons: [String:Any] = [:]
                for name in ["outside-far","outside-same-row","inside"] {
                    guard let base = providers["base"],let other = providers[name],let rb = renders["base"],let ro = renders[name] else { continue }
                    comparisons[name] = ["wholeProviderEqual":base==other,
                        "originZeroActiveRowsEqual":active["base"]==active[name],"renderedCropEqual":rb==ro]
                }
                rows.append(["cropIndex":index,"sourceHasPadding":padded,"details":details,"comparisons":comparisons])
            }
        }
        let report: [String:Any] = ["measurements":rows,"limitations":[
            "Synthetic packed/padded opaque BGRA sources only; behavior observed on this CoreGraphics version is not an API guarantee for arbitrary CGImage providers.",
            "activeRows deliberately tests an origin-zero interpretation; expected coordinate-coded bytes and independently rendered crops test that assumption.",
            "Full-provider equality may include bytes outside the visible crop. Rendered equality is checked separately for inside/outside perturbations.",
            "Rendering normalizes through explicit sRGB BGRA; this test does not establish byte fidelity for other color spaces, alpha modes, orientations or decode arrays.",
            "No production cache comparison change should assume provider origin/stride without an independently verified pixel representation."]]
        print(String(decoding:try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]),as:UTF8.self))
    }
}
