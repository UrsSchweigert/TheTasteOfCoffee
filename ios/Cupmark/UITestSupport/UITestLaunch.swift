#if DEBUG
import Foundation
import UIKit

/// The launch argument of the UI tests (M2-T33): `-CupmarkUITestScreen <screen>` starts the app
/// on one screen with an in-memory store, fixture data and a stub API (`UITestHarness`). No
/// network, no Keychain, no Cognito and no real sign-in are used.
///
/// Debug builds only: every file of `UITestSupport/` is inside `#if DEBUG`, and so is the one
/// place in `CupmarkApp` that reads this, so a Release build has neither the argument nor the
/// code it starts (`scripts/ios-scripts.test.mjs` checks both). Without the argument a Debug
/// build runs exactly the app's own start.
struct UITestLaunch: Equatable, Sendable {
    /// The argument's name. The next argument is the screen's raw value.
    static let argument = "-CupmarkUITestScreen"
    /// Optional second argument (M2-T54): no animations in this launch. Transitions, sheets and
    /// the system's own animations then end at once, so the UI test waits for no animation to
    /// settle before the next query. Without it the app animates as always.
    static let disableAnimationsArgument = "-CupmarkUITestDisableAnimations"

    /// The screens the UI tests audit (M2-T33 acceptance) and the other start states.
    enum Screen: String, CaseIterable, Sendable {
        /// Signed out: the sign-in screen, through `RootView` and `AuthGate`.
        case signIn = "sign-in"
        /// The stage configuration is missing: the "not configured" screen.
        case notConfigured = "not-configured"
        /// Signed in, with a store without a profile: onboarding, through `RootView`.
        case onboarding
        /// Signed in, with a profile: the shelf, through `RootView`.
        case shelf
        /// The scan flow on a device that cannot scan (the simulator): the scanner's fallback.
        case scannerFallback = "scanner-fallback"
        /// The lookup of the fixture barcode, answered by the stub API with a catalogue bean.
        case lookupResult = "lookup-result"
        /// The pick-list bean entry for the fixture barcode.
        case beanEntry = "bean-entry"
        /// The brew form of the fixture bag.
        case brewForm = "brew-form"
        /// The brew form as a repeat of the last brew, prefilled, with the timer ready.
        case timer
        /// The rating of the fixture bag's unrated brew.
        case rating
        /// Every recipe of the fixture bag.
        case recipes
        /// The personal statistics of the fixture data.
        case statistics
        /// Settings.
        case settings
    }

    let screen: Screen
    /// Whether the launch asked for no animations (`disableAnimationsArgument`).
    let animationsDisabled: Bool

    /// The launch of `arguments` (`ProcessInfo.processInfo.arguments`), nil without the
    /// argument or with a value that names no screen; the app then starts as it always does.
    init?(arguments: [String]) {
        guard let index = arguments.firstIndex(of: UITestLaunch.argument) else {
            return nil
        }
        let valueIndex = arguments.index(after: index)
        guard valueIndex < arguments.endIndex, let screen = Screen(rawValue: arguments[valueIndex]) else {
            return nil
        }
        self.screen = screen
        self.animationsDisabled = arguments.contains(UITestLaunch.disableAnimationsArgument)
    }

    /// Turns the UIKit animations off when the launch asked for it (the SwiftUI ones are turned
    /// off by `UITestRootView`). Called once, on the main actor, before the screen is made.
    @MainActor
    func applyAnimationSetting() {
        if animationsDisabled {
            UIView.setAnimationsEnabled(false)
        }
    }
}
#endif
