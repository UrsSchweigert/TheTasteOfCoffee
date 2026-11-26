import XCTest

/// The accessibility pass (M2-T33, docs/04 Non-functional: Dynamic Type and VoiceOver on every
/// control). Each test starts the app on one screen with the Debug-only launch argument
/// `-CupmarkUITestScreen` (`UITestLaunch` in the app: an in-memory store with fixture data, a
/// stub API, a fake sign-in; no network, no Keychain) and runs `performAccessibilityAudit()`
/// at the default text size and at the largest accessibility size. One test per screen, so a
/// failure names the screen; the activity names the size.
///
/// The language is pinned to English so the values read in the VoiceOver tests are known.
/// Nothing is typed anywhere (invariant 1): the tests only tap, swipe and drag.
final class AccessibilityAuditTests: XCTestCase {
    /// `UIPreferredContentSizeCategoryName` values: the default size ("Large") and the largest
    /// accessibility size.
    private enum TextSize: String, CaseIterable {
        case standard = "UICTContentSizeCategoryL"
        case largestAccessibility = "UICTContentSizeCategoryAccessibilityXXXL"
    }

    /// The raw values of `UITestLaunch.Screen` in the app. The UI-test bundle cannot import the
    /// app, so they are written here once.
    private enum Screen: String {
        case signIn = "sign-in"
        case notConfigured = "not-configured"
        case onboarding
        case shelf
        case scannerFallback = "scanner-fallback"
        case lookupResult = "lookup-result"
        case beanEntry = "bean-entry"
        case brewForm = "brew-form"
        case timer
        case rating
        case recipes
        case statistics
        case settings
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    // MARK: - The audited screens

    @MainActor
    func testSignInPassesTheAudit() throws {
        try auditAtBothSizes(.signIn) { app in app.buttons["sign-in-with-apple"] }
    }

    @MainActor
    func testNotConfiguredPassesTheAudit() throws {
        // The root's navigation bar, then the message under it.
        try auditAtBothSizes(.notConfigured, prepare: { app in
            XCTAssertTrue(app.staticTexts.firstMatch.waitForExistence(timeout: 5), "the message did not appear")
        }, ready: { app in app.navigationBars.firstMatch })
    }

    @MainActor
    func testOnboardingPassesTheAudit() throws {
        // Onboarding shows once the root has waited for the server's profile (5 s, no pull here).
        try auditAtBothSizes(.onboarding, timeout: 30) { app in app.buttons["onboarding-next"] }
    }

    @MainActor
    func testShelfPassesTheAudit() throws {
        try auditAtBothSizes(.shelf) { app in app.buttons["shelf-scan"] }
    }

    @MainActor
    func testScannerFallbackPassesTheAudit() throws {
        try auditAtBothSizes(.scannerFallback) { app in app.buttons["scanner-pick-list"] }
    }

    @MainActor
    func testLookupResultPassesTheAudit() throws {
        try auditAtBothSizes(.lookupResult) { app in app.buttons["add-to-shelf"] }
    }

    @MainActor
    func testPickListEntryPassesTheAudit() throws {
        try auditAtBothSizes(.beanEntry) { app in app.buttons["bean-entry-save"] }
    }

    @MainActor
    func testBrewFormPassesTheAudit() throws {
        try auditAtBothSizes(.brewForm) { app in app.buttons["brew-save"] }
    }

    @MainActor
    func testRunningTimerPassesTheAudit() throws {
        try auditAtBothSizes(.timer, prepare: { app in
            // The timer is further down the form: scroll to it and start it.
            let start = app.buttons["brew-timer-start"]
            try scrollUntilHittable(start, in: app)
            start.tap()
            XCTAssertTrue(app.buttons["brew-timer-stop"].waitForExistence(timeout: 5), "the timer did not start")
        }, ready: { app in app.buttons["brew-save"] })
    }

    @MainActor
    func testRatingPassesTheAudit() throws {
        try auditAtBothSizes(.rating) { app in app.buttons["rating-save"] }
    }

    @MainActor
    func testRecipesPassTheAudit() throws {
        try auditAtBothSizes(.recipes) { app in app.buttons["recipe-row"].firstMatch }
    }

    @MainActor
    func testStatisticsPassTheAudit() throws {
        // The first row of the list (the total of brews).
        try auditAtBothSizes(.statistics) { app in app.cells.firstMatch }
    }

    @MainActor
    func testSettingsPassTheAudit() throws {
        try auditAtBothSizes(.settings) { app in app.switches["settings-consent"] }
    }

    // MARK: - VoiceOver label, value and adjusting

    /// A score reads "<criterion>, <score> of 10" and moves along its scale (the slider is the
    /// adjustable element VoiceOver swipes up and down on).
    @MainActor
    func testARatingScoreHasALabelAndAValueOnItsScale() throws {
        let app = launch(.rating, size: .standard)
        XCTAssertTrue(app.buttons["rating-save"].waitForExistence(timeout: 15))
        let slider = app.sliders.firstMatch
        try scrollUntilHittable(slider, in: app)
        XCTAssertFalse(slider.label.isEmpty, "the score has no VoiceOver label")
        XCTAssertEqual(slider.value as? String, "Not set", "an unrated brew's score is not set")
        slider.adjust(toNormalizedSliderPosition: 0.9)
        let value = try XCTUnwrap(slider.value as? String, "the score has no VoiceOver value")
        XCTAssertTrue(value.hasSuffix(" of 10"), "the score's value is not on its scale: \(value)")
        slider.adjust(toNormalizedSliderPosition: 0.1)
        let lower = try XCTUnwrap(slider.value as? String)
        XCTAssertTrue(lower.hasSuffix(" of 10"), lower)
        XCTAssertNotEqual(lower, value, "moving the score did not change its value")
    }

