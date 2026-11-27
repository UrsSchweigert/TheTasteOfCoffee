import XCTest

/// Brew photos on the rating screen of a brew (M2-T42b). The app is started on the rating of
/// the fixture bag's unrated brew with the Debug-only launch argument (`UITestLaunch`); there,
/// the system photo picker, which runs out of process and cannot be driven, is replaced by a
/// button with the same label and identifier that hands a fixture JPEG to the real encoder and
/// the real store. The camera is hidden (the simulator has none). Nothing is typed (invariant 1).
final class BrewPhotoUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    private func launchRating() -> XCUIApplication {
        UITestKit.launch(screen: "rating")
    }

    /// The first element with `identifier`, whatever its type (SwiftUI picks the type).
    @MainActor
    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// Scrolls until `element` can be tapped; stops at the end of the scroll.
    @MainActor
    private func scrollUntilHittable(_ element: XCUIElement, in app: XCUIApplication, attempts: Int = 15) {
        XCTAssertTrue(UITestKit.scrollUntilHittable(element, in: app, attempts: attempts), "\(element) is not on screen after scrolling")
    }

    /// Scrolls `element` into the middle band of the window, so no other control and not the home
    /// indicator is over it, and returns whether it is on screen and can be tapped. The photo
    /// section is at the end of the form, where an element cannot reach the middle: the scroll
    /// stops there (`UITestKit.scrollToMiddle`) instead of swiping on 25 times.
    @MainActor
    private func scrollToMiddle(_ element: XCUIElement, in app: XCUIApplication, attempts: Int = 15) -> Bool {
        UITestKit.scrollToMiddle(element, in: app, band: 0.25...0.7, attempts: attempts)
    }

    /// Attaches the accessibility tree and prints the section's failure text, so a failed run
    /// explains itself.
    @MainActor
    private func attachDiagnostics(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(string: app.debugDescription)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        let failure = element("brew-photos-error", in: app)
        let failureText = failure.exists ? failure.label : "none"
        let summary = element("brew-photos-summary", in: app).label
        let adding = element("brew-photos-adding", in: app).exists
        print("BREW-PHOTOS-DIAGNOSTIC \(name): failure=\(failureText) summary=\(summary) adding=\(adding)")
    }

    /// Adds the fixture photo through the stand-in for the picker and waits for the count. The
    /// button is scrolled to the middle of the screen and tapped at its centre; a tap that did
    /// not land is tried again after scrolling once more.
    @MainActor
    private func addFixturePhoto(_ app: XCUIApplication, expecting count: Int) {
        let expected = "Brew photos, \(count) of 6"
        for attempt in 1...3 {
            let pick = app.buttons["brew-photo-pick"]
            XCTAssertTrue(scrollToMiddle(pick, in: app), "the picker button is not in view (attempt \(attempt))")
            pick.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            let summary = element("brew-photos-summary", in: app)
            let reached = expectation(for: NSPredicate(format: "label == %@", expected), evaluatedWith: summary)
            if XCTWaiter().wait(for: [reached], timeout: 8) == .completed {
                return
            }
            attachDiagnostics(app, "photo \(count), attempt \(attempt)")
        }
        XCTFail("the count did not reach \(expected); the label is \(element("brew-photos-summary", in: app).label)")
    }

    /// The button of the delete confirmation named `title`: the action sheet's on iPhone, any
    /// button with that label otherwise. Never an unscoped subscript, which matches twice while
    /// the sheet animates.
    @MainActor
    private func dialogButton(_ title: String, in app: XCUIApplication) -> XCUIElement {
        UITestKit.dialogButton(title, in: app)
    }

    @MainActor
    private func waitUntilGone(_ element: XCUIElement, timeout: TimeInterval = 10) {
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element)
        wait(for: [gone], timeout: timeout)
    }

    @MainActor
    func testAFixturePhotoIsAddedShownAndDeletedAfterAConfirmation() throws {
        let app = launchRating()
        XCTAssertTrue(app.buttons["rating-save"].waitForExistence(timeout: 15), "the rating did not appear")

        // No camera on the simulator: the step is hidden, the picker is offered.
        XCTAssertFalse(app.buttons["brew-photo-take"].exists, "the camera step is shown without a camera")
        addFixturePhoto(app, expecting: 1)

        let thumbnail = element("brew-photo-thumbnail", in: app)
        scrollUntilHittable(thumbnail, in: app)
        XCTAssertEqual(thumbnail.label, "Photo 1 of 1", "the photo has a VoiceOver label")
        XCTAssertFalse((thumbnail.value as? String ?? "").isEmpty, "the photo's value is its date")

        // Delete asks first; Cancel keeps the photo.
        let delete = app.buttons["brew-photo-delete"].firstMatch
        scrollUntilHittable(delete, in: app)
        XCTAssertEqual(delete.label, "Delete photo 1 of 1")
        XCTAssertGreaterThanOrEqual(delete.frame.height, 44, "the delete button is at least 44 points high")
        delete.tap()
        let confirm = dialogButton("Delete Photo", in: app)
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "the confirmation did not appear")
        XCTAssertTrue(element("brew-photo-thumbnail", in: app).exists, "asking deleted the photo")
        let cancel = dialogButton("Cancel", in: app)
        XCTAssertTrue(cancel.waitForExistence(timeout: 5), "the confirmation has no Cancel")
        cancel.tap()
        waitUntilGone(confirm)
        XCTAssertTrue(element("brew-photo-thumbnail", in: app).waitForExistence(timeout: 5), "Cancel deleted the photo")

        // Confirm deletes it.
        scrollUntilHittable(delete, in: app)
        delete.tap()
        let again = dialogButton("Delete Photo", in: app)
        XCTAssertTrue(again.waitForExistence(timeout: 5), "the confirmation did not appear the second time")
        again.tap()
        waitUntilGone(element("brew-photo-thumbnail", in: app))
        XCTAssertEqual(element("brew-photos-summary", in: app).label, "Brew photos, 0 of 6")
        XCTAssertTrue(element("brew-photos-empty", in: app).exists)
    }

    @MainActor
    func testTheAddControlIsDisabledAtSixPhotosAndSaysWhy() throws {
        let app = launchRating()
        XCTAssertTrue(app.buttons["rating-save"].waitForExistence(timeout: 15), "the rating did not appear")

        for count in 1...6 {
            addFixturePhoto(app, expecting: count)
        }

        let pick = app.buttons["brew-photo-pick"]
        XCTAssertTrue(scrollToMiddle(pick, in: app), "the picker button is not in view")
        XCTAssertFalse(pick.isEnabled, "the picker is still enabled with 6 photos")
        XCTAssertTrue(element("brew-photos-limit", in: app).exists, "the limit is not explained")
    }
}
