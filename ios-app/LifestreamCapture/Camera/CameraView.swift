import AVFoundation
import Cockpit
import Combine
import ImageIO
import LifestreamCaptureCore
import SwiftUI
import UIKit

struct CameraTabView: View {
  @EnvironmentObject private var model: CaptureAppModel
  @State private var isLibraryPresented = false

  var body: some View {
    NavigationStack {
      CameraView(recorder: model.runtime.cameraRecorder)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            IconButton(.close, label: "Back to home") { AppNavigation.shared.presented = nil }
              .cameraDark()
              .accessibilityIdentifier("capture.close")
          }
          ToolbarItem(placement: .topBarTrailing) {
            IconButton(.photos, label: "Library") { isLibraryPresented = true }
              .cameraDark()
              .accessibilityIdentifier("camera.library")
          }
        }
        .navigationDestination(isPresented: $isLibraryPresented) {
          PhotosLibraryView()
        }
    }
    .accessibilityIdentifier("camera.tab")
  }
}

private struct CameraAppearance: ViewModifier {
  func body(content: Content) -> some View {
    content
      .cameraDark()
      .toolbarColorScheme(.dark, for: .navigationBar)
      .tint(Cockpit.Color.text)
  }
}

extension View {
  fileprivate func cameraDark() -> some View {
    environment(\.colorScheme, .dark)
  }
}

enum CameraPhase: Equatable {
  case checking
  case noCamera
  case denied
  case restricted
  case ready
}

@MainActor
final class CameraViewModel: ObservableObject {
  @Published private(set) var phase: CameraPhase = .checking
  @Published var flash: CameraFlashMode = .off
  @Published private(set) var position: CameraDevicePosition = .back
  @Published private(set) var lastThumbnail: UIImage?
  @Published private(set) var lastShot: CameraShot?
  @Published var screenFlashOpacity = 0.0
  @Published private(set) var starting: ActOutcome = .idle
  @Published private(set) var taking: ActOutcome = .idle
  @Published private(set) var adjusting: ActOutcome = .idle
  private(set) var lastAdjustment: (@MainActor () -> Void)?
  private let sample: @MainActor () async throws -> RecordedPhoto

  var isCapturing: Bool { taking.running }

  @Published private(set) var zoom: Double = 1
  @Published private(set) var maximumZoom: Double = 1
  @Published private(set) var minimumZoom: Double = 1
  @Published private(set) var zoomPresets: [Double] = [1]
  @Published private(set) var exposure: Double = 0
  @Published private(set) var minimumExposure: Double = 0
  @Published private(set) var maximumExposure: Double = 0
  @Published var showsGrid = false

  let recorder: CameraRecorder
  private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
  private var rotationObservation: NSKeyValueObservation?
  private var isPreparing = false
  private weak var previewLayer: AVCaptureVideoPreviewLayer?
  private let haptic = UIImpactFeedbackGenerator(style: .medium)

  init(recorder: CameraRecorder, sample: (@MainActor () async throws -> RecordedPhoto)? = nil) {
    self.recorder = recorder
    self.sample = sample ?? { try await recorder.recordSampleImage() }
  }

