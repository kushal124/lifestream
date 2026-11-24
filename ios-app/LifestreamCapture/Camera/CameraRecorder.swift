import AVFoundation
import CoreLocation
import Foundation
import ImageIO
import LifestreamCaptureCore
import UniformTypeIdentifiers

struct CapturedPhoto: Sendable, Equatable {
  let bytes: Data
  let mimeType: String
  let pixelWidth: Int
  let pixelHeight: Int
  let orientation: UInt32
  let devicePosition: String
  let flash: String
  let captureTime: Date
}

struct CameraLocationFix: Sendable, Equatable {
  let latitude: Double
  let longitude: Double
  let horizontalAccuracy: Double
  let timestamp: Date

  init(latitude: Double, longitude: Double, horizontalAccuracy: Double, timestamp: Date) {
    self.latitude = latitude
    self.longitude = longitude
    self.horizontalAccuracy = horizontalAccuracy
    self.timestamp = timestamp
  }

  init(_ location: CLLocation) {
    self.init(
      latitude: location.coordinate.latitude,
      longitude: location.coordinate.longitude,
      horizontalAccuracy: location.horizontalAccuracy,
      timestamp: location.timestamp
    )
  }
}

enum CameraFlashMode: String, CaseIterable, Sendable {
  case off
  case on
  case auto

  var next: CameraFlashMode {
    switch self {
    case .off: .auto
    case .auto: .on
    case .on: .off
    }
  }

  init(avMode: AVCaptureDevice.FlashMode) {
    switch avMode {
    case .on: self = .on
    case .auto: self = .auto
    default: self = .off
    }
  }

  var avMode: AVCaptureDevice.FlashMode {
    switch self {
    case .off: .off
    case .on: .on
    case .auto: .auto
    }
  }
}

enum CameraDevicePosition: String, Sendable {
  case back
  case front

  var avPosition: AVCaptureDevice.Position {
    switch self {
    case .back: .back
    case .front: .front
    }
  }

  var flipped: CameraDevicePosition {
    switch self {
    case .back: .front
    case .front: .back
    }
  }
}

enum CameraCaptureError: Error, LocalizedError, Equatable {
  case noCamera
  case cannotAddInput
  case cannotAddOutput
  case noPhotoBytes
  case sampleImageMissing
  case undecodableImage

  var errorDescription: String? {
    switch self {
    case .noCamera: "No camera is available on this device."
    case .cannotAddInput: "The camera input could not be added to the capture session."
    case .cannotAddOutput: "The photo output could not be added to the capture session."
    case .noPhotoBytes: "The encoder returned no photo bytes."
    case .sampleImageMissing: "The bundled sample image is missing."
    case .undecodableImage: "The image bytes could not be read."
    }
  }
}

enum CameraPayload {
  static func payload(
    snapshot: CapturedPhoto,
    blobHash: String,
    location: CameraLocationFix?
  ) -> JSONValue {
    let locationValue: JSONValue =
      location.map {
        .object([
          "latitude": .number($0.latitude),
          "longitude": .number($0.longitude),
          "horizontal_accuracy": .number($0.horizontalAccuracy),
          "timestamp": .string(CaptureTime.rfc3339($0.timestamp)),
        ])
      } ?? .null
    return .object([
      "blob": .object([
        "hash": .string(blobHash),
        "type": .string(snapshot.mimeType),
        "bytes": .unsigned(UInt64(snapshot.bytes.count)),
        "role": .string("photo"),
      ]),
      "pixel_width": .integer(Int64(snapshot.pixelWidth)),
      "pixel_height": .integer(Int64(snapshot.pixelHeight)),
      "orientation": .unsigned(UInt64(snapshot.orientation)),
      "device_position": .string(snapshot.devicePosition),
      "flash": .string(snapshot.flash),
      "location": locationValue,
    ])
  }

