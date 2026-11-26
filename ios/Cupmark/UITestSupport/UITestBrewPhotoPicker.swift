#if DEBUG
import SwiftUI
import UIKit

/// The stand-in for the system photo picker in a UI-test launch (M2-T42b). `PhotosPicker` runs
/// out of process and cannot be driven by the harness, so the photos section shows a button with
/// the same label and identifier that returns a fixture JPEG, which then goes through the real
/// encoder and the real store. Present only in Debug builds (every file of `UITestSupport/` is
/// inside `#if DEBUG`).
struct UITestBrewPhotoPicker: Sendable {
    /// The fixture picture as JPEG data.
    func data() -> Data {
        UITestBrewPhotoPicker.fixtureJPEG()
    }

    /// A 160 by 120 picture of two grey bands, drawn in code, as JPEG data.
    static func fixtureJPEG() -> Data {
        let size = CGSize(width: 160, height: 120)
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { context in
            UIColor(white: 0.25, alpha: 1).setFill()
            context.fill(CGRect(origin: .zero, size: size))
            UIColor(white: 0.8, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 60, width: 160, height: 60))
        }
        return image.jpegData(compressionQuality: 0.8) ?? Data()
    }
}

private struct UITestBrewPhotoPickerKey: EnvironmentKey {
    static let defaultValue: UITestBrewPhotoPicker? = nil
}

extension EnvironmentValues {
    /// Set by the UI-test harness; nil in the app.
    var uiTestBrewPhotoPicker: UITestBrewPhotoPicker? {
        get { self[UITestBrewPhotoPickerKey.self] }
        set { self[UITestBrewPhotoPickerKey.self] = newValue }
    }
}
#endif
