import XCTest

/// The method picker of the statistics (M2-T50). The app starts on the statistics of the
/// fixture store (`UITestLaunch`): four brews of three methods, one rated brew each, below the
/// per-method threshold. The test picks a method from the menu and sees the sections change
/// (the brew total drops, the best method row goes, the taste profile shows its empty state),
/// then picks "All Methods" and sees them come back. Nothing is typed (invariant 1). The unit
/// tests (`StatisticsMethodPickerTests`) check the numbers.
final class StatisticsMethodPickerUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    private func launchStatistics() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-CupmarkUITestScreen", "statistics",
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

    @MainActor
    private func attachDiagnostics(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(string: app.debugDescription)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    func testPickingAMethodChangesTheSectionsAndAllMethodsBringsThemBack() throws {
        let app = launchStatistics()
        let picker = element("statistics-method-picker", in: app)
        guard picker.waitForExistence(timeout: 30) else {
            attachDiagnostics(app, "missing: the picker")
            XCTFail("the statistics did not show the method picker")
            return
        }
        XCTAssertTrue(picker.label.contains("Method"), "the picker has a label: \(picker.label)")
        let total = element("statistics-brews-total", in: app)
        XCTAssertTrue(total.waitForExistence(timeout: 10), "the brew total is shown")
        // Four brews in the fixture: one unrated, three rated, of three methods.
        XCTAssertTrue(total.label.contains("4"), "all methods count every brew: \(total.label)")
        XCTAssertTrue(element("statistics-best-method", in: app).exists, "all methods compare methods")
        XCTAssertFalse(element("statistics-method-below", in: app).exists, "no empty state of a method yet")

        // Pick the first method the menu offers.
        picker.tap()
        // The identifier may not survive on a menu item: fall back to the first menu button
        // that is not "All Methods".
        var option = app.buttons.matching(identifier: "statistics-method-option").firstMatch
        if !option.waitForExistence(timeout: 5) {
            option = app.buttons.matching(NSPredicate(format: "label != %@ AND label != %@ AND label != %@", "All Methods", "Method", "")).firstMatch
        }
        guard option.waitForExistence(timeout: 10) else {
            attachDiagnostics(app, "missing: the method options")
            XCTFail("the menu did not offer a method")
            return
        }
        option.tap()

        let below = element("statistics-method-below", in: app)
        guard below.waitForExistence(timeout: 10) else {
            attachDiagnostics(app, "missing: the empty state of the method")
            XCTFail("a method below the threshold did not show its empty state")
            return
        }
        XCTAssertFalse(element("statistics-best-method", in: app).exists, "one method has nothing to compare")
        // The first method has two of the fixture's four brews (one rated, the newest unrated).
        let methodTotal = element("statistics-brews-total", in: app).label
        XCTAssertTrue(methodTotal.contains("2"), "the total is that of the method: \(methodTotal)")
        XCTAssertFalse(methodTotal.contains("4"), "not the total of all methods: \(methodTotal)")

        // Back to all methods.
        element("statistics-method-picker", in: app).tap()
        let all = app.buttons["All Methods"]
        guard all.waitForExistence(timeout: 10) else {
            attachDiagnostics(app, "missing: All Methods")
            XCTFail("the menu did not offer all methods")
            return
        }
        all.tap()
        XCTAssertTrue(element("statistics-best-method", in: app).waitForExistence(timeout: 10), "the best method is back")
        XCTAssertFalse(element("statistics-method-below", in: app).exists)
        XCTAssertTrue(element("statistics-brews-total", in: app).label.contains("4"), "all methods again")
    }
}