  func prepare() async {
    guard !isPreparing else { return }
    isPreparing = true
    defer { isPreparing = false }
    guard !Task.isCancelled else { return }
    guard CameraSessionController.hasAnyCamera else {
      phase = .noCamera
      await loadLastShot()
      return
    }
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .notDetermined:
      let granted = await AVCaptureDevice.requestAccess(for: .video)
      guard granted else {
        phase = .denied
        return
      }
    case .denied:
      phase = .denied
      return
    case .restricted:
      phase = .restricted
      return
    case .authorized:
      break
    @unknown default:
      phase = .denied
      return
    }
    await ActOutcome.run(\.starting, of: self) {
      try await start()
    }
  }

  private func start() async throws {
    do {
      try await recorder.session.configure(position: .back)
      guard !Task.isCancelled else { return }
      position = await recorder.session.position
      guard !Task.isCancelled else { return }
      await recorder.session.start()
      phase = .ready
      await refreshControls()
      attachRotationCoordinator()
      await loadLastShot()
    } catch let error as CameraCaptureError where error == .noCamera {
      phase = .noCamera
    }
  }

  func resume() async {
    await prepare()
  }

  func pause() async {
    await recorder.session.stop()
  }

  func attach(previewLayer: AVCaptureVideoPreviewLayer) {
    self.previewLayer = previewLayer
    previewLayer.session = recorder.session.box.session
    attachRotationCoordinator()
  }

  func shutter() {
    guard phase == .ready, !isCapturing else { return }
    taking = .running
    haptic.impactOccurred()
    flashScreen()
    let angle = rotationCoordinator?.videoRotationAngleForHorizonLevelCapture ?? 90
    let flash = self.flash
    Task { await take { try await self.recorder.takePhoto(flash: flash, rotationAngle: angle) } }
  }

  private func take(_ photo: @escaping @MainActor () async throws -> RecordedPhoto) async {
    taking = .idle
    await ActOutcome.run(\.taking, of: self) { show(try await photo()) }
  }

  func recordSample() {
    guard !isCapturing else { return }
    taking = .running
    haptic.impactOccurred()
    flashScreen()
    Task { await take(sample) }
  }

  func flip() {
    guard phase == .ready, !isCapturing else { return }
    adjust({ self.flip() }) {
      self.position = try await self.recorder.session.flip()
      await self.refreshControls()
      self.attachRotationCoordinator()
    }
  }

  private func adjust(_ again: @escaping @MainActor () -> Void, _ change: @escaping @MainActor () async throws -> Void) {
    lastAdjustment = again
    Task { await ActOutcome.run(\.adjusting, of: self, change) }
  }

  private func refreshControls() async {
    let state = await recorder.session.controls()
    zoom = state.zoom
    maximumZoom = state.maximumZoom
    minimumZoom = state.minimumZoom
    zoomPresets = state.presets
    exposure = state.exposure
    minimumExposure = state.minimumExposure
    maximumExposure = state.maximumExposure
  }

  func setZoom(_ value: Double) {
    guard phase == .ready, !isCapturing else { return }
    adjust({ self.setZoom(value) }) { self.zoom = try await self.recorder.session.setZoom(value) }
  }

  func setExposure(_ value: Double) {
    guard phase == .ready, !isCapturing else { return }
    adjust({ self.setExposure(value) }) { self.exposure = try await self.recorder.session.setExposure(value) }
  }

  func focus(at point: CGPoint) {
    guard phase == .ready, !isCapturing else { return }
    adjust({ self.focus(at: point) }) {
      try await self.recorder.session.focus(at: point)
      self.exposure = try await self.recorder.session.setExposure(0)
    }
  }

  func cycleFlash() {
    flash = flash.next
  }

  private func show(_ photo: RecordedPhoto) {
    lastShot = CameraShot(entry: photo.entry, blobURL: nil)
    lastThumbnail = CameraThumbnail.make(from: photo.bytes, maxPixelSize: 160)
  }

  private func loadLastShot() async {
    guard let newest = try? await recorder.latestShot() else { return }
    guard lastShot?.id != newest.id || lastThumbnail == nil else { return }
    lastShot = newest
    if let url = newest.blobURL {
      lastThumbnail = await CameraThumbnail.load(url: url, maxPixelSize: 160)
    }
  }

  private func flashScreen() {
    guard !UIAccessibility.isReduceMotionEnabled else { return }
    screenFlashOpacity = 0.85
    withAnimation(.easeOut(duration: 0.18)) {
      screenFlashOpacity = 0
    }
  }

  private func attachRotationCoordinator() {
    guard phase == .ready, let previewLayer,
      let device = CameraSessionController.device(for: position)
    else { return }
    let coordinator = AVCaptureDevice.RotationCoordinator(
      device: device, previewLayer: previewLayer)
    rotationCoordinator = coordinator
    applyPreviewRotation(coordinator.videoRotationAngleForHorizonLevelPreview)
    rotationObservation = coordinator.observe(
      \.videoRotationAngleForHorizonLevelPreview, options: [.new]
    ) { [weak self] _, change in
      guard let angle = change.newValue else { return }
      Task { @MainActor in self?.applyPreviewRotation(angle) }
    }
  }

  private func applyPreviewRotation(_ angle: CGFloat) {
    guard let connection = previewLayer?.connection,
      connection.isVideoRotationAngleSupported(angle)
    else { return }
    connection.videoRotationAngle = angle
  }
}

