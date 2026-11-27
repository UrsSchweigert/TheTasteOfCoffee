import XCTest

/// The accessibility pass (M2-T33, docs/04 Non-functional: Dynamic Type and VoiceOver on every
/// control). Each test starts the app on one screen with the Debug-only launch argument
/// `-CupmarkUITestScreen` (`UITestLaunch` in the app: an in-memory store with fixture data, a
/// stub API, a fake sign-in; no network, no Keychain) and runs `performAccessibilityAudit()`
/// at the default text size and at the largest accessibility size. One test per screen; the
/// activity names the size.
///
/// The audits REPORT and do not fail the build (owner, 2026-11-26: the app needs the
/// essentials, not a full accessibility certification). Apple's checker is unsure about
/// system-styled SwiftUI text and its findings go to the log as `AUDIT-ISSUE` lines, to be
/// judged on a device in M2-T34. Because they only report, they do not run on pull requests:
/// CI skips `AccessibilityAuditTests`, and `.github/workflows/ios-audits.yml` runs that class
/// weekly and on demand. `AccessibilityAuditTests` has no assertion of its own: a screen that
/// does not appear is printed as an `AUDIT-ISSUE` line. What gates every pull request is in
/// `AccessibilityVoiceOverTests`: the smoke tests (each screen appears in UI-test mode, and the
/// timer starts), back navigation and the VoiceOver label and value tests. Keep every
/// assertion out of `AccessibilityAuditTests`: CI skips that class, so it would not gate.
///
/// The language is pinned to English so the values read in the VoiceOver tests are known.
/// Nothing is typed anywhere (invariant 1): the tests only tap, swipe and drag.
class AccessibilityUITestCase: XCTestCase {
    /// `UIPreferredContentSizeCategoryName` values: the default size ("Large") and the largest
    /// accessibility size.
    fileprivate enum TextSize: String, CaseIterable {
        case standard = "UICTContentSizeCategoryL"
        case largestAccessibility = "UICTContentSizeCategoryAccessibilityXXXL"
    }

    /// The raw values of `UITestLaunch.Screen` in the app. The UI-test bundle cannot import the
    /// app, so they are written here once.
    fileprivate enum Screen: String {
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

    @MainActor
    fileprivate func launch(_ screen: Screen, size: TextSize) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-CupmarkUITestScreen", screen.rawValue,
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
            // M2-T54: no animations, so no query waits for one to settle.
            UITestKit.noAnimationsArgument,
        ]
        // The default size is the simulator's own. Pinning any size, even the default one, makes
        // the audit report every text as unable to change its size.
        if size != .standard {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", size.rawValue]
        }
        app.launch()
        return app
    }

    /// Scrolls the screen until `element` can be tapped; stops at the end of the scroll
    /// (`UITestKit.scrollUntilHittable`). This base-class helper holds an XCTAssertTrue; the
    /// audit class only calls it from the timer's `prepare` and has no assertion of its own.
    @MainActor
    fileprivate func scrollUntilHittable(_ element: XCUIElement, in app: XCUIApplication, attempts: Int = 15) throws {
        XCTAssertTrue(UITestKit.scrollUntilHittable(element, in: app, attempts: attempts), "\(element) is not on screen after scrolling")
    }
}

/// One audit per screen, at two text sizes. Report-only; see the note above.
final class AccessibilityAuditTests: AccessibilityUITestCase {
    // MARK: - The audited screens

    @MainActor
    func testSignInPassesTheAudit() throws {
        try auditAtBothSizes(.signIn) { app in app.buttons["sign-in-with-apple"] }
    }

