import Spool
import Foundation
import CoreGraphics
import CoreVideo
import CoreMedia
import VideoToolbox
import AVFoundation
import ImageIO
import UniformTypeIdentifiers
import Evidence
import Screen
import Darwin

private enum Failure: Error { case input, image, status(Int32), missing, tooLarge }
private func check(_ code: OSStatus) throws { if code != noErr { throw Failure.status(code) } }
private struct Stamp {
    let wall = ProcessInfo.processInfo.systemUptime
    let cpu: Double
    init() { var t = timespec(); clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &t); cpu = Double(t.tv_sec) + Double(t.tv_nsec)/1e9 }
    func elapsed() -> [String: Double] { let end = Stamp(); return ["wallSeconds":end.wall-wall,"cpuSeconds":end.cpu-cpu] }
}
private final class Encoded {
    var samples: [CMSampleBuffer] = []
    var error: OSStatus = 0
    let lock = NSLock()
    func receive(_ status: OSStatus, _ sample: CMSampleBuffer?) {
        lock.lock(); defer { lock.unlock() }
        if status != 0 { error = status }
        if let sample { samples.append(sample) }
    }
}
private final class Decoded {
    var image: CVPixelBuffer?
    var error: OSStatus = 0
}
private func cgImage(_ saved: CaptureImage) throws -> CGImage {
    switch saved {
    case .png(let bytes):
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw Failure.image }
        return image
    case .raw(let frame):
        let l = frame.layout
        guard let space = CGColorSpace(iccData: l.ICCData as CFData), let provider = CGDataProvider(data: frame.data as CFData),
              let image = CGImage(width:l.width,height:l.height,bitsPerComponent:l.bitsPerComponent,bitsPerPixel:l.bitsPerPixel,bytesPerRow:l.bytesPerRow,space:space,bitmapInfo:CGBitmapInfo(rawValue:l.bitmapInfo),provider:provider,decode:nil,shouldInterpolate:false,intent:CGColorRenderingIntent(rawValue:l.renderingIntent) ?? .defaultIntent) else { throw Failure.image }
        return image
    }
}
private let bitmap = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
private func converted(_ image: CGImage) throws -> RawFrame {
    let width = image.width, height = image.height
    guard width > 0, height > 0, width <= 8192, height <= 8192 else { throw Failure.tooLarge }
    let space = CGColorSpace(name:CGColorSpace.sRGB)!
    var data = Data(count:width*height*4)
    try data.withUnsafeMutableBytes { p in
        guard let context = CGContext(data:p.baseAddress,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:space,bitmapInfo:bitmap) else { throw Failure.image }
        context.setBlendMode(.copy); context.draw(image,in:CGRect(x:0,y:0,width:width,height:height))
    }
    return RawFrame(layout:FrameLayout(width:width,height:height,bytesPerRow:width*4,bitmapInfo:bitmap,renderingIntent:0,ICCData:space.copyICCData()! as Data),data:data)
}
private func pixelBuffer(_ raw: RawFrame) throws -> CVPixelBuffer {
    let w = (raw.layout.width+1)/2*2, h = (raw.layout.height+1)/2*2
    var output: CVPixelBuffer?
    try check(CVPixelBufferCreate(kCFAllocatorDefault,w,h,kCVPixelFormatType_32BGRA,[kCVPixelBufferIOSurfacePropertiesKey:[:]] as CFDictionary,&output))
    guard let output else { throw Failure.image }
    CVPixelBufferLockBaseAddress(output,[]); defer { CVPixelBufferUnlockBaseAddress(output,[]) }
    let pointer = CVPixelBufferGetBaseAddress(output)!, stride = CVPixelBufferGetBytesPerRow(output)
    memset(pointer,0,stride*h)
    raw.data.withUnsafeBytes { p in
        for row in 0..<raw.layout.height { memcpy(pointer.advanced(by:row*stride),p.baseAddress!.advanced(by:row*raw.layout.bytesPerRow),raw.layout.bytesPerRow) }
    }
    return output
}
private func rawDecoded(_ buffer: CVPixelBuffer, width: Int, height: Int) throws -> RawFrame {
    guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA else { throw Failure.image }
    CVPixelBufferLockBaseAddress(buffer,.readOnly); defer { CVPixelBufferUnlockBaseAddress(buffer,.readOnly) }
    var data = Data(count:width*height*4)
    data.withUnsafeMutableBytes { p in
        for row in 0..<height { memcpy(p.baseAddress!.advanced(by:row*width*4),CVPixelBufferGetBaseAddress(buffer)!.advanced(by:row*CVPixelBufferGetBytesPerRow(buffer)),width*4) }
    }
    let space = CGColorSpace(name:CGColorSpace.sRGB)!
    return RawFrame(layout:FrameLayout(width:width,height:height,bytesPerRow:width*4,bitmapInfo:bitmap,renderingIntent:0,ICCData:space.copyICCData()! as Data),data:data)
}
private func isKey(_ sample: CMSampleBuffer) -> Bool {
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample,createIfNecessary:false) as? [[CFString:Any]]
    return attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool != true
}
private func decode(_ samples: [CMSampleBuffer], target: Int) throws -> CVPixelBuffer {
    var start = target
    while start > 0 && !isKey(samples[start]) { start -= 1 }
    let state = Decoded()
    var record = VTDecompressionOutputCallbackRecord(decompressionOutputCallback: { pointer,_,status,_,image,_,_ in
        let state = Unmanaged<Decoded>.fromOpaque(pointer!).takeUnretainedValue()
        state.error = status; state.image = image
    },decompressionOutputRefCon:Unmanaged.passUnretained(state).toOpaque())
    var session: VTDecompressionSession?
    try check(VTDecompressionSessionCreate(allocator:kCFAllocatorDefault,formatDescription:CMSampleBufferGetFormatDescription(samples[start])!,decoderSpecification:nil,imageBufferAttributes:[kCVPixelBufferPixelFormatTypeKey:kCVPixelFormatType_32BGRA] as CFDictionary,outputCallback:&record,decompressionSessionOut:&session))
    guard let session else { throw Failure.missing }; defer { VTDecompressionSessionInvalidate(session) }
    for i in start...target { try check(VTDecompressionSessionDecodeFrame(session,sampleBuffer:samples[i],flags:[],frameRefcon:nil,infoFlagsOut:nil)) }
    try check(VTDecompressionSessionWaitForAsynchronousFrames(session)); try check(state.error)
    guard let image = state.image else { throw Failure.missing }; return image
}
private func tokenBag(_ observations: [TextObservation]) -> [String:Int] {
    Dictionary(observations.flatMap { $0.text.split(whereSeparator: { $0.isWhitespace }).map(String.init) }.map { ($0,1) },uniquingKeysWith:+)
}
@main private enum Benchmark {
    static func main() async {
        do { try await run() }
        catch { FileHandle.standardError.write(Data(("Hardware video diagnostic failed: " + String(describing:error) + "\n").utf8)); exit(1) }
    }
    static func run() async throws {
        guard CommandLine.arguments.count >= 3 else { throw Failure.input }
        let quality = CommandLine.arguments.count > 3 ? Double(CommandLine.arguments[3]) ?? 0.85 : 0.85
        guard (0...1).contains(quality) else { throw Failure.input }
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .custom { d in
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime,.withFractionalSeconds]
            let text = try d.singleValueContainer().decode(String.self)
            guard let date = formatter.date(from:text) ?? ISO8601DateFormatter().date(from:text) else { throw Failure.input }; return date
        }
        let all = try decoder.decode([CaptureObservation].self,from:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))).filter { $0.imageFile != nil }.sorted { $0.capturedAt < $1.capturedAt }
        guard all.count >= 30 else { throw Failure.input }
        var selected: [CaptureObservation] = []
        for fraction in [0.2,0.5,0.8] { let start = min(all.count-10,Int(Double(all.count)*fraction)); selected += all[start..<start+10] }
        let store = try CaptureStore(directory:FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Lifestream Screen"),readOnly:true)
        selected = try selected.map { candidate in
            guard let exact = try store.read(limit:20,since:candidate.capturedAt.addingTimeInterval(-1)).first(where: { $0.imageFile == candidate.imageFile }) else { throw Failure.input }; return exact
        }
        var byPath = Dictionary(uniqueKeysWithValues: all.map { ($0.imageFile!, $0) })
        for item in selected { byPath[item.imageFile!] = item }
        var dependencyPaths = Set<String>()
        for item in selected {
            var current: CaptureObservation? = item
            var depth = 0
            while let observation = current, let path = observation.imageFile {
                guard depth <= 30 else { throw Failure.input }
                dependencyPaths.insert(path); depth += 1
                guard let parent = observation.imageReference else { break }
                if byPath[parent] == nil {
                    let parts = parent.split(separator:"/")
                    guard parts.count == 3, let micros = Double(parts[1].prefix(20)),
                          let ancestor = try store.read(limit:20,since:Date(timeIntervalSince1970:micros/1e6-1)).first(where:{$0.imageFile == parent}) else { throw Failure.input }
                    byPath[parent] = ancestor
                }
                current = byPath[parent]
            }
        }
        var standaloneSourceBytes = 0
        for path in dependencyPaths { standaloneSourceBytes += try store.directory.appendingPathComponent(path).resourceValues(forKeys:[.fileSizeKey]).fileSize! }
        let first = selected[0]
        guard selected.allSatisfy({$0.width == first.width && $0.height == first.height}) else { throw Failure.input }
        let state = Encoded(); var encoder: VTCompressionSession?
        try check(VTCompressionSessionCreate(allocator:kCFAllocatorDefault,width:Int32((first.width+1)/2*2),height:Int32((first.height+1)/2*2),codecType:kCMVideoCodecType_HEVC,encoderSpecification:[kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder:true] as CFDictionary,imageBufferAttributes:nil,compressedDataAllocator:nil,outputCallback:{ pointer,_,status,_,sample in Unmanaged<Encoded>.fromOpaque(pointer!).takeUnretainedValue().receive(status,sample) },refcon:Unmanaged.passUnretained(state).toOpaque(),compressionSessionOut:&encoder))
        guard let encoder else { throw Failure.missing }; defer { VTCompressionSessionInvalidate(encoder) }
        for (key,value) in [(kVTCompressionPropertyKey_Quality,quality as Any),(kVTCompressionPropertyKey_AllowFrameReordering,false as Any),(kVTCompressionPropertyKey_ExpectedFrameRate,0.5 as Any),(kVTCompressionPropertyKey_MaxKeyFrameInterval,10 as Any)] { try check(VTSessionSetProperty(encoder,key:key,value:value as CFTypeRef)) }
        try check(VTCompressionSessionPrepareToEncodeFrames(encoder))
        let hardware = UnsafeMutablePointer<CFTypeRef?>.allocate(capacity:1)
        hardware.initialize(to:nil); defer { hardware.deinitialize(count:1); hardware.deallocate() }
        try check(VTSessionCopyProperty(encoder,key:kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,allocator:kCFAllocatorDefault,valueOut:hardware))
        var encodedCPU = 0.0, encodedWall = 0.0, conversionCPU = 0.0
        var sourceBytes = 0
        for (i,item) in selected.enumerated() {
            try autoreleasepool {
                let saved = try store.readImage(for:item)
                let stamp = Stamp(); let raw = try converted(cgImage(saved)); let buffer = try pixelBuffer(raw)
                conversionCPU += stamp.elapsed()["cpuSeconds"]!
                let start = Stamp()
                try check(VTCompressionSessionEncodeFrame(encoder,imageBuffer:buffer,presentationTimeStamp:CMTime(value:Int64(i*2),timescale:1),duration:CMTime(value:2,timescale:1),frameProperties:i%10 == 0 ? [kVTEncodeFrameOptionKey_ForceKeyFrame:true] as CFDictionary : nil,sourceFrameRefcon:nil,infoFlagsOut:nil))
                try check(VTCompressionSessionCompleteFrames(encoder,untilPresentationTimeStamp:CMTime(value:Int64(i*2),timescale:1)))
                let t = start.elapsed(); encodedCPU += t["cpuSeconds"]!; encodedWall += t["wallSeconds"]!
                sourceBytes += try store.directory.appendingPathComponent(item.imageFile!).resourceValues(forKeys:[.fileSizeKey]).fileSize!
            }
        }
        let finish = Stamp(); try check(VTCompressionSessionCompleteFrames(encoder,untilPresentationTimeStamp:.invalid)); let ft = finish.elapsed(); encodedCPU += ft["cpuSeconds"]!; encodedWall += ft["wallSeconds"]!
        try check(state.error); guard state.samples.count == 30 else { throw Failure.missing }
        let samples = state.samples.sorted { CMTimeCompare(CMSampleBufferGetPresentationTimeStamp($0),CMSampleBufferGetPresentationTimeStamp($1)) < 0 }
        let archive = URL(fileURLWithPath:CommandLine.arguments[2]).deletingPathExtension().appendingPathExtension("mov")
        let writer = try AVAssetWriter(outputURL:archive,fileType:.mov)
        let input = AVAssetWriterInput(mediaType:.video,outputSettings:nil,sourceFormatHint:CMSampleBufferGetFormatDescription(samples[0]))
        guard writer.canAdd(input) else { throw Failure.image }
        writer.add(input); guard writer.startWriting() else { throw Failure.image }
        writer.startSession(atSourceTime:.zero)
        for sample in samples {
            let deadline = ProcessInfo.processInfo.systemUptime + 5
            while !input.isReadyForMoreMediaData {
                guard writer.status == .writing, ProcessInfo.processInfo.systemUptime < deadline else { throw Failure.image }
                try await Task.sleep(nanoseconds:1_000_000)
            }
            guard input.append(sample) else { throw Failure.image }
        }
        input.markAsFinished(); await writer.finishWriting()
        guard writer.status == .completed else { throw Failure.image }
        let archiveBytes = try archive.resourceValues(forKeys:[.fileSizeKey]).fileSize!
        let native = await NativeCapture()
        var results: [[String:Any]] = []
        for index in [9,19,29] {
            let start = Stamp(); let buffer = try decode(samples,target:index); let elapsed = start.elapsed()
            let decoded = try rawDecoded(buffer,width:first.width,height:first.height)
            let original = try store.readImage(for:selected[index]); let normalized = try converted(cgImage(original))
            if CommandLine.arguments.contains("--export-review") {
                let folder = URL(fileURLWithPath:CommandLine.arguments[2]).deletingPathExtension().appendingPathExtension("review")
                try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
                for (label,saved) in [("original",original),("decoded",CaptureImage.raw(decoded))] {
                    let url = folder.appendingPathComponent("sample-" + String(index) + "-" + label + ".png")
                    guard let destination = CGImageDestinationCreateWithURL(url as CFURL,UTType.png.identifier as CFString,1,nil) else { throw Failure.image }
                    CGImageDestinationAddImage(destination,try cgImage(saved),nil)
                    guard CGImageDestinationFinalize(destination) else { throw Failure.image }
                    try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path)
                }
            }
            var total: UInt64 = 0, maximum = 0, changed = 0
            normalized.data.withUnsafeBytes { (a:UnsafeRawBufferPointer) in decoded.data.withUnsafeBytes { (b:UnsafeRawBufferPointer) in
                for i in 0..<a.count where i%4 != 3 { let difference = abs(Int(a[i])-Int(b[i])); total += UInt64(difference); maximum = max(maximum,difference); if difference != 0 { changed += 1 } }
            } }
            let baselineOCR = await native.recognizeSavedImage(original)
            let normalizedOCR = await native.recognizeSavedImage(.raw(normalized))
            let decodedOCR = await native.recognizeSavedImage(.raw(decoded))
            let a = tokenBag(baselineOCR.0), b = tokenBag(decodedOCR.0)
            let normalizedBag = tokenBag(normalizedOCR.0)
            let normalizedCount = normalizedBag.values.reduce(0,+)
            let normalizedMatched = normalizedBag.reduce(0) { $0 + min($1.value,b[$1.key,default:0]) }
            let conversionMatched = a.reduce(0) { $0 + min($1.value,normalizedBag[$1.key,default:0]) }
            let count = a.values.reduce(0,+), matched = a.reduce(0) { $0 + min($1.value,b[$1.key,default:0]) }
            results.append(["sample":index,"randomDecode":elapsed,"rgbMeanAbsoluteError":Double(total)/Double(first.width*first.height*3),"rgbMaximumError":maximum,"changedRGBChannels":changed,"normalizedOCRStatus":normalizedOCR.1,"normalizedTokenCount":normalizedCount,"conversionTokenRecall":count > 0 ? Double(conversionMatched)/Double(count) : 1,"codecTokenRecall":normalizedCount > 0 ? Double(normalizedMatched)/Double(normalizedCount) : 1,"baselineOCRStatus":baselineOCR.1,"decodedOCRStatus":decodedOCR.1,"baselineTokenCount":count,"matchedTokenCount":matched,"decodedTokenCount":b.values.reduce(0,+),"tokenRecall":count > 0 ? Double(matched)/Double(count) : 1])
        }
        let report: [String:Any] = ["archiveBytes":archiveBytes,"standaloneSourceImageBytes":standaloneSourceBytes,"sourceDependencyCount":dependencyPaths.count,"codec":"HEVC hardware required","hardwareEncoderUsed":hardware.pointee as? Bool ?? false,"quality":quality,"frames":samples.count,"keys":samples.filter(isKey).count,"compressedSampleBytes":samples.reduce(0){$0+CMSampleBufferGetTotalSampleSize($1)},"sourceImagePacketBytes":sourceBytes,"encodeCPUSeconds":encodedCPU,"encodeWallSeconds":encodedWall,"inputConversionCPUSeconds":conversionCPU,"samples":results,"limitations":"Lossy RGB/YUV representation, explicit sRGB conversion and even-dimension padding; original alpha/provider layout/ICC not preserved. Sample bytes exclude container/index/parameter-set overhead; archiveBytes includes actual MOV container. Source packet total excludes dependency ancestors; standaloneSourceImageBytes counts the unique ancestor closure. Three deterministic10-frame blocks at20/50/80 percent; forced keys across jumps. Random decode includes new decoder and all10 dependency frames. Encode timing includes submit+flush process CPU but excludes source reconstruction/conversion; each frame completes before next source conversion to isolate encoder process CPU; serial completion may sacrifice pipeline throughput. Actual NativeCapture saved-image OCR on three endpoints, not full-corpus ground truth. Process CPU excludes separate system encoder/decoder service CPU and hardware energy; not a whole-recorder CPU comparison. No production format change."]
        try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:URL(fileURLWithPath:CommandLine.arguments[2]))
        print("Validated30 encoded frames and3 anonymous OCR comparisons")
    }
}
