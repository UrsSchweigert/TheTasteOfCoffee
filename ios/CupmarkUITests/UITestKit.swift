import XCTest

/// Helpers the UI tests share (M2-T54). They exist because the slow tests spent their time in
/// scroll loops that could not succeed: a list that has reached its end still got 12 to 25 more
/// swipes (about 3 to 4 seconds each) while the test waited for an element to reach the middle
/// of the window, which an element at the end of the list never does. The helpers stop as soon
/// as a swipe moves nothing. They keep what the tests prove: an element is only believed
/// absent after the list was scrolled to its end, and a tap only happens on a hittable element.
///
/// Nothing is typed (invariant 1): launching, swiping and tapping only.
enum UITestKit {
    /// The UI-test launch argument of the app (`UITestLaunch.argument`) and its animation switch
    /// (`UITestLaunch.disableAnimationsArgument`). The UI-test bundle cannot import the app.
    static let screenArgument = "-CupmarkUITestScreen"
    static let noAnimationsArgument = "-CupmarkUITestDisableAnimations"

    /// Launches the app on `screen`, in English, without animations.
    @MainActor
    static func launch(screen: String, extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [screenArgument, screen] + extraArguments + [
            noAnimationsArgument,
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        app.launch()
        return app
    }

    /// The first element with `identifier`, whatever its type (SwiftUI picks the type).
    @MainActor
    static func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// A cheap picture of the scrolled list: the number of built cells and the frames of the
    /// first and the last. Empty when the screen has no cells (then nothing is known).
    @MainActor
    static func fingerprint(_ app: XCUIApplication) -> String {
        let cells = app.cells
        let count = cells.count
        guard count > 0 else {
            return ""
        }
        return "\(count)|\(cells.element(boundBy: 0).frame)|\(cells.element(boundBy: count - 1).frame)"
    }

    /// Swipes up once and returns whether the content moved. False means the end of the scroll.
    /// A screen without cells is taken as moving, so a caller never stops early on it.
    @MainActor
    @discardableResult
    static func swipeUpIfPossible(_ app: XCUIApplication, velocity: XCUIGestureVelocity = .default) -> Bool {
        let before = fingerprint(app)
        app.swipeUp(velocity: velocity)
        return before.isEmpty || before != fingerprint(app)
    }

    /// Scrolls the list back to its first row with the status bar tap (the system scrolls to the
    /// top), then swipes down while `top` is not hittable, at most `swipes` times.
    @MainActor
    static func scrollToTop(_ app: XCUIApplication, until top: XCUIElement, swipes: Int = 8) {
        if top.exists && top.isHittable {
            return
        }
        let statusBar = app.statusBars.firstMatch
        if statusBar.exists {
            statusBar.tap()
        }
        for _ in 0..<swipes {
            if top.exists && top.isHittable {
                return
            }
            app.swipeDown()
        }
    }

    /// Scrolls until `element` is hittable with its centre in `band` (a fraction of the window's
    /// height, so no bar and not the home indicator is over it) and returns whether it is
    /// hittable. It stops when swipes no longer move the element or the list (an element at the
    /// end of a list cannot reach the middle), and then answers with what is on screen.
    @MainActor
    static func scrollToMiddle(
        _ element: XCUIElement,
        in app: XCUIApplication,
        band: ClosedRange<CGFloat> = 0.2...0.75,
        attempts: Int = 15
    ) -> Bool {
        let height = max(app.windows.firstMatch.frame.height, 1)
        var lastMiddle: CGFloat?
        var stalls = 0
        for _ in 0..<attempts {
            guard element.exists else {
                // A list builds only the rows near the window: look further down. At the end of
                // the list the element is not there.
                if !swipeUpIfPossible(app) {
                    break
                }
                continue
            }
            let middle = element.frame.midY
            let position = middle / height
            if band.contains(position) && element.isHittable {
                return true
            }
            if let lastMiddle, abs(lastMiddle - middle) < 1 {
                stalls += 1
            } else {
                stalls = 0
            }
            // One swipe that moved nothing is conclusive for an element that can be tapped; an
            // element that cannot is given a second one (a swipe can be swallowed).
            if stalls >= (element.isHittable ? 1 : 2) {
                break
            }
            lastMiddle = middle
            // Far away: a normal swipe. Close: a slow one, which does not overshoot the band.
            let far = position > 1 || position < 0
            let velocity: XCUIGestureVelocity = far ? .default : .slow
            if position > band.upperBound {
                app.swipeUp(velocity: velocity)
            } else {
                app.swipeDown(velocity: velocity)
            }
        }
        return element.exists && element.isHittable
    }

    /// Scrolls until `element` can be tapped anywhere in the window.
    @MainActor
    static func scrollUntilHittable(_ element: XCUIElement, in app: XCUIApplication, attempts: Int = 15) -> Bool {
        scrollToMiddle(element, in: app, band: 0...1, attempts: attempts)
    }

    /// The button of a confirmation dialog named `title`: the action sheet's on iPhone, any
    /// button with that label otherwise. Waits once, for whichever shows first (the action
    /// sheet is not looked for on its own with a timeout of its own, which the happy path of an
    /// iOS version without that sheet would always run out). Never an unscoped subscript, which
    /// matches twice while the sheet animates.
    @MainActor
    static func dialogButton(_ title: String, in app: XCUIApplication, timeout: TimeInterval = 10) -> XCUIElement {
        let inSheet = app.sheets.buttons[title].firstMatch
        let anywhere = app.buttons.matching(NSPredicate(format: "label == %@", title)).firstMatch
        _ = anywhere.waitForExistence(timeout: timeout)
        return inSheet.exists ? inSheet : anywhere
    }
}
