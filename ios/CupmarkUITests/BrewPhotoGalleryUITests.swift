import XCTest

/// The brew photo gallery (M2-T43). The app is started on the shelf with the Debug-only launch
/// argument (`UITestLaunch`); its fixture store holds three brew photos (two on the brew of the
/// first method, one on the second's). The test opens the gallery from the shelf's toolbar,
/// applies a method filter from the menu, and sees the count change, then clears it and opens a
/// photo. Nothing is typed (invariant 1): the filters are menus.
final class BrewPhotoGalleryUITests: XCTestCase {
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

    /// Waits for `element` to exist; attaches the tree and fails when it does not.
    @MainActor
    private func requireExists(_ element: XCUIElement, _ what: String, in app: XCUIApplication, timeout: TimeInterval = 15) {
        if !element.waitForExistence(timeout: timeout) {
            attachDiagnostics(app, "missing: \(what)")
            XCTFail("\(what) did not appear")
        }
    }

    /// Taps the centre of `element` once it can be tapped; a tap that did not land is tried
    /// again, up to `attempts` times, until `landed` is true.
    @MainActor
    private func tap(_ element: XCUIElement, in app: XCUIApplication, attempts: Int = 3, until landed: () -> Bool) {
        for _ in 0..<attempts {
            guard element.waitForExistence(timeout: 5), element.isHittable else {
                continue
            }
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            if landed() {
                return
            }
        }
        attachDiagnostics(app, "tap did not land: \(element)")
        XCTFail("tapping \(element) had no effect")
    }

    /// Waits until the count's VoiceOver value satisfies `predicate`; attaches the tree and fails
    /// when it does not.
    @MainActor
    private func waitForCount(_ app: XCUIApplication, _ predicate: String, timeout: TimeInterval = 10) {
        let count = element("gallery-count", in: app)
        let reached = expectation(for: NSPredicate(format: predicate), evaluatedWith: count)
        if XCTWaiter().wait(for: [reached], timeout: timeout) != .completed {
            attachDiagnostics(app, "count: \(predicate)")
            XCTFail("the count's value is '\(count.value as? String ?? "none")', expected \(predicate)")
        }
    }

    @MainActor
    private func photoCells(_ app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(identifier: "gallery-photo")
    }

    @MainActor
    func testTheGalleryFromTheShelfIsFilteredByMethodAndTheCountChanges() throws {
        let app = launchShelf()
        requireExists(app.buttons.matching(identifier: "shelf-entry-row").firstMatch, "the shelf", in: app, timeout: 30)

        // Open the gallery from the toolbar.
        let open = element("shelf-photo-gallery", in: app)
        requireExists(open, "the gallery button", in: app)
        XCTAssertEqual(open.label, "Photo Gallery", "the button has a VoiceOver label")
        let count = element("gallery-count", in: app)
        tap(open, in: app) { count.waitForExistence(timeout: 5) }

        // All three fixture photos, with the count as the value.
        waitForCount(app, "value == '3'")
        XCTAssertEqual(count.label, "Brew photos")
        XCTAssertEqual(photoCells(app).count, 3)
        let firstLabel = photoCells(app).element(boundBy: 0).label
        XCTAssertTrue(firstLabel.contains(" bag, "), "the photo's label has method, bag and date: \(firstLabel)")

        // A method filter from the menu: the first method has two of the three photos.
        let methodMenu = element("gallery-method-filter", in: app)
        let firstMethod = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'gallery-method-option-'"))
            .firstMatch
        tap(methodMenu, in: app) { firstMethod.waitForExistence(timeout: 5) }
        let methodLabel = firstMethod.label
        XCTAssertFalse(methodLabel.isEmpty)
        firstMethod.tap()

        waitForCount(app, "value BEGINSWITH '2, filter: '")
        XCTAssertTrue((count.value as? String ?? "").contains(methodLabel), "the value names the filter: \(count.value as? String ?? "none")")
        XCTAssertEqual(photoCells(app).count, 2)
        XCTAssertEqual(methodMenu.value as? String, methodLabel, "the menu's value is the chosen method")

        // Clearing shows all three again.
        let clear = element("gallery-filter-clear", in: app)
        requireExists(clear, "the clear button", in: app)
        tap(clear, in: app) { !clear.exists }
        waitForCount(app, "value == '3'")
        XCTAssertEqual(photoCells(app).count, 3)

        // A photo opens the viewer, with the same label.
        let cell = photoCells(app).element(boundBy: 0)
        let label = cell.label
        let viewer = element("gallery-viewer-photo", in: app)
        tap(cell, in: app) { viewer.waitForExistence(timeout: 10) }
        XCTAssertEqual(viewer.label, label)
    }
}