struct CameraView: View {
  @StateObject private var viewModel: CameraViewModel
  @State private var isVisible = false
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(recorder: CameraRecorder) {
    _viewModel = StateObject(wrappedValue: CameraViewModel(recorder: recorder))
  }

  var body: some View {
    ZStack {
      Cockpit.Color.canvas.ignoresSafeArea()
      switch viewModel.phase {
      case .checking:
        if let failure = viewModel.starting.failure {
          InPlaceLine(failure) { Task { await viewModel.prepare() } }
            .padding(.horizontal, Cockpit.Gap.edge)
            .accessibilityIdentifier("camera.start.failed")
        }
      case .ready:
        CameraPreviewView(viewModel: viewModel)
          .ignoresSafeArea()
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("Camera viewfinder")
          .accessibilityAction(named: "Focus on center") {
            viewModel.focus(at: CGPoint(x: 0.5, y: 0.5))
          }
          .accessibilityAction(named: "Brighten exposure") { viewModel.setExposure(viewModel.exposure + 0.3) }
          .accessibilityAction(named: "Darken exposure") { viewModel.setExposure(viewModel.exposure - 0.3) }
        if viewModel.showsGrid {
          GeometryReader { geometry in
            Path { path in
              for fraction in [CGFloat(1.0 / 3), CGFloat(2.0 / 3)] {
                path.move(to: CGPoint(x: geometry.size.width * fraction, y: 0))
                path.addLine(to: CGPoint(x: geometry.size.width * fraction, y: geometry.size.height))
                path.move(to: CGPoint(x: 0, y: geometry.size.height * fraction))
                path.addLine(to: CGPoint(x: geometry.size.width, y: geometry.size.height * fraction))
              }
            }.stroke(Cockpit.Color.textTertiary, lineWidth: Cockpit.Stroke.hairline)
          }.allowsHitTesting(false).accessibilityHidden(true)
        }
        Cockpit.Color.text
          .opacity(viewModel.screenFlashOpacity)
          .ignoresSafeArea()
          .allowsHitTesting(false)
      case .noCamera:
        noCamera
      case .denied:
        EmptyState(.photo, "Camera access is off. Allow it in Settings to take photos here.",
                   action: "Open Settings") { openSettings() }
      case .restricted:
        EmptyState(.photo, "The camera is restricted on this phone by Screen Time or a device profile. Change that in Settings to take photos here.",
                   action: "Open Settings") { openSettings() }
      }
      VStack(spacing: 0) {
        Spacer()
        if viewModel.phase == .ready { lensControls }
        failed
        controls
      }
    }
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button { viewModel.showsGrid.toggle() } label: {
          Image(systemName: "grid")
            .foregroundStyle(Cockpit.Color.text)
        }
        .cameraDark()
        .accessibilityLabel("Composition grid")
        .accessibilityValue(viewModel.showsGrid ? "On" : "Off")
        .accessibilityIdentifier("camera.grid")
      }
      ToolbarItem(placement: .topBarLeading) {
        Button {
          viewModel.cycleFlash()
        } label: {
          Image(systemName: flashSymbol)
            .foregroundStyle(Cockpit.Color.text)
        }
        .cameraDark()
        .accessibilityIdentifier("camera.flash")
        .accessibilityLabel("Flash \(viewModel.flash.rawValue)")
        .disabled(viewModel.phase != .ready)
      }
    }
    .modifier(CameraAppearance())
    .toolbarBackground(.hidden, for: .navigationBar)
    .navigationBarTitleDisplayMode(.inline)
    .task {
      isVisible = true
      await viewModel.prepare()
    }
    .onDisappear {
      isVisible = false
      Task { await viewModel.pause() }
    }
    .onChange(of: scenePhase) { _, phase in
      guard isVisible else { return }
      Task {
        if phase == .active { await viewModel.resume() } else { await viewModel.pause() }
      }
    }
  }

  @ViewBuilder private var failed: some View {
    if viewModel.phase == .ready, let failure = viewModel.taking.failure ?? viewModel.adjusting.failure {
      let taking = viewModel.taking.failure != nil
      InPlaceLine(failure) { if taking { viewModel.shutter() } else { viewModel.lastAdjustment?() } }
        .padding(.horizontal, Cockpit.Space.s6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { Cockpit.Color.scrim.ignoresSafeArea() }
        .accessibilityIdentifier("camera.failed")
    }
  }

  private var lensControls: some View {
    HStack(spacing: Cockpit.Space.s2) {
      ForEach(viewModel.zoomPresets, id: \.self) { factor in
        let chosen = abs(viewModel.zoom - factor) < 0.05
        let words = factor.formatted(.number.precision(.fractionLength(0...1)))
        Button { viewModel.setZoom(factor) } label: {
          Text(words + "\u{00D7}")
            .cockpit(.monoData)
            .foregroundStyle(chosen ? Cockpit.Color.textInverse : Cockpit.Color.text)
            .frame(width: Cockpit.Size.target, height: Cockpit.Size.target)
            .background {
              if chosen { Circle().fill(Cockpit.Color.text) }
            }
            .cockpitGlass(in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Zoom " + words + " times")
        .accessibilityAddTraits(chosen ? .isSelected : [])
      }
    }
    .padding(.vertical, Cockpit.Space.s2)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("camera.lenses")
    .disabled(viewModel.isCapturing)
  }

  private var flashSymbol: String {
    switch viewModel.flash {
    case .off: "bolt.slash"
    case .on: "bolt.fill"
    case .auto: "bolt.badge.automatic"
    }
  }

  @ViewBuilder
  private var noCamera: some View {
    VStack(spacing: Cockpit.Space.s4) {
      EmptyState(.photo, "This device has no camera. On a phone the live preview shows here.")
        .accessibilityIdentifier("camera.none")
      #if targetEnvironment(simulator)
        Button("Use sample image") { viewModel.recordSample() }
          .buttonStyle(.cockpit(.primary, busy: viewModel.isCapturing))
          .accessibilityIdentifier("camera.sample")
          .actOutcome(viewModel.taking, identifier: "camera.failed") { viewModel.recordSample() }
      #endif
    }
  }

  private func openSettings() {
    if let url = URL(string: UIApplication.openSettingsURLString) {
      UIApplication.shared.open(url)
    }
  }

  private var controls: some View {
    HStack {
      recentThumbnail
        .frame(width: Cockpit.Size.controlLg, height: Cockpit.Size.controlLg)
      Spacer()
      Button(action: viewModel.shutter) {
        ZStack {
          Circle()
            .strokeBorder(Cockpit.Color.text, lineWidth: Cockpit.Stroke.line)
            .frame(width: 84, height: 84)
          Circle()
            .fill(Cockpit.Color.text)
            .frame(width: 72, height: 72)
            .scaleEffect(viewModel.isCapturing && !reduceMotion ? 0.96 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: Cockpit.Duration.instant), value: viewModel.isCapturing)
        }
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("camera.shutter")
      .accessibilityLabel("Take photo")
      .disabled(viewModel.phase != .ready || viewModel.isCapturing)
      Spacer()
      Button(action: viewModel.flip) {
        Image(systemName: "arrow.triangle.2.circlepath")
          .foregroundStyle(Cockpit.Color.text)
          .frame(width: Cockpit.Size.controlLg, height: Cockpit.Size.controlLg)
          .cockpitGlass(in: Circle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("camera.flip")
      .accessibilityLabel("Flip camera")
      .disabled(viewModel.phase != .ready || viewModel.isCapturing)
    }
    .padding(.horizontal, Cockpit.Space.s6)
    .padding(.bottom, Cockpit.Space.s6)
    .padding(.top, Cockpit.Space.s4)
    .background { if viewModel.phase == .ready { Cockpit.Color.scrim.ignoresSafeArea() } }
  }

  @ViewBuilder
  private var recentThumbnail: some View {
    if viewModel.lastShot != nil {
      let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.xs, style: .continuous)
      NavigationLink {
        ShotsGridView(recorder: viewModel.recorder)
      } label: {
        Group {
          if let image = viewModel.lastThumbnail {
            Image(uiImage: image)
              .resizable()
              .scaledToFill()
          } else {
            Cockpit.Color.raised
          }
        }
        .frame(width: Cockpit.Size.controlLg, height: Cockpit.Size.controlLg)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Cockpit.Color.border, lineWidth: Cockpit.Stroke.border))
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("camera.recent")
      .accessibilityLabel("Shots")
    } else {
      Color.clear
    }
  }
}

struct CameraPreviewView: UIViewRepresentable {
  let viewModel: CameraViewModel

  func makeUIView(context: Context) -> PreviewUIView {
    let view = PreviewUIView()
    view.backgroundColor = Self.dark(Cockpit.Color.canvas)
    view.previewLayer.videoGravity = .resizeAspectFill
    viewModel.attach(previewLayer: view.previewLayer)
    view.model = viewModel
    view.addGestureRecognizer(UITapGestureRecognizer(target: view, action: #selector(PreviewUIView.tapped(_:))))
    view.addGestureRecognizer(UIPinchGestureRecognizer(target: view, action: #selector(PreviewUIView.pinched(_:))))
    let exposureDrag = UIPanGestureRecognizer(target: view, action: #selector(PreviewUIView.adjustedExposure(_:)))
    exposureDrag.maximumNumberOfTouches = 1
    view.addGestureRecognizer(exposureDrag)
    return view
  }

  func updateUIView(_ uiView: PreviewUIView, context: Context) {}

  static func dark(_ color: Color) -> UIColor {
    UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
  }

  final class PreviewUIView: UIView {
    weak var model: CameraViewModel?
    private var startingZoom: Double = 1
    private var focusMarker: UIView?
    private var sun: UIImageView?
    private var exposureOrigin = 0.0
    private var markerCenter = CGPoint.zero
    private var hideMarker: DispatchWorkItem?

    @objc func tapped(_ gesture: UITapGestureRecognizer) {
      showFocus(at: gesture.location(in: self), refocus: true)
      scheduleMarkerFade()
    }

    private func showFocus(at point: CGPoint, refocus: Bool) {
      hideMarker?.cancel()
      focusMarker?.removeFromSuperview()
      sun?.removeFromSuperview()
      let location = CGPoint(x: min(max(point.x, 32), bounds.width - 32),
                             y: min(max(point.y, 52), bounds.height - 52))
      markerCenter = location
      if refocus {
        model?.focus(at: previewLayer.captureDevicePointConverted(fromLayerPoint: point))
      }
      let marker = UIView(frame: CGRect(x: location.x - 28, y: location.y - 28, width: 56, height: 56))
      marker.isUserInteractionEnabled = false
      marker.layer.borderWidth = 1
      marker.layer.borderColor = CameraPreviewView.dark(Cockpit.Color.text).cgColor
      marker.layer.cornerRadius = Cockpit.Radius.s2xs
      addSubview(marker)
      focusMarker = marker
      let icon = UIImageView(image: UIImage(systemName: "sun.max.fill"))
      icon.tintColor = CameraPreviewView.dark(Cockpit.Color.text)
      icon.frame = CGRect(x: location.x + (location.x > bounds.width - 90 ? -52 : 36), y: location.y - 8, width: 16, height: 16)
      addSubview(icon)
      sun = icon
    }

    @objc func adjustedExposure(_ gesture: UIPanGestureRecognizer) {
      guard let model else { return }
      switch gesture.state {
      case .began:
        hideMarker?.cancel()
        exposureOrigin = model.exposure
        showFocus(at: focusMarker == nil ? gesture.location(in: self) : markerCenter, refocus: false)
      case .changed:
        let value = CameraExposureGesture.value(start: exposureOrigin,
          verticalTranslation: Double(gesture.translation(in: self).y),
          minimum: model.minimumExposure, maximum: model.maximumExposure)
        model.setExposure(value)
        sun?.center.y = markerCenter.y - CGFloat(value * 16)
      case .ended, .cancelled:
        scheduleMarkerFade()
      default: break
      }
    }

    private func scheduleMarkerFade() {
      hideMarker?.cancel()
      let work = DispatchWorkItem { [weak self] in
        guard let self else { return }
        UIView.animate(withDuration: 0.2, animations: {
          self.focusMarker?.alpha = 0
          self.sun?.alpha = 0
        })
      }
      hideMarker = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: work)
    }

    @objc func pinched(_ gesture: UIPinchGestureRecognizer) {
      if gesture.state == .began { startingZoom = model?.zoom ?? 1 }
      model?.setZoom(startingZoom * Double(gesture.scale))
    }

    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
  }
}

enum CameraThumbnail {
  nonisolated static func make(from bytes: Data, maxPixelSize: Int) -> UIImage? {
    guard let source = CGImageSourceCreateWithData(bytes as CFData, nil) else { return nil }
    return thumbnail(from: source, maxPixelSize: maxPixelSize)
  }

  nonisolated static func load(url: URL, maxPixelSize: Int) async -> UIImage? {
    await Task.detached(priority: .userInitiated) {
      guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
      return thumbnail(from: source, maxPixelSize: maxPixelSize)
    }.value
  }

  nonisolated private static func thumbnail(
    from source: CGImageSource, maxPixelSize: Int
  ) -> UIImage? {
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
      kCGImageSourceShouldCache: false,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    else { return nil }
    return UIImage(cgImage: image)
  }
}

struct ShotsGridView: View {
  let recorder: CameraRecorder
  @State private var shots: [CameraShot] = []
  @State private var loadError: String?

  private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 3)

  var body: some View {
    ScrollView {
      if let loadError {
        InPlaceLine("Shots can't be read. \(loadError)")
          .padding(Cockpit.Space.s4)
      } else if shots.isEmpty {
        EmptyState(.photo, "No shots yet. The photos you take here show here.")
      } else {
        LazyVGrid(columns: columns, spacing: 2) {
          ForEach(shots) { shot in
            NavigationLink {
              ShotDetailView(shot: shot)
            } label: {
              ShotCell(shot: shot)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("camera.shots.cell")
            .accessibilityLabel("Shot \(shot.entry.sequence)")
          }
        }
        .padding(.top, 2)
      }
    }
    .groundColor(Cockpit.Color.canvas)
    .modifier(CameraAppearance())
    .navigationTitle("Shots")
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(Cockpit.Color.canvas, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .accessibilityIdentifier("camera.shots")
    .task {
      do {
        shots = try await recorder.shots()
      } catch {
        loadError = error.localizedDescription
      }
    }
  }
}

private struct ShotCell: View {
  let shot: CameraShot
  @State private var image: UIImage?

  var body: some View {
    Color.clear
      .aspectRatio(1, contentMode: .fit)
      .overlay {
        if let image {
          Image(uiImage: image).resizable().scaledToFill()
        } else {
          Cockpit.Color.raised
        }
      }
      .clipped()
      .task {
        guard image == nil, let url = shot.blobURL else { return }
        image = await CameraThumbnail.load(url: url, maxPixelSize: 400)
      }
  }
}

struct ShotDetailView: View {
  let shot: CameraShot
  @State private var image: UIImage?

  var body: some View {
    ZStack {
      Cockpit.Color.canvas.ignoresSafeArea()
      if let image {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .ignoresSafeArea()
      }
      VStack {
        Spacer()
        VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
          Text(dateText)
            .cockpit(.rowTitle)
            .foregroundStyle(Cockpit.Color.text)
          Text(sizeText)
            .cockpit(.monoData)
            .foregroundStyle(Cockpit.Color.textSecondary)
          Text(hashText)
            .cockpit(.monoData)
            .foregroundStyle(Cockpit.Color.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Cockpit.Space.s4)
        .background { Cockpit.Color.scrim.ignoresSafeArea() }
      }
    }
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(.hidden, for: .navigationBar)
    .modifier(CameraAppearance())
    .accessibilityIdentifier("camera.shot.detail")
    .task {
      guard let url = shot.blobURL else { return }
      image = await CameraThumbnail.load(url: url, maxPixelSize: 2_400)
    }
  }

  private var dateText: String {
    guard let date = shot.observedDate else { return shot.entry.observedAt }
    return Words.stamp(date)
  }

  private var sizeText: String {
    guard let bytes = shot.bytes else { return "Size unknown" }
    return ByteCountFormatter.string(fromByteCount: Int64(clamping: bytes), countStyle: .file)
  }

  private var hashText: String {
    guard let hex = shot.hashHex else { return "sha256 unknown" }
    return "sha256 \(hex.prefix(12))…"
  }
}

enum CameraExposureGesture {
  static func value(start: Double, verticalTranslation: Double, minimum: Double, maximum: Double) -> Double {
    min(max(start - verticalTranslation / 80, minimum), maximum)
  }
}
