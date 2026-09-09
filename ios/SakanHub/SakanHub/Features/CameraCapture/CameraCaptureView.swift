import SwiftUI
import AVFoundation

/// Minimal camera test view — verifies the camera permission grant and
/// shows a live preview + capture button. Gated by
/// `FeatureFlags.propertyCameraTestEnabled`.
///
/// This is a TEST surface only. It:
///   - does NOT upload the captured photo (upload lives in the property
///     media flow once approved)
///   - does NOT interact with the financial engine, REGA workflow, or
///     any existing view
///   - is safe to compile with the flag OFF: the view exists but nothing
///     opens it.
struct CameraCaptureView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var camera = CameraCaptureController()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            switch camera.state {
            case .checking:
                ProgressView("جاري التحقق من صلاحية الكاميرا…")
                    .tint(.white).foregroundStyle(.white)

            case .denied:
                permissionDeniedView

            case .ready:
                CameraPreviewLayerView(session: camera.session)
                    .ignoresSafeArea()
                VStack {
                    Spacer()
                    if let img = camera.lastCapturedImage {
                        Image(uiImage: img)
                            .resizable().scaledToFit()
                            .frame(height: 140)
                            .cornerRadius(12)
                            .padding(.bottom, 12)
                    }
                    HStack(spacing: 20) {
                        Button(action: { dismiss() }) {
                            Text("إغلاق").padding(.horizontal, 20).padding(.vertical, 12)
                                .background(.ultraThinMaterial).cornerRadius(30)
                        }
                        Button(action: { camera.capture() }) {
                            Circle().fill(.white).frame(width: 72, height: 72)
                                .overlay(Circle().stroke(.gray, lineWidth: 4).padding(4))
                        }
                    }
                    .padding(.bottom, 40)
                }

            case .failed(let msg):
                VStack(spacing: 12) {
                    Text("خطأ في الكاميرا").font(.headline).foregroundStyle(.white)
                    Text(msg).font(.subheadline).foregroundStyle(.white.opacity(0.8))
                        .multilineTextAlignment(.center).padding(.horizontal, 20)
                    Button("إغلاق") { dismiss() }
                        .padding().background(.white).cornerRadius(10)
                }
            }
        }
        .onAppear { camera.start() }
        .onDisappear { camera.stop() }
    }

    private var permissionDeniedView: some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.slash.fill").font(.system(size: 48)).foregroundStyle(.white)
            Text("لم يتم منح صلاحية الكاميرا")
                .font(.headline).foregroundStyle(.white)
            Text("افتح الإعدادات لتمكين الكاميرا لتطبيق سكن هَب.")
                .font(.subheadline).foregroundStyle(.white.opacity(0.8))
                .multilineTextAlignment(.center).padding(.horizontal, 24)
            Button("فتح الإعدادات") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .padding().background(.white).cornerRadius(10)
            Button("إغلاق") { dismiss() }.foregroundStyle(.white.opacity(0.7))
        }
    }
}

// MARK: - Controller

@MainActor
final class CameraCaptureController: NSObject, ObservableObject, AVCapturePhotoCaptureDelegate {

    enum State: Equatable {
        case checking
        case denied
        case ready
        case failed(String)
    }

    @Published var state: State = .checking
    @Published var lastCapturedImage: UIImage?

    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private let sessionQueue = DispatchQueue(label: "sakan.camera.session")

    func start() {
        AVCaptureDevice.requestAccess(for: .video) { granted in
            DispatchQueue.main.async {
                guard granted else { self.state = .denied; return }
                self.configureSession()
            }
        }
    }

    func stop() {
        sessionQueue.async { [weak self] in
            self?.session.stopRunning()
        }
    }

    func capture() {
        guard state == .ready else { return }
        let settings = AVCapturePhotoSettings()
        sessionQueue.async { [weak self] in
            self?.output.capturePhoto(with: settings, delegate: self!)
        }
    }

    private func configureSession() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            self.session.beginConfiguration()
            self.session.sessionPreset = .photo

            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
                  let input = try? AVCaptureDeviceInput(device: device),
                  self.session.canAddInput(input) else {
                DispatchQueue.main.async { self.state = .failed("لا توجد كاميرا خلفية متاحة.") }
                return
            }
            self.session.addInput(input)
            if self.session.canAddOutput(self.output) { self.session.addOutput(self.output) }

            self.session.commitConfiguration()
            self.session.startRunning()
            DispatchQueue.main.async { self.state = .ready }
        }
    }

    // MARK: AVCapturePhotoCaptureDelegate

    nonisolated func photoOutput(_ output: AVCapturePhotoOutput,
                                 didFinishProcessingPhoto photo: AVCapturePhoto,
                                 error: Error?) {
        guard error == nil,
              let data = photo.fileDataRepresentation(),
              let img = UIImage(data: data) else { return }
        Task { @MainActor in self.lastCapturedImage = img }
    }
}

// MARK: - UIKit preview

import UIKit

struct CameraPreviewLayerView: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.videoPreviewLayer.session = session
        v.videoPreviewLayer.videoGravity = .resizeAspectFill
        return v
    }
    func updateUIView(_ uiView: PreviewView, context: Context) {}

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var videoPreviewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}
