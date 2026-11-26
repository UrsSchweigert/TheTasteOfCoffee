import XCTest

/// The method switcher of a bag's averages (M2-T52). The app starts on the shelf of the fixture
/// store with `-CupmarkUITestSecondRatedBrew`: the first bag then has four rated brews, two of
/// them of the first method, so the switcher offers "All Methods" and that method. The test
/// opens the bag, picks the method and sees the count change (4 to 2), then sees that no
/// per-method section is left (one picker and one count only). Nothing is typed (invariant 1).
/// The unit tests (`CoffeeAveragesTests`) check the numbers.
final class CoffeeAveragesSwitcherUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    private func launchShelf() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-CupmarkUITestScreen", "shelf",
            "-CupmarkUITestSecondRatedBrew",
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        app.launch()
        return app
    }

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

    /// Scrolls down until `identifier` exists (a list builds only the rows near the window).
    @MainActor
    private func scrollTo(_ identifier: String, in app: XCUIApplication, attempts: Int = 15) -> XCUIElement? {
        let target = element(identifier, in: app)
        for _ in 0..<attempts {
            if target.exists && target.isHittable {
                return target
            }
            app.swipeUp()
        }
        return target.exists ? target : nil
    }

    @MainActor
    func testPickingAMethodChangesTheCountAndThereAreNoPerMethodSections() throws {
        let app = launchShelf()
        let rows = app.buttons.matching(identifier: "shelf-entry-row")
        guard rows.firstMatch.waitForExistence(timeout: 30) else {
            attachDiagnostics(app, "missing: the shelf")
            XCTFail("the shelf did not appear")
            return
        }
        // Open the bag that shows the switcher (the other bag has no brews).
        var picker: XCUIElement?
        for index in 0..<rows.count {
            rows.element(boundBy: index).tap()
            XCTAssertTrue(element("shelf-entry-brews", in: app).waitForExistence(timeout: 10), "the shelf entry did not open")
            if let found = scrollTo("coffee-averages-method-picker", in: app) {
                picker = found
                break
            }
            app.navigationBars.buttons.firstMatch.tap()
            XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "back did not show the shelf")
        }
        guard let picker else {
            attachDiagnostics(app, "missing: the switcher")
            XCTFail("no bag of the fixture shows the method switcher")
            return
        }
        XCTAssertTrue(picker.label.contains("Method"), "the picker has a label: \(picker.label)")

        let count = element("coffee-averages-count", in: app)
        XCTAssertTrue(count.waitForExistence(timeout: 10), "the count is shown")
        XCTAssertTrue(count.label.contains("4"), "all methods count every rated brew: \(count.label)")

        picker.tap()
        // The identifier may not survive on a menu item: fall back to the first menu button
        // that is not "All Methods" or "Method".
        var option = app.buttons.matching(identifier: "coffee-averages-method-option").firstMatch
        if !option.waitForExistence(timeout: 5) {
            option = app.buttons.matching(NSPredicate(format: "label != %@ AND label != %@ AND label != %@", "All Methods", "Method", "")).firstMatch
        }
        guard option.waitForExistence(timeout: 10) else {
            attachDiagnostics(app, "missing: the method options")
            XCTFail("the menu did not offer a method")
            return
        }
        option.tap()

        guard let chosenCount = scrollTo("coffee-averages-count", in: app) else {
            attachDiagnostics(app, "missing: the count after the pick")
            XCTFail("the count disappeared after picking a method")
            return
        }
        XCTAssertTrue(chosenCount.label.contains("2"), "the count is that of the method: \(chosenCount.label)")
        XCTAssertFalse(chosenCount.label.contains("4"), "not the count of all methods: \(chosenCount.label)")

        // One section only: one picker, one count, no per-method sections.
        let pickers = app.descendants(matching: .any).matching(identifier: "coffee-averages-method-picker")
        XCTAssertEqual(pickers.count, 1, "one switcher")
        let counts = app.descendants(matching: .any).matching(identifier: "coffee-averages-count")
        XCTAssertEqual(counts.count, 1, "one count, no per-method sections")
        for _ in 0..<15 {
            app.swipeUp()
            let headers = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "rated brews:"))
            XCTAssertEqual(headers.count, 0, "no per-method section header")
        }
    }
}