    @MainActor
    func testNotConfiguredPassesTheAudit() throws {
        // The root's navigation bar, then the message under it.
        try auditAtBothSizes(.notConfigured, prepare: { app in
            _ = app.staticTexts.firstMatch.waitForExistence(timeout: 5)
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
            // The smoke test in AccessibilityVoiceOverTests gates on the timer starting.
            _ = app.buttons["brew-timer-stop"].waitForExistence(timeout: 5)
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
                // Report, never fail: the smoke tests in AccessibilityVoiceOverTests gate on the screen appearing.
                if !ready(app).waitForExistence(timeout: timeout) {
                    print("AUDIT-ISSUE screen=\(screen.rawValue) size=\(size.rawValue) type=none detail=screen was not shown, not audited")
                    app.terminate()
                    return
                }
                try prepare(app)
                // At the pinned largest size the Dynamic Type check cannot work: the size no longer
                // changes. The other checks (clipping, hit regions, contrast) still run.
                var types = XCUIAccessibilityAuditType.all
                if size == .largestAccessibility {
                    types.remove(.dynamicType)
                } else {
                    // At the default size the clipping check only predicts ("may be clipped at
                    // larger Dynamic Type sizes") and flags system text and fixed-height labels
                    // that grow fine. The run at the largest size checks real clipping.
                    types.remove(.textClipped)
                }
                try app.performAccessibilityAudit(for: types) { issue in
                    let ignored = AccessibilityAuditTests.isKnownFalsePositive(issue, in: app)
                    if !ignored {
                        // Reported, not failed (see the type's comment).
                        // The failure message alone does not say which element it is about.
                        let element = issue.element
                        print(
                            "AUDIT-ISSUE screen=\(screen.rawValue) size=\(size.rawValue)",
                            "type=\(issue.auditType.rawValue)",
                            "detail=\(issue.detailedDescription)",
                            "element=\(element?.elementType.rawValue ?? 0)",
                            "id=\(element?.identifier ?? "-")",
                            "label=\(element?.label ?? "-")",
                            "frame=\(element?.frame ?? .zero)",
                            "issue=\(String(describing: issue))"
                        )
                    }
                    return true
                }
                app.terminate()
            }
        }
    }

    /// The audit's findings this app cannot fix, each for a stated reason. The others are
    /// printed as `AUDIT-ISSUE` lines.
    @MainActor
    private static func isKnownFalsePositive(_ issue: XCUIAccessibilityAuditIssue, in app: XCUIApplication) -> Bool {
        // Two verdicts of the audit are its own uncertainty, not a failure, and are reported
        // for system-styled SwiftUI text only (section headers and footers, navigation bar
        // buttons, empty-state descriptions: text the app does not colour or size itself, and
        // that scales with the system): "Contrast nearly passed" (a marginal
        // ratio against the system's semantic secondary colour) and "Dynamic Type font sizes
        // are partially unsupported". A real "Contrast failed" or "not supported" is still reported.
        let verdict = issue.compactDescription
        if issue.auditType == .contrast, verdict.localizedCaseInsensitiveContains("nearly passed") {
            return true
        }
        if issue.auditType == .dynamicType, verdict.localizedCaseInsensitiveContains("partially unsupported") {
            return true
        }
        guard let element = issue.element, element.exists else {
            return false
        }
        switch issue.auditType {
        case .contrast:
            // A disabled control is dimmed on purpose (Save before every score is set, Reset
            // with no time to reset). WCAG 1.4.3 exempts inactive user interface components.
            // The audit often reports the text inside a disabled button, and that text is
            // enabled on its own: look at the button around it.
            return !element.isEnabled
                || isInside(element, anyOf: app.buttons.matching(NSPredicate(format: "isEnabled == false")))
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
}

/// Gating UI tests: each screen appears (smoke), the timer starts, back navigation, and the
/// VoiceOver label, value and adjusting of controls.
final class AccessibilityVoiceOverTests: AccessibilityUITestCase {
    // MARK: - Smoke: every screen appears in UI-test mode
    //
    // The audits are skipped on pull requests and never fail, so these tests keep the check that
    // each screen starts and shows its main control (and that the timer starts) in the gate.
    // No audit: one launch at the standard size each. Same ready elements as the audits.

    @MainActor
    private func appears(_ screen: Screen, timeout: TimeInterval = 15, ready: (XCUIApplication) -> XCUIElement) {
        let app = launch(screen, size: .standard)
        XCTAssertTrue(ready(app).waitForExistence(timeout: timeout), "\(screen.rawValue) did not appear")
    }

    @MainActor
    func testSignInAppears() throws {
        appears(.signIn) { app in app.buttons["sign-in-with-apple"] }
    }

    @MainActor
    func testNotConfiguredAppears() throws {
        let app = launch(.notConfigured, size: .standard)
        // The root's navigation bar, then the message under it.
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 15), "not-configured did not appear")
        XCTAssertTrue(app.staticTexts.firstMatch.waitForExistence(timeout: 5), "the message did not appear")
    }