  static func draft(
    snapshot: CapturedPhoto,
    blobHash: String,
    location: CameraLocationFix?,
    captured: WallAndMonotonicTime = .init()
  ) -> CaptureDraft {
    .init(
      kind: "photo",
      observedAt: CaptureTime.rfc3339(snapshot.captureTime),
      captured: captured,
      payload: payload(snapshot: snapshot, blobHash: blobHash, location: location)
    )
  }

  static func pixelSize(of bytes: Data) -> (width: Int, height: Int)? {
    guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
        as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int
    else { return nil }
    return (width, height)
  }
}

struct RecordedPhoto: Sendable {
  let entry: CaptureEntry
  let bytes: Data
}

final class CaptureSessionBox: @unchecked Sendable {
  let session = AVCaptureSession()
}

final class PhotoCaptureBridge: NSObject, AVCapturePhotoCaptureDelegate {
  private let mimeType: String
  private let devicePosition: String
  private let flash: String
  private let onFinish: @Sendable (Result<CapturedPhoto, any Error>) -> Void
  private var shutterTime: Date?
  private var processedResult: Result<CapturedPhoto, any Error>?

  init(
    mimeType: String,
    devicePosition: String,
    flash: String,
    onFinish: @escaping @Sendable (Result<CapturedPhoto, any Error>) -> Void
  ) {
    self.mimeType = mimeType
    self.devicePosition = devicePosition
    self.flash = flash
    self.onFinish = onFinish
  }

  nonisolated func photoOutput(
    _ output: AVCapturePhotoOutput,
    willCapturePhotoFor resolvedSettings: AVCaptureResolvedPhotoSettings
  ) {
    shutterTime = AppClock.now
  }

  nonisolated func photoOutput(
    _ output: AVCapturePhotoOutput,
    didFinishProcessingPhoto photo: AVCapturePhoto,
    error: (any Error)?
  ) {
    if let error {
      processedResult = .failure(error)
      return
    }
    guard let bytes = photo.fileDataRepresentation() else {
      processedResult = .failure(CameraCaptureError.noPhotoBytes)
      return
    }
    let dimensions = photo.resolvedSettings.photoDimensions
    let orientation =
      (photo.metadata[kCGImagePropertyOrientation as String] as? NSNumber)?.uint32Value
      ?? 1
    processedResult = .success(
      CapturedPhoto(
        bytes: bytes,
        mimeType: mimeType,
        pixelWidth: Int(dimensions.width),
        pixelHeight: Int(dimensions.height),
        orientation: orientation,
        devicePosition: devicePosition,
        flash: flash,
        captureTime: shutterTime ?? AppClock.now
      ))
  }

  nonisolated func photoOutput(
    _ output: AVCapturePhotoOutput,
    didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings,
    error: (any Error)?
  ) {
    if let error {
      onFinish(.failure(error))
    } else {
      onFinish(processedResult ?? .failure(CameraCaptureError.noPhotoBytes))
    }
  }
}

struct CameraZoomScale: Equatable {
  let multiplier: Double
  let minimumDeviceZoom: Double
  let maximumDeviceZoom: Double

  var minimum: Double { minimumDeviceZoom * multiplier }
  var maximum: Double { min(20, maximumDeviceZoom * multiplier) }

  func presets(deviceFactors: [Double], rear: Bool) -> [Double] {
    Array(Set(([minimum, 1, 2] + (rear ? [8] : []) + deviceFactors.map(displayZoom))
      .filter { $0 >= minimum && $0 <= maximum }
      .map { ($0 * 10).rounded() / 10 })).sorted()
  }

  func deviceZoom(for displayed: Double) -> Double {
    let finite = displayed.isFinite ? displayed : 1
    return min(max(finite, minimum), maximum) / multiplier
  }

  func displayZoom(for device: Double) -> Double { device * multiplier }
}