    /// A stepper reads its field and its value with the unit, and its increment sets it.
    @MainActor
    func testABrewStepperHasALabelAndAValueAndIncrements() throws {
        let app = launch(.brewForm, size: .standard)
        XCTAssertTrue(app.buttons["brew-save"].waitForExistence(timeout: 15))
        let stepper = app.steppers.firstMatch
        try scrollUntilHittable(stepper, in: app)
        XCTAssertEqual(stepper.label, "Dose")
        XCTAssertEqual(stepper.value as? String, "Not set")
        let increment = stepper.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "increment")).firstMatch
        if increment.exists {
            increment.tap()
        } else {
            // UIKit lists the stepper's buttons as decrement, then increment.
            stepper.buttons.element(boundBy: stepper.buttons.count - 1).tap()
        }
        let value = try XCTUnwrap(stepper.value as? String)
        XCTAssertTrue(value.hasSuffix(" g"), "the dose is not read with its unit: \(value)")
    }

    /// A pick list reads its title as the label and the pick as the value.
    @MainActor
    func testAPickListHasALabelAndAValue() throws {
        let app = launch(.beanEntry, size: .standard)
        XCTAssertTrue(app.buttons["bean-entry-save"].waitForExistence(timeout: 15))
        let origin = app.buttons["bean-entry-origin"]
        try scrollUntilHittable(origin, in: app)
        XCTAssertEqual(origin.label, "Origin")
        XCTAssertEqual(origin.value as? String, "Not set")
    }

    // MARK: - Helpers

    @MainActor
    private func launch(_ screen: Screen, size: TextSize) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-CupmarkUITestScreen", screen.rawValue,
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        // The default size is the simulator's own. Pinning any size, even the default one, makes
        // the audit report every text as unable to change its size.
        if size != .standard {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", size.rawValue]
        }
        app.launch()
        return app
    }

    /// Launches `screen` at each size, waits for `ready`, runs `prepare` and audits.
    @MainActor
    private func auditAtBothSizes(
        _ screen: Screen,
        timeout: TimeInterval = 15,
        prepare: (XCUIApplication) throws -> Void = { _ in },
        ready: (XCUIApplication) -> XCUIElement
    ) throws {
        for size in TextSize.allCases {
            try XCTContext.runActivity(named: "\(screen.rawValue) at \(size.rawValue)") { _ in
                let app = launch(screen, size: size)
                XCTAssertTrue(ready(app).waitForExistence(timeout: timeout), "\(screen.rawValue) did not appear")
                try prepare(app)
                // At the pinned largest size the Dynamic Type check cannot work: the size no longer
                // changes. The other checks (clipping, hit regions, contrast) still run.
                var types = XCUIAccessibilityAuditType.all
                if size == .largestAccessibility {
                    types.remove(.dynamicType)
                }
                try app.performAccessibilityAudit(for: types) { issue in
                    let ignored = AccessibilityAuditTests.isKnownFalsePositive(issue, in: app)
                    if !ignored {
                        // The failure message alone does not say which element it is about.
                        let element = issue.element
                        print(
                            "AUDIT-ISSUE screen=\(screen.rawValue) size=\(size.rawValue)",
                            "type=\(issue.auditType.rawValue)",
                            "detail=\(issue.detailedDescription)",
                            "element=\(element?.elementType.rawValue ?? 0)",
                            "id=\(element?.identifier ?? "-")",
                            "label=\(element?.label ?? "-")",
                            "frame=\(element?.frame ?? .zero)"
                        )
                    }
                    return ignored
                }
                app.terminate()
            }
        }
    }

    /// The audit's findings this app cannot fix, each for a stated reason. Everything else
    /// fails the test.
    @MainActor
    private static func isKnownFalsePositive(_ issue: XCUIAccessibilityAuditIssue, in app: XCUIApplication) -> Bool {
        guard let element = issue.element, element.exists else {
            return false
        }
        switch issue.auditType {
        case .contrast:
            // A disabled control is dimmed on purpose (Save before every score is set, Reset
            // with no time to reset). WCAG 1.4.3 exempts inactive user interface components.
            return !element.isEnabled
        case .hitRegion:
            // UIKit draws the segments of a segmented control and the buttons of a stepper at
            // its own fixed height; the app does not size them. Only these system controls.
            return [.segmentedControl, .stepper].contains(element.elementType)
                || isInside(element, anyOf: app.segmentedControls)
                || isInside(element, anyOf: app.steppers)
        case .textClipped:
            // The navigation bar truncates its own inline title and back button title at the
            // largest sizes, and shows them in full in the large content viewer on a long
            // press. Only text inside a navigation bar.
            return isInside(element, anyOf: app.navigationBars)
        default:
            return false
        }
    }

    @MainActor
    private static func isInside(_ element: XCUIElement, anyOf containers: XCUIElementQuery) -> Bool {
        let frame = element.frame
        return containers.allElementsBoundByIndex.contains { container in container.frame.contains(frame) }
    }

    /// Swipes the screen up until `element` can be tapped.
    @MainActor
    private func scrollUntilHittable(_ element: XCUIElement, in app: XCUIApplication, attempts: Int = 15) throws {
        for _ in 0..<attempts {
            if element.exists && element.isHittable {
                return
            }
            app.swipeUp()
        }
        XCTAssertTrue(element.exists && element.isHittable, "\(element) is not on screen after \(attempts) swipes")
    }
}
