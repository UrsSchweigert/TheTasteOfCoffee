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
        UITestKit.launch(screen: "statistics")
    }

    /// The first element with `identifier`, whatever its type (SwiftUI picks the type).
    @MainActor
    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// Which of `identifiers` are somewhere on the screen. A list builds only the rows near the
    /// window, so an element far down does not exist until it is scrolled to: scroll down in
    /// steps to the end of the list (a swipe that moves nothing), looking after every step, then
    /// back to the top. "Absent" is only believed after scrolling the whole screen. One scan
    /// answers for both rows of a state (M2-T54), where each used to scroll the list on its own.
    @MainActor
    private func scan(_ identifiers: [String], in app: XCUIApplication, steps: Int = 10) -> Set<String> {
        var found = Set<String>()
        func look() {
            for identifier in identifiers where !found.contains(identifier) && element(identifier, in: app).exists {
                found.insert(identifier)
            }
        }
        look()
        var swipes = 0
        while found.count < identifiers.count && swipes < steps {
            let moved = UITestKit.swipeUpIfPossible(app)
            swipes += 1
            look()
            if !moved {
                break
            }
        }
        if swipes > 0 {
            UITestKit.scrollToTop(app, until: element("statistics-method-picker", in: app), swipes: steps)
        }
        return found
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
        let rows = ["statistics-best-method", "statistics-method-below"]
        let allMethods = scan(rows, in: app)
        XCTAssertTrue(allMethods.contains("statistics-best-method"), "all methods compare methods")
        XCTAssertFalse(allMethods.contains("statistics-method-below"), "no empty state of a method yet")

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

        XCTAssertTrue(element("statistics-brews-total", in: app).waitForExistence(timeout: 10))
        let oneMethod = scan(rows, in: app)
        guard oneMethod.contains("statistics-method-below") else {
            attachDiagnostics(app, "missing: the empty state of the method")
            XCTFail("a method below the threshold did not show its empty state")
            return
        }
        XCTAssertFalse(oneMethod.contains("statistics-best-method"), "one method has nothing to compare")
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
        XCTAssertTrue(element("statistics-brews-total", in: app).waitForExistence(timeout: 10))
        let allAgain = scan(rows, in: app)
        XCTAssertTrue(allAgain.contains("statistics-best-method"), "the best method is back")
        XCTAssertFalse(allAgain.contains("statistics-method-below"))
        XCTAssertTrue(element("statistics-brews-total", in: app).label.contains("4"), "all methods again")
    }
}
