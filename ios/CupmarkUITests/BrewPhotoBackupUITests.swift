import XCTest

/// The brew photo backup setting (M2-T45). The app is started on Settings with the Debug-only
/// launch argument (`UITestLaunch`); the setting is a throwaway suite that starts off, and the
/// device's real photo folders are not touched. The test flips the switch on and off and sees
/// its value change. Nothing is typed (invariant 1).
final class BrewPhotoBackupUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    private func launchSettings() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-CupmarkUITestScreen", "settings",
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        app.launch()
        return app
    }

    /// Attaches the accessibility tree, so a failed run explains itself.
    @MainActor
    private func attachDiagnostics(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(string: app.debugDescription)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Scrolls the list a little at a time until `element` can be tapped.
    @MainActor
    private func scrollUntilHittable(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<6 where !(element.exists && element.isHittable) {
            app.swipeUp(velocity: .slow)
        }
    }

    /// Waits until the switch's value is `expected` ("1" on, "0" off).
    @MainActor
    private func waitForValue(_ expected: String, of toggle: XCUIElement, in app: XCUIApplication, timeout: TimeInterval = 5) -> Bool {
        let reached = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", expected), object: toggle)
        return XCTWaiter().wait(for: [reached], timeout: timeout) == .completed
    }

    /// Taps the switch itself (the right end of its row) until its value is `expected`; a tap
    /// that did not land is tried again, up to three times.
    @MainActor
    private func flip(_ toggle: XCUIElement, to expected: String, in app: XCUIApplication) {
        for _ in 0..<3 {
            scrollUntilHittable(toggle, in: app)
            guard toggle.waitForExistence(timeout: 5), toggle.isHittable else {
                continue
            }
            toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
            if waitForValue(expected, of: toggle, in: app, timeout: 3) {
                return
            }
        }
        attachDiagnostics(app, "the switch did not change to \(expected)")
        let current = toggle.value as? String ?? "none"
        XCTFail("the switch's value is '\(current)', expected '\(expected)'")
    }

    @MainActor
    func testTheBrewPhotoBackupSwitchStartsOffAndFlipsOnAndOff() throws {
        let app = launchSettings()
        let toggle = app.switches["settings-photo-backup"]
        if !toggle.waitForExistence(timeout: 30) {
            attachDiagnostics(app, "missing: the brew photo backup switch")
            XCTFail("the brew photo backup switch did not appear")
            return
        }
        scrollUntilHittable(toggle, in: app)

        XCTAssertEqual(toggle.label, "Include brew photos in the device backup")
        XCTAssertEqual(toggle.value as? String, "0", "the default is off")
        let offFooter = app.staticTexts["Brew photos stay on this phone only. If the phone is replaced, they are not restored from a backup."]
        XCTAssertTrue(offFooter.waitForExistence(timeout: 5), "the footer explains the off state")

        flip(toggle, to: "1", in: app)
        let onFooter = app.staticTexts["Brew photos are included in the backup of this phone that you already have with Apple, in iCloud or on a computer."]
        if !onFooter.waitForExistence(timeout: 5) {
            attachDiagnostics(app, "missing: the footer of the on state")
            XCTFail("the footer does not explain the on state")
        }

        flip(toggle, to: "0", in: app)
        XCTAssertTrue(offFooter.waitForExistence(timeout: 5), "the footer explains the off state again")
    }
}