actor CameraSessionController {
  private let queue = DispatchSerialQueue(
    label: "org.lifestreamprotocol.phone.camera-session")
  nonisolated var unownedExecutor: UnownedSerialExecutor {
    queue.asUnownedSerialExecutor()
  }

  nonisolated let box = CaptureSessionBox()
  private let photoOutput = AVCapturePhotoOutput()
  private var videoInput: AVCaptureDeviceInput?
  private var inFlight: [Int64: PhotoCaptureBridge] = [:]
  private(set) var position: CameraDevicePosition = .back
  private var configured = false

  private var session: AVCaptureSession { box.session }

  nonisolated static func device(for position: CameraDevicePosition) -> AVCaptureDevice? {
    if position == .back {
      for type in [AVCaptureDevice.DeviceType.builtInTripleCamera, .builtInDualWideCamera, .builtInDualCamera] {
        if let device = AVCaptureDevice.default(type, for: .video, position: .back) { return device }
      }
    }
    return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position.avPosition)
  }

  nonisolated static var hasAnyCamera: Bool {
    device(for: .back) != nil || device(for: .front) != nil
  }

  func configure(position: CameraDevicePosition = .back) throws {
    guard !configured else { return }
    guard let device = Self.device(for: position) else {
      throw CameraCaptureError.noCamera
    }
    session.beginConfiguration()
    defer { session.commitConfiguration() }
    session.sessionPreset = .photo
    let input = try AVCaptureDeviceInput(device: device)
    guard session.canAddInput(input) else { throw CameraCaptureError.cannotAddInput }
    session.addInput(input)
    videoInput = input
    guard session.canAddOutput(photoOutput) else { throw CameraCaptureError.cannotAddOutput }
    session.addOutput(photoOutput)
    applyMaximumDimensions(for: device)
    self.position = device.position == .front ? .front : .back
    configured = true
    _ = try setZoom(1)
  }

  struct Controls: Sendable {
    let zoom: Double
    let maximumZoom: Double
    let minimumZoom: Double
    let presets: [Double]
    let exposure: Double
    let minimumExposure: Double
    let maximumExposure: Double
  }

  func controls() -> Controls {
    guard let device = videoInput?.device else {
      return Controls(zoom: 1, maximumZoom: 1, minimumZoom: 1, presets: [1], exposure: 0, minimumExposure: 0, maximumExposure: 0)
    }
    let scale = zoomScale(for: device)
    let presets = scale.presets(
      deviceFactors: device.virtualDeviceSwitchOverVideoZoomFactors.map(\.doubleValue)
        + device.activeFormat.secondaryNativeResolutionZoomFactors.map { Double($0) },
      rear: position == .back)
    return Controls(
      zoom: scale.displayZoom(for: Double(device.videoZoomFactor)),
      maximumZoom: scale.maximum,
      minimumZoom: scale.minimum,
      presets: presets,
      exposure: Double(device.exposureTargetBias),
      minimumExposure: max(-2, Double(device.minExposureTargetBias)),
      maximumExposure: min(2, Double(device.maxExposureTargetBias)))
  }

  func setZoom(_ value: Double) throws -> Double {
    guard let device = videoInput?.device else { throw CameraCaptureError.noCamera }
    try device.lockForConfiguration()
    defer { device.unlockForConfiguration() }
    let scale = zoomScale(for: device)
    let factor = scale.deviceZoom(for: value)
    device.videoZoomFactor = CGFloat(factor)
    return scale.displayZoom(for: factor)
  }

  private func zoomScale(for device: AVCaptureDevice) -> CameraZoomScale {
    CameraZoomScale(multiplier: Double(device.displayVideoZoomFactorMultiplier),
                    minimumDeviceZoom: Double(device.minAvailableVideoZoomFactor),
                    maximumDeviceZoom: Double(device.maxAvailableVideoZoomFactor))
  }

  func setExposure(_ value: Double) throws -> Double {
    guard let device = videoInput?.device else { throw CameraCaptureError.noCamera }
    try device.lockForConfiguration()
    defer { device.unlockForConfiguration() }
    let bias = min(max(Float(value), max(-2, device.minExposureTargetBias)), min(2, device.maxExposureTargetBias))
    device.setExposureTargetBias(bias, completionHandler: nil)
    return Double(bias)
  }

  func focus(at point: CGPoint) throws {
    guard let device = videoInput?.device else { throw CameraCaptureError.noCamera }
    try device.lockForConfiguration()
    defer { device.unlockForConfiguration() }
    if device.isFocusPointOfInterestSupported, device.isFocusModeSupported(.autoFocus) {
      device.focusPointOfInterest = point
      device.focusMode = .autoFocus
    }
    if device.isExposurePointOfInterestSupported, device.isExposureModeSupported(.continuousAutoExposure) {
      device.exposurePointOfInterest = point
      device.exposureMode = .continuousAutoExposure
    }
    device.isSubjectAreaChangeMonitoringEnabled = true
  }

  func start() {
    guard configured, !session.isRunning else { return }
    session.startRunning()
    EnergyLedger.shared.hold("camera", setting: "running")
  }

  func stop() {
    guard session.isRunning else { return }
    session.stopRunning()
    EnergyLedger.shared.hold("camera", setting: nil)
  }

  @discardableResult
  func flip() throws -> CameraDevicePosition {
    guard configured, let current = videoInput else { return position }
    let target = position.flipped
    guard
      let device = Self.device(for: target)
    else { return position }
    session.beginConfiguration()
    defer { session.commitConfiguration() }
    let input = try AVCaptureDeviceInput(device: device)
    session.removeInput(current)
    guard session.canAddInput(input) else {
      session.addInput(current)
      throw CameraCaptureError.cannotAddInput
    }
    session.addInput(input)
    videoInput = input
    applyMaximumDimensions(for: device)
    position = target
    _ = try setZoom(1)
    return target
  }

  func capture(flash: CameraFlashMode, rotationAngle: CGFloat) async throws -> CapturedPhoto {
    guard configured, let device = videoInput?.device else {
      throw CameraCaptureError.noCamera
    }
    let usesHEVC = photoOutput.availablePhotoCodecTypes.contains(.hevc)
    let settings = AVCapturePhotoSettings(format: [
      AVVideoCodecKey: usesHEVC ? AVVideoCodecType.hevc : AVVideoCodecType.jpeg
    ])
    settings.maxPhotoDimensions = photoOutput.maxPhotoDimensions
    if device.hasFlash, photoOutput.supportedFlashModes.contains(flash.avMode) {
      settings.flashMode = flash.avMode
    }
    if let connection = photoOutput.connection(with: .video),
      connection.isVideoRotationAngleSupported(rotationAngle)
    {
      connection.videoRotationAngle = rotationAngle
    }
    let id = settings.uniqueID
    let mimeType = usesHEVC ? "image/heic" : "image/jpeg"
    let positionName = position.rawValue
    return try await withCheckedThrowingContinuation { continuation in
      let bridge = PhotoCaptureBridge(
        mimeType: mimeType,
        devicePosition: positionName,
        flash: CameraFlashMode(avMode: settings.flashMode).rawValue
      ) { [weak self] result in
        continuation.resume(with: result)
        Task { await self?.forget(id) }
      }
      inFlight[id] = bridge
      photoOutput.capturePhoto(with: settings, delegate: bridge)
    }
  }

  private func forget(_ id: Int64) {
    inFlight[id] = nil
  }

  private func applyMaximumDimensions(for device: AVCaptureDevice) {
    if let largest = device.activeFormat.supportedMaxPhotoDimensions.max(by: {
      Int64($0.width) * Int64($0.height) < Int64($1.width) * Int64($1.height)
    }) {
      photoOutput.maxPhotoDimensions = largest
    }
    photoOutput.maxPhotoQualityPrioritization = .quality
  }
}

