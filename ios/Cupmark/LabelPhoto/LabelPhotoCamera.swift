import AVFoundation
import ImageIO
import SwiftUI
import UIKit

/// Whether the label photo step is offered (M2-T23).
enum LabelPhotoCameraAvailability: Equatable, Sendable {
    /// A camera is there and access is granted or was never asked (the system asks when the
    /// camera opens).
    case available
    /// A camera is there but access was denied or is restricted: the step shows a Settings
    /// link instead of the camera.
    case permissionDenied
    /// No camera (the simulator, for example): the step is hidden.
    case unavailable

    /// The availability for the device's answers. Pure, so it can be tested without a camera.
    static func resolve(cameraPresent: Bool, authorization: AVAuthorizationStatus) -> LabelPhotoCameraAvailability {
        guard cameraPresent else { return .unavailable }
        switch authorization {
        case .authorized, .notDetermined: return .available
        case .denied, .restricted: return .permissionDenied
        @unknown default: return .unavailable
        }
    }
}

/// Answers whether the label photo camera can be offered. Tests use a fake.
@MainActor
protocol LabelPhotoCameraEnvironment {
    func availability() -> LabelPhotoCameraAvailability
}

/// The device: `UIImagePickerController` reports whether it has a camera, AVFoundation
/// whether access is granted. Never asks for access itself.
@MainActor
struct LiveLabelPhotoCameraEnvironment: LabelPhotoCameraEnvironment {
    func availability() -> LabelPhotoCameraAvailability {
        LabelPhotoCameraAvailability.resolve(
            cameraPresent: UIImagePickerController.isSourceTypeAvailable(.camera),
            authorization: AVCaptureDevice.authorizationStatus(for: .video)
        )
    }
}

extension CGImagePropertyOrientation {
    /// The EXIF orientation with the same meaning as a UIKit image orientation. The cases
    /// share their names but not their raw values (`UIImage.Orientation.right` is 3,
    /// `CGImagePropertyOrientation.right` is 6).
    init(_ orientation: UIImage.Orientation) {
        switch orientation {
        case .up: self = .up
        case .upMirrored: self = .upMirrored
        case .down: self = .down
        case .downMirrored: self = .downMirrored
        case .left: self = .left
        case .leftMirrored: self = .leftMirrored
        case .right: self = .right
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}

extension LabelPhotoCapture {
    /// The pixels and orientation of a camera image. Nil for an image without a `CGImage`.
    init?(_ image: UIImage) {
        guard let cgImage = image.cgImage else { return nil }
        self.init(image: cgImage, orientation: CGImagePropertyOrientation(image.imageOrientation))
    }
}

/// The system camera for one label photo: `UIImagePickerController` with the camera as its
/// only source, photo mode, no editing. There is no photo library source (M2-T23). Present
/// it only when `LabelPhotoCameraAvailability` is `.available`.
///
/// The system UI has its own shutter, "Retake" and "Use Photo" controls with their own
/// accessibility labels and localisation.
struct LabelPhotoCamera: UIViewControllerRepresentable {
    let onCapture: @MainActor (LabelPhotoCapture) -> Void
    let onCancel: @MainActor () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.allowsEditing = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let onCapture: @MainActor (LabelPhotoCapture) -> Void
        private let onCancel: @MainActor () -> Void

        init(onCapture: @escaping @MainActor (LabelPhotoCapture) -> Void, onCancel: @escaping @MainActor () -> Void) {
            self.onCapture = onCapture
            self.onCancel = onCancel
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let image = info[.originalImage] as? UIImage, let capture = LabelPhotoCapture(image) else {
                onCancel()
                return
            }
            onCapture(capture)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }
    }
}
