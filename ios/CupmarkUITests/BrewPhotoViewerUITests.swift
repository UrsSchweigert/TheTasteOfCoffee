import XCTest

/// The brew photo viewer (M2-T43b). The app is started on the shelf with the Debug-only launch
/// argument (`UITestLaunch`); its fixture store holds three brew photos on rated brews, and a
/// saved recipe with the same parameters as each of the first brews. Each test opens the gallery
/// from the shelf's toolbar and the first photo (the newest, on the brew of the first method),
/// then follows one link or deletes. Nothing is typed (invariant 1): links and buttons only.
final class BrewPhotoViewerUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    private func launchShelf() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-CupmarkUITestScreen", "shelf",
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

    /// Attaches the accessibility tree, so a failed run explains itself.
    @MainActor
    private func attachDiagnostics(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(string: app.debugDescription)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    private func requireExists(_ element: XCUIElement, _ what: String, in app: XCUIApplication, timeout: TimeInterval = 15) {
        if !element.waitForExistence(timeout: timeout) {
            attachDiagnostics(app, "missing: \(what)")
            XCTFail("\(what) did not appear")
        }
    }

    /// Scrolls `element` into the middle band of the window, so no other control and not the home
    /// indicator is over it, and returns whether it got there.
    @MainActor
    private func scrollToMiddle(_ element: XCUIElement, in app: XCUIApplication, attempts: Int = 25) -> Bool {
        let window = app.windows.firstMatch.frame
        for _ in 0..<attempts {
            if element.exists && element.isHittable {
                let middle = element.frame.midY
                if middle > window.height * 0.25 && middle < window.height * 0.7 {
                    return true
                }
                if middle >= window.height * 0.7 {
                    app.swipeUp(velocity: .slow)
                } else {
                    app.swipeDown(velocity: .slow)
                }
            } else {
                app.swipeUp()
            }
        }
        return element.exists && element.isHittable
    }

    /// Scrolls `element` to the middle and taps its centre; a tap that did not land (`landed`
    /// stays false) is tried again, up to three times.
    @MainActor
    private func tap(_ element: XCUIElement, _ what: String, in app: XCUIApplication, until landed: () -> Bool) {
        for _ in 0..<3 {
            guard scrollToMiddle(element, in: app) else {
                continue
            }
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            if landed() {
                return
            }
        }
        attachDiagnostics(app, "tap did not land: \(what)")
        XCTFail("tapping \(what) had no effect")
    }

    /// Opens the gallery and its newest photo; returns once the viewer shows the photo's label.
    @MainActor
    private func openViewer(_ app: XCUIApplication) -> String {
        requireExists(app.buttons.matching(identifier: "shelf-entry-row").firstMatch, "the shelf", in: app, timeout: 30)
        let open = element("shelf-photo-gallery", in: app)
        requireExists(open, "the gallery button", in: app)
        let count = element("gallery-count", in: app)
        open.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        requireExists(count, "the gallery", in: app)

        let cell = app.descendants(matching: .any).matching(identifier: "gallery-photo").element(boundBy: 0)
        requireExists(cell, "a photo in the gallery", in: app)
        let label = cell.label
        let photo = element("gallery-viewer-photo", in: app)
        tap(cell, "the first photo", in: app) { photo.waitForExistence(timeout: 10) }
        return label
    }

    /// Waits until `element` no longer exists (a dialog that closes, a screen that is left).
    @MainActor
    private func waitUntilGone(_ element: XCUIElement, timeout: TimeInterval = 10) {
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element)
        wait(for: [gone], timeout: timeout)
    }

    /// The button of the delete confirmation named `title`: the action sheet's on iPhone. Never
    /// an unscoped subscript, which matches twice while the sheet animates.
    @MainActor
    private func dialogButton(_ title: String, in app: XCUIApplication) -> XCUIElement {
        let inSheet = app.sheets.buttons[title].firstMatch
        if inSheet.waitForExistence(timeout: 5) {
            return inSheet
        }
        return app.buttons.matching(NSPredicate(format: "label == %@", title)).firstMatch
    }

    // MARK: - Tests

    @MainActor
    func testTheViewerShowsThePhotoWithTheGridLabelAndTheBrewsDetails() throws {
        let app = launchShelf()
        let label = openViewer(app)

        let photo = element("gallery-viewer-photo", in: app)
        XCTAssertEqual(photo.label, label, "the viewer's image has the label of the grid's cell")

        // Method, dose, ratio and grind are set on the fixture brews; the brew is rated.
        for field in ["method", "dose", "ratio", "grind"] {
            let row = element("viewer-detail-\(field)", in: app)
            if !row.exists {
                _ = scrollToMiddle(row, in: app)
            }
            requireExists(row, "the \(field) detail", in: app, timeout: 5)
            XCTAssertFalse(row.label.isEmpty, "the \(field) detail has a label")
            XCTAssertFalse((row.value as? String ?? "").isEmpty, "the \(field) detail has a value")
        }
        let score = element("viewer-detail-score", in: app)
        _ = scrollToMiddle(score, in: app)
        requireExists(score, "the overall score", in: app, timeout: 5)
        XCTAssertTrue((score.value as? String ?? "").hasSuffix(" of 10"), "the score is read on its scale: \(score.value as? String ?? "none")")

        // The links and delete have labels.
        XCTAssertTrue(element("viewer-link-brew", in: app).exists || scrollToMiddle(element("viewer-link-brew", in: app), in: app))
        let delete = element("viewer-delete", in: app)
        _ = scrollToMiddle(delete, in: app)
        XCTAssertEqual(delete.label, "Delete this photo")
        XCTAssertGreaterThanOrEqual(delete.frame.height, 44, "the delete button is at least 44 points high")
    }

    @MainActor
    func testTheBrewLinkOpensTheRatingOfTheBrew() throws {
        let app = launchShelf()
        _ = openViewer(app)

        let link = element("viewer-link-brew", in: app)
        let rating = element("rating-save", in: app)
        tap(link, "the brew link", in: app) { rating.waitForExistence(timeout: 10) }
        XCTAssertTrue(element("brew-photos-summary", in: app).waitForExistence(timeout: 5) || scrollToMiddle(element("brew-photos-summary", in: app), in: app), "the rating screen has the photos section")
    }

    @MainActor
    func testTheBagLinkOpensTheBagsScreen() throws {
        let app = launchShelf()
        _ = openViewer(app)

        let link = element("viewer-link-bag", in: app)
        let bag = element("shelf-entry-brews", in: app)
        tap(link, "the bag link", in: app) { bag.waitForExistence(timeout: 10) }
    }

    @MainActor
    func testTheRecipeLinkShowsTheMatchingRecipeAndOffersABrew() throws {
        let app = launchShelf()
        _ = openViewer(app)

        let link = element("viewer-link-recipe", in: app)
        let values = element("recipe-detail-values", in: app)
        tap(link, "the recipe link", in: app) { values.waitForExistence(timeout: 10) }
        XCTAssertFalse(values.label.isEmpty, "the recipe's values are read")

        // "Brew from This Recipe" opens the brew form, prefilled.
        let brew = element("recipe-detail-brew", in: app)
        let save = element("brew-save", in: app)
        tap(brew, "Brew from This Recipe", in: app) { save.waitForExistence(timeout: 10) }
    }

    @MainActor
    func testDeletingAfterAConfirmationReturnsToTheGalleryAndTheGridUpdates() throws {
        let app = launchShelf()
        _ = openViewer(app)

        let delete = element("viewer-delete", in: app)
        XCTAssertTrue(scrollToMiddle(delete, in: app), "the delete button is not in view")
        delete.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        // Asking deletes nothing; Cancel keeps the photo.
        let confirm = dialogButton("Delete Photo", in: app)
        requireExists(confirm, "the confirmation", in: app, timeout: 5)
        XCTAssertTrue(element("gallery-viewer-photo", in: app).exists, "asking deleted the photo")
        let cancel = dialogButton("Cancel", in: app)
        requireExists(cancel, "Cancel", in: app, timeout: 5)
        cancel.tap()
        waitUntilGone(confirm)
        XCTAssertTrue(element("gallery-viewer-photo", in: app).exists, "Cancel deleted the photo")

        // Confirm: the viewer closes, the gallery shows one photo fewer.
        XCTAssertTrue(scrollToMiddle(delete, in: app), "the delete button is not in view the second time")
        delete.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let again = dialogButton("Delete Photo", in: app)
        requireExists(again, "the confirmation the second time", in: app, timeout: 5)
        again.tap()
        waitUntilGone(again)
        waitUntilGone(element("gallery-viewer-photo", in: app))

        let count = element("gallery-count", in: app)
        requireExists(count, "the gallery after the delete", in: app)
        let reached = expectation(for: NSPredicate(format: "value == '2'"), evaluatedWith: count)
        if XCTWaiter().wait(for: [reached], timeout: 10) != .completed {
            attachDiagnostics(app, "count after delete")
            XCTFail("the count's value is '\(count.value as? String ?? "none")', expected 2")
        }
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "gallery-photo").count, 2)
    }
}