actor CameraRecorder {
  private let store: CaptureStore
  private let locationRecorder: LocationRecorderCoordinator
  private let authorizeWrite: @Sendable () async throws -> Void
  nonisolated let session = CameraSessionController()

  init(
    store: CaptureStore, locationRecorder: LocationRecorderCoordinator,
    authorizeWrite: @escaping @Sendable () async throws -> Void
  ) {
    self.store = store
    self.locationRecorder = locationRecorder
    self.authorizeWrite = authorizeWrite
  }

  func takePhoto(flash: CameraFlashMode, rotationAngle: CGFloat) async throws -> RecordedPhoto {
    let snapshot = try await session.capture(flash: flash, rotationAngle: rotationAngle)
    return try await record(snapshot)
  }

  func recordSampleImage() async throws -> RecordedPhoto {
    guard let url = Bundle.main.url(forResource: "camera-sample", withExtension: "jpg") else {
      throw CameraCaptureError.sampleImageMissing
    }
    let bytes = try Data(contentsOf: url)
    guard let size = CameraPayload.pixelSize(of: bytes) else {
      throw CameraCaptureError.undecodableImage
    }
    return try await record(
      CapturedPhoto(
        bytes: bytes,
        mimeType: "image/jpeg",
        pixelWidth: size.width,
        pixelHeight: size.height,
        orientation: 1,
        devicePosition: CameraDevicePosition.back.rawValue,
        flash: CameraFlashMode.off.rawValue,
        captureTime: AppClock.now
      ))
  }

  func record(_ snapshot: CapturedPhoto) async throws -> RecordedPhoto {
    try await authorizeWrite()
    let recorder = locationRecorder
    let fix = await MainActor.run { recorder.lastLocation.map(CameraLocationFix.init) }
    let hash = try await store.storeBlob(snapshot.bytes)
    let entry = try await store.append(
      domain: .camera,
      draft: CameraPayload.draft(snapshot: snapshot, blobHash: hash, location: fix)
    )
    return RecordedPhoto(entry: entry, bytes: snapshot.bytes)
  }

  func shots() async throws -> [CameraShot] {
    let entries = try await store.entries(domain: .camera)
    var shots: [CameraShot] = []
    for entry in entries.reversed() { shots.append(try await shot(entry)) }
    return shots
  }

  func latestShot() async throws -> CameraShot? {
    guard let entry = try await store.latestEntry(domain: .camera) else { return nil }
    return try await shot(entry)
  }

  private func shot(_ entry: CaptureEntry) async throws -> CameraShot {
    let url: URL?
    if let hex = CameraShot.blobHash(of: entry) {
      url = try await store.blobFile(forTaggedHash: "sha256:" + hex)
    } else { url = nil }
    return CameraShot(entry: entry, blobURL: url)
  }
}

struct CameraShot: Identifiable, Sendable, Equatable {
  let entry: CaptureEntry
  let blobURL: URL?

  var id: UInt64 { entry.sequence }

  var hashHex: String? { Self.blobHash(of: entry) }

  var bytes: UInt64? {
    guard case .object(let payload) = entry.payload,
      case .object(let blob)? = payload["blob"]
    else { return nil }
    switch blob["bytes"] {
    case .unsigned(let bytes): return bytes
    case .integer(let bytes) where bytes >= 0: return UInt64(bytes)
    default: return nil
    }
  }

  var observedDate: Date? { CaptureTime.date(rfc3339: entry.observedAt) }

  static func blobHash(of entry: CaptureEntry) -> String? {
    guard case .object(let payload) = entry.payload,
      case .object(let blob)? = payload["blob"],
      case .string(let tagged)? = blob["hash"],
      tagged.hasPrefix("sha256:")
    else { return nil }
    return String(tagged.dropFirst("sha256:".count))
  }
}