    @MainActor
    func testOnboardingAppears() throws {
        // Onboarding shows once the root has waited for the server's profile (5 s, no pull here).
        appears(.onboarding, timeout: 30) { app in app.buttons["onboarding-next"] }
    }

    @MainActor
    func testShelfAppears() throws {
        appears(.shelf) { app in app.buttons["shelf-scan"] }
    }

    @MainActor
    func testScannerFallbackAppears() throws {
        appears(.scannerFallback) { app in app.buttons["scanner-pick-list"] }
    }

    @MainActor
    func testLookupResultAppears() throws {
        appears(.lookupResult) { app in app.buttons["add-to-shelf"] }
    }

    @MainActor
    func testPickListEntryAppears() throws {
        appears(.beanEntry) { app in app.buttons["bean-entry-save"] }
    }

    @MainActor
    func testBrewFormAppears() throws {
        appears(.brewForm) { app in app.buttons["brew-save"] }
    }

    @MainActor
    func testTimerStarts() throws {
        let app = launch(.timer, size: .standard)
        XCTAssertTrue(app.buttons["brew-save"].waitForExistence(timeout: 15), "timer did not appear")
        // The timer is further down the form: scroll to it and start it.
        let start = app.buttons["brew-timer-start"]
        try scrollUntilHittable(start, in: app)
        start.tap()
        XCTAssertTrue(app.buttons["brew-timer-stop"].waitForExistence(timeout: 5), "the timer did not start")
    }

    @MainActor
    func testRatingAppears() throws {
        appears(.rating) { app in app.buttons["rating-save"] }
    }

    @MainActor
    func testRecipesAppear() throws {
        appears(.recipes) { app in app.buttons["recipe-row"].firstMatch }
    }

    @MainActor
    func testStatisticsAppear() throws {
        appears(.statistics) { app in app.cells.firstMatch }
    }

    @MainActor
    func testSettingsAppear() throws {
        appears(.settings) { app in app.switches["settings-consent"] }
    }

    // MARK: - Navigation

    /// M2-T40: back from a brew's rating shows the brew list, not an empty screen with a
    /// warning triangle. Uses the real shelf stack: bag, "Brews", a brew, Back.
    @MainActor
    func testBackFromARatingShowsTheBrewList() throws {
        let app = launch(.shelf, size: .standard)
        let rows = app.buttons.matching(identifier: "shelf-entry-row")
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 30), "the shelf did not appear")
        // The fixture's first bag has the brews; try each bag until one lists a brew.
        var opened = false
        for index in 0..<rows.count {
            rows.element(boundBy: index).tap()
            let brews = app.buttons["shelf-entry-brews"]
            XCTAssertTrue(brews.waitForExistence(timeout: 10), "the shelf entry did not open")
            brews.tap()
            if app.buttons["brew-list-row"].firstMatch.waitForExistence(timeout: 5) {
                opened = true
                break
            }
            app.navigationBars.buttons.firstMatch.tap()
            app.navigationBars.buttons.firstMatch.tap()
            XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10))
        }
        XCTAssertTrue(opened, "no bag of the fixture lists a brew")
        app.buttons["brew-list-row"].firstMatch.tap()
        XCTAssertTrue(app.buttons["rating-save"].waitForExistence(timeout: 10), "the rating did not open")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons["brew-list-row"].firstMatch.waitForExistence(timeout: 10), "back from the rating did not show the brew list")
        XCTAssertFalse(app.buttons["rating-save"].exists, "the rating is still shown")
        XCTAssertFalse(app.buttons["shelf-entry-brews"].exists, "back went past the brew list to the shelf entry")
        XCTAssertFalse(app.images["exclamationmark.triangle"].exists, "a placeholder for a missing destination is shown")
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
        // SwiftUI composes the stepper's label from its title and its value, so it starts with the title.
        XCTAssertTrue(stepper.label.hasPrefix("Dose"), "the stepper's label is \(stepper.label)")
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
}
