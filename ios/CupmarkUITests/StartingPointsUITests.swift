import XCTest

/// Starting points in the recipe list (M2-T47): the app is started on the recipe list with the
/// Debug-only launch argument (`UITestLaunch`, screen `recipes`); its fixture store holds a bag
/// with four recipes. The test opens a method of the starting points, opens a recipe, reads its
/// numbers, copies it, sees it among the user's own recipes, and opens it again to read
/// "Already in your recipes". Nothing is typed (invariant 1). The unit tests
/// (`ReferenceRecipesTests`, `StartingPointModelTests`) check the data, the numbers and the copy
/// rules; this checks the screens, the copy button and the state that replaces it.
///
/// Taps from the list: a method (1), a recipe (2), "Copy to My Recipes" (3).
final class StartingPointsUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    private func launchRecipes() -> XCUIApplication {
        UITestKit.launch(screen: "recipes")
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

    /// Scrolls `element` into the middle band of the window and returns whether it is on screen
    /// and can be tapped. Stops at the end of the scroll (`UITestKit.scrollToMiddle`), where an
    /// element at the end of a list cannot reach the middle, instead of swiping on 25 times.
    @MainActor
    private func scrollToMiddle(_ element: XCUIElement, in app: XCUIApplication, attempts: Int = 15) -> Bool {
        UITestKit.scrollToMiddle(element, in: app, band: 0.15...0.8, attempts: attempts)
    }

    /// Taps the middle of `element` by coordinate until `next` appears, at most `attempts`
    /// times. It never taps again once `next` exists, so a retry cannot hit the next screen.
    @MainActor
    private func tap(_ element: XCUIElement, until next: XCUIElement, in app: XCUIApplication, attempts: Int = 4) -> Bool {
        for _ in 0..<attempts {
            if next.exists {
                return true
            }
            if element.exists {
                element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            }
            if next.waitForExistence(timeout: 4) {
                return true
            }
        }
        return next.exists
    }

    /// Opens the first method of the starting points and its first recipe; returns the label of
    /// the recipe's row, nil (after a failure) when a screen did not open.
    @MainActor
    private func openFirstStartingPoint(in app: XCUIApplication) -> String? {
        let group = element("starting-point-group", in: app)
        guard scrollToMiddle(group, in: app) else {
            attachDiagnostics(app, "missing: a method of the starting points")
            XCTFail("the recipe list shows no starting points")
            return nil
        }
        let row = element("starting-point-row", in: app)
        guard tap(group, until: row, in: app) else {
            attachDiagnostics(app, "missing: the recipes of the method")
            XCTFail("the method did not open")
            return nil
        }
        let label = row.label
        let firstNumber = element("starting-point-dose", in: app)
        guard tap(row, until: firstNumber, in: app) else {
            attachDiagnostics(app, "missing: the reference recipe")
            XCTFail("the reference recipe did not open")
            return nil
        }
        return label
    }

    @MainActor
    private func goBack(_ app: XCUIApplication, until next: XCUIElement) -> Bool {
        for _ in 0..<3 {
            if next.exists {
                return true
            }
            app.navigationBars.buttons.firstMatch.tap()
            if next.waitForExistence(timeout: 5) {
                return true
            }
        }
        return next.exists
    }

    @MainActor
    func testACopiedStartingPointIsInTheUsersRecipesAndCannotBeCopiedAgain() throws {
        let app = launchRecipes()
        let ownRow = element("recipe-row", in: app)
        guard ownRow.waitForExistence(timeout: 30) else {
            attachDiagnostics(app, "missing: the recipe list")
            XCTFail("the recipe list did not appear")
            return
        }

        // 1. The starting points are a section of the list, labelled as reference recipes.
        guard let rowLabel = openFirstStartingPoint(in: app) else {
            return
        }
        XCTAssertFalse(rowLabel.isEmpty, "the recipe's row reads its method and numbers")

        // 2. The numbers: dose, water and ratio always; each one is a single VoiceOver element
        // with its name as label and the number as value.
        for field in ["dose", "water", "ratio"] {
            let number = element("starting-point-\(field)", in: app)
            XCTAssertTrue(number.exists, "the \(field) is shown")
            let value = number.value as? String ?? ""
            XCTAssertFalse(number.label.isEmpty, "the \(field) has a name")
            XCTAssertFalse(value.isEmpty, "the \(field) has a value")
        }
        let ratioValue = element("starting-point-ratio", in: app).value as? String ?? ""
        XCTAssertNotNil(ratioValue.range(of: #"^1:\d+\.\d$"#, options: .regularExpression), "the ratio is read as 1:16.7: \(ratioValue)")
        XCTAssertFalse(element("starting-point-kept", in: app).exists, "not copied yet")

        // 3. One tap copies it into the user's own recipes.
        let copy = element("starting-point-copy", in: app)
        guard copy.waitForExistence(timeout: 10) else {
            attachDiagnostics(app, "missing: the copy button")
            XCTFail("the copy button is not there")
            return
        }
        XCTAssertGreaterThanOrEqual(copy.frame.height, 44, "a 44 point target")
        let kept = element("starting-point-kept", in: app)
        guard tap(copy, until: kept, in: app) else {
            attachDiagnostics(app, "missing: the copied state")
            XCTFail("copying did not show the copied state")
            return
        }
        XCTAssertEqual(kept.label, "Copied to your recipes")
        XCTAssertFalse(element("starting-point-copy", in: app).exists, "no second copy is offered")

        // 4. Back in the list, the recipe is the newest of the user's own recipes.
        guard goBack(app, until: element("starting-point-row", in: app)),
              goBack(app, until: element("starting-point-group", in: app)) else {
            attachDiagnostics(app, "missing: the way back to the list")
            XCTFail("back did not show the recipe list")
            return
        }
        // The way back can leave the list scrolled: the status bar tap scrolls it to the top.
        UITestKit.scrollToTop(app, until: element("recipe-row", in: app), swipes: 10)
        let newest = element("recipe-row", in: app)
        guard newest.exists else {
            attachDiagnostics(app, "missing: the user's recipes")
            XCTFail("the user's recipes are not shown")
            return
        }
        let newestLabel = newest.label
        let sameValues = newestLabel == rowLabel || newestLabel.contains(rowLabel) || rowLabel.contains(newestLabel)
        if !sameValues {
            attachDiagnostics(app, "the newest recipe is not the copy")
        }
        XCTAssertTrue(sameValues, "the newest own recipe '\(newestLabel)' is the copy '\(rowLabel)'")

        // 5. The same starting point again says it is already there, and offers no copy.
        guard openFirstStartingPoint(in: app) != nil else {
            return
        }
        let alreadyThere = element("starting-point-kept", in: app)
        XCTAssertTrue(alreadyThere.waitForExistence(timeout: 10), "the opened recipe is already the user's")
        XCTAssertEqual(alreadyThere.label, "Already in your recipes")
        XCTAssertFalse(element("starting-point-copy", in: app).exists, "no duplicate is offered")
    }
}
