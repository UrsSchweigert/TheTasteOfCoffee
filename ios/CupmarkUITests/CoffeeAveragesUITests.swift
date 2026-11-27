import XCTest

/// "My brews of this coffee" on the shelf entry screen (M2-T44). The app is started on the
/// shelf with the Debug-only launch argument (`UITestLaunch`); its fixture store holds one bag
/// with three rated brews (one per method) and one unrated brew, and a second bag without
/// brews. The test opens the bag with brews and reads the dimension rows and the number of
/// rated brews; a second test opens the bag without brews and reads the empty state. Nothing
/// is typed (invariant 1). The unit tests (`CoffeeAveragesTests`) check the values; this
/// checks that the section is on the screen, read by VoiceOver as "label, x of 10".
final class CoffeeAveragesUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    private func launchShelf() -> XCUIApplication {
        UITestKit.launch(screen: "shelf")
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

    /// Opens the shelf's bags one after the other until one shows the element with
    /// `identifier` (the section's count or its empty state); returns that element.
    @MainActor
    private func openBag(showing identifier: String, in app: XCUIApplication) -> XCUIElement? {
        let rows = app.buttons.matching(identifier: "shelf-entry-row")
        if !rows.firstMatch.waitForExistence(timeout: 30) {
            attachDiagnostics(app, "missing: the shelf")
            XCTFail("the shelf did not appear")
            return nil
        }
        let total = rows.count
        for index in 0..<total {
            rows.element(boundBy: index).tap()
            guard element("shelf-entry-brews", in: app).waitForExistence(timeout: 10) else {
                attachDiagnostics(app, "missing: the shelf entry screen")
                XCTFail("the shelf entry did not open")
                return nil
            }
            let wanted = element(identifier, in: app)
            if wanted.exists || scrollToMiddle(wanted, in: app, attempts: 12) {
                return wanted
            }
            app.navigationBars.buttons.firstMatch.tap()
            if !rows.firstMatch.waitForExistence(timeout: 10) {
                attachDiagnostics(app, "missing: the shelf after back")
                XCTFail("back did not show the shelf")
                return nil
            }
        }
        attachDiagnostics(app, "no bag shows \(identifier)")
        XCTFail("no bag of the fixture shows \(identifier)")
        return nil
    }

    @MainActor
    func testABagWithRatedBrewsShowsTheDimensionRowsAndTheCount() throws {
        let app = launchShelf()
        guard let count = openBag(showing: "coffee-averages-count", in: app) else {
            return
        }

        // The number of rated brews: three of the four fixture brews are rated.
        let countLabel = count.label
        XCTAssertTrue(countLabel.contains("Rated brews"), "the count has its label: \(countLabel)")
        XCTAssertTrue(countLabel.contains("3"), "three rated brews: \(countLabel)")
        XCTAssertFalse(element("coffee-averages-empty", in: app).exists, "no empty state beside the values")

        // The rows, read by scrolling down through the list (it is lazy): each is one element
        // with the criterion as its label and "x of 10" as its value.
        let rows = app.descendants(matching: .any).matching(identifier: "coffee-average-row")
        var seen: [String: String] = [:]
        var idleSwipes = 0
        for _ in 0..<15 where idleSwipes < 2 {
            let before = seen.count
            for index in 0..<rows.count {
                let row = rows.element(boundBy: index)
                if row.exists, !row.label.isEmpty {
                    seen[row.label] = row.value as? String ?? ""
                }
            }
            idleSwipes = seen.count == before ? idleSwipes + 1 : 0
            // The end of the list is a swipe that moves nothing: every row was read by then.
            if !UITestKit.swipeUpIfPossible(app) {
                break
            }
        }
        if seen.count < 8 {
            attachDiagnostics(app, "rows seen: \(seen)")
        }
        // The vocabulary has eight criteria (contracts/vocabulary criteria.json); the unit
        // tests check the order and the values against the generated enum.
        XCTAssertGreaterThanOrEqual(seen.count, 8, "one row per criterion: \(seen)")
        for (label, value) in seen {
            let spoken = value.range(of: #"^\d+(\.\d)? of \d+$"#, options: .regularExpression)
            XCTAssertNotNil(spoken, "\(label) is read as 'x of 10', not '\(value)'")
        }
    }

    @MainActor
    func testABagWithoutRatedBrewsShowsTheEmptyStateAndNoValues() throws {
        let app = launchShelf()
        guard let empty = openBag(showing: "coffee-averages-empty", in: app) else {
            return
        }
        XCTAssertEqual(empty.label, "Rate a brew to see your averages here")
        XCTAssertFalse(element("coffee-averages-count", in: app).exists, "no count without rated brews")
        XCTAssertFalse(element("coffee-average-row", in: app).exists, "no rows, and no zeros, without rated brews")
    }
}
