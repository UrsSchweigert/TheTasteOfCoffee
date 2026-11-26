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
        let app = XCUIApplication()
        app.launchArguments = [
            "-CupmarkUITestScreen", "rating",
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        app.launch()
        return app
    }

    /// The first element with `identifier`, whatever its type (SwiftUI picks the type).
    @MainActor
    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// Swipes up until `element` can be tapped.
    @MainActor
    private func scrollUntilHittable(_ element: XCUIElement, in app: XCUIApplication, attempts: Int = 20) {
        for _ in 0..<attempts {
            if element.exists && element.isHittable {
                return
            }
            app.swipeUp()
        }
        XCTAssertTrue(element.exists && element.isHittable, "\(element) is not on screen after \(attempts) swipes")
    }

    /// Adds the fixture photo through the stand-in for the picker and waits for its thumbnail.
    @MainActor
    private func addFixturePhoto(_ app: XCUIApplication, expecting count: Int) {
        let pick = app.buttons["brew-photo-pick"]
        scrollUntilHittable(pick, in: app)
        pick.tap()
        let summary = element("brew-photos-summary", in: app)
        let expected = "Brew photos, \(count) of 6"
        let appeared = NSPredicate(format: "label == %@", expected)
        let done = expectation(for: appeared, evaluatedWith: summary)
        wait(for: [done], timeout: 15)
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
        let confirm = app.buttons["Delete Photo"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "the confirmation did not appear")
        XCTAssertTrue(element("brew-photo-thumbnail", in: app).exists, "asking deleted the photo")
        app.buttons["Cancel"].firstMatch.tap()
        XCTAssertTrue(element("brew-photo-thumbnail", in: app).waitForExistence(timeout: 5), "Cancel deleted the photo")

        // Confirm deletes it.
        delete.tap()
        XCTAssertTrue(app.buttons["Delete Photo"].waitForExistence(timeout: 5))
        app.buttons["Delete Photo"].tap()
        let gone = NSPredicate(format: "exists == false")
        wait(for: [expectation(for: gone, evaluatedWith: element("brew-photo-thumbnail", in: app))], timeout: 10)
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
        scrollUntilHittable(pick, in: app)
        XCTAssertFalse(pick.isEnabled, "the picker is still enabled with 6 photos")
        XCTAssertTrue(element("brew-photos-limit", in: app).exists, "the limit is not explained")
    }
}
