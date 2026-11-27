import XCTest

/// Averages in context (M2-T48): the marker on a rating slider after it was moved, the summary
/// row at the top of a coffee's screen, and the averages on the brew list rows. The app is
/// started with the Debug-only launch argument (`UITestLaunch`) on the `rating` and `shelf`
/// screens; the fixture store's first bag holds three rated brews and one unrated brew (the
/// one the `rating` screen opens), so the unrated brew has three other rated brews of its bag
/// and a marker can show. A second bag has no brews. Nothing is typed (invariant 1). The unit
/// tests (`CoffeeAveragesTests`, `RatingMarkerTests`, `BrewListTests`) check the numbers; this
/// checks the screens show them where the owner looks.
final class AveragesInContextUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    private func launch(_ screen: String) -> XCUIApplication {
        UITestKit.launch(screen: screen)
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

    /// The elements whose identifier starts with `prefix`.
    @MainActor
    private func elements(withPrefix prefix: String, in app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix))
    }

    // MARK: - Rating sliders

    @MainActor
    func testTheMarkerAppearsOnlyAfterTheSliderWasMovedAndKeepsTheValue() throws {
        let app = launch("rating")
        XCTAssertTrue(app.buttons["rating-save"].waitForExistence(timeout: 30), "the rating screen did not appear")
        let slider = app.sliders.firstMatch
        XCTAssertTrue(slider.waitForExistence(timeout: 10))
        XCTAssertTrue(scrollToMiddle(slider, in: app), "the first slider did not scroll into view")

        // Nothing is marked before a score is set, so the average cannot anchor the rating.
        XCTAssertEqual(slider.value as? String, "Not set")
        XCTAssertEqual(elements(withPrefix: "rating-marker-", in: app).count, 0, "a marker is shown before the slider was moved")

        // Move the slider with the accessibility adjustment, with retries at other positions
        // (the first can be swallowed by a scroll in progress).
        var marker = elements(withPrefix: "rating-marker-", in: app).firstMatch
        for position in [0.8, 0.3, 0.9] where !marker.exists {
            slider.adjust(toNormalizedSliderPosition: position)
            _ = marker.waitForExistence(timeout: 5)
            marker = elements(withPrefix: "rating-marker-", in: app).firstMatch
        }
        if !marker.exists {
            attachDiagnostics(app, "missing: the marker after moving the slider")
        }
        XCTAssertTrue(marker.exists, "no marker after the slider was moved")

        // Read as "Your average for this coffee, 7.5 of 10", beside the slider's own value.
        let spoken = marker.label
        XCTAssertNotNil(
            spoken.range(of: #"^Your average for this coffee, \d+(\.\d)? of \d+$"#, options: .regularExpression),
            "the marker is read as '\(spoken)'"
        )
        let value = try XCTUnwrap(slider.value as? String, "the slider has no value")
        XCTAssertNotNil(value.range(of: #"^\d+(\.\d)? of \d+$"#, options: .regularExpression), "the slider's value is '\(value)'")
        XCTAssertFalse(slider.label.isEmpty, "the slider kept its label")

        // The marker is a fixed average: moving the slider again changes the value, not the marker.
        slider.adjust(toNormalizedSliderPosition: 0.2)
        let moved = try XCTUnwrap(slider.value as? String)
        XCTAssertNotEqual(moved, value, "the slider no longer moves")
        XCTAssertEqual(elements(withPrefix: "rating-marker-", in: app).firstMatch.label, spoken, "the marker followed the score")
        XCTAssertEqual(elements(withPrefix: "rating-marker-", in: app).count, 1, "only the moved slider has a marker")
    }

    // MARK: - The coffee's screen

    @MainActor
    func testTheSummaryRowIsAtTheTopOfABagWithRatedBrewsAndScrollsToTheAverages() throws {
        let app = launch("shelf")
        // The first bag is the one with rated brews. Open the bags in order; the one without
        // brews has no summary (the empty state of M2-T44 stays below, not here).
        let rows = app.buttons.matching(identifier: "shelf-entry-row")
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 30), "the shelf did not appear")
        var summary: XCUIElement?
        for index in 0..<rows.count {
            rows.element(boundBy: index).tap()
            XCTAssertTrue(element("shelf-entry-brews", in: app).waitForExistence(timeout: 10), "the shelf entry did not open")
            let candidate = element("coffee-summary", in: app)
            if candidate.exists {
                summary = candidate
                break
            }
            XCTAssertFalse(element("coffee-averages-count", in: app).exists)
            app.navigationBars.buttons.firstMatch.tap()
            XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "back did not show the shelf")
        }
        guard let summary else {
            attachDiagnostics(app, "no bag shows the summary row")
            XCTFail("no bag of the fixture shows the summary row")
            return
        }

        // The very top: above the "Brew" and "Brews" rows, read as label and value.
        XCTAssertTrue(summary.isHittable, "the summary row is not on the first screen")
        XCTAssertLessThan(summary.frame.minY, element("shelf-entry-brew", in: app).frame.minY, "the summary row is below the brew button")
        XCTAssertEqual(summary.label, "Your ratings of this coffee")
        let text = summary.value as? String ?? ""
        XCTAssertNotNil(
            text.range(of: #"^Overall \d+(\.\d)?, rated brews 3$"#, options: .regularExpression),
            "the summary reads '\(text)': the fixture bag has three rated brews"
        )

        // A tap shows the dimension section of M2-T44.
        summary.tap()
        let count = element("coffee-averages-count", in: app)
        if !count.waitForExistence(timeout: 10) || !count.isHittable {
            attachDiagnostics(app, "missing: the averages section after the tap")
        }
        XCTAssertTrue(count.exists && count.isHittable, "the tap did not scroll to the averages")
    }

    // MARK: - The brew list

    @MainActor
    func testRatedBrewRowsShowTheirOverallAndTheCoffeesAverageAndUnratedRowsNeither() throws {
        let app = launch("shelf")
        let rows = app.buttons.matching(identifier: "shelf-entry-row")
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 30), "the shelf did not appear")
        var opened = false
        for index in 0..<rows.count {
            rows.element(boundBy: index).tap()
            XCTAssertTrue(element("shelf-entry-brews", in: app).waitForExistence(timeout: 10), "the shelf entry did not open")
            if element("coffee-summary", in: app).exists {
                opened = true
                break
            }
            app.navigationBars.buttons.firstMatch.tap()
            XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "back did not show the shelf")
        }
        guard opened else {
            attachDiagnostics(app, "no bag with brews")
            XCTFail("no bag of the fixture has brews")
            return
        }
        element("shelf-entry-brews", in: app).tap()

        let list = app.buttons.matching(identifier: "brew-list-row")
        if !list.firstMatch.waitForExistence(timeout: 15) {
            attachDiagnostics(app, "missing: the brew list rows")
        }
        XCTAssertTrue(list.firstMatch.exists, "the brew list shows no rows")
        // Three rated brews and one unrated: read each row's label.
        var rated = 0
        var unrated = 0
        for index in 0..<list.count {
            let label = list.element(boundBy: index).label
            if label.contains("Overall") {
                rated += 1
                XCTAssertNotNil(
                    label.range(of: #"Overall \d+(\.\d)?"#, options: .regularExpression),
                    "a rated row has its own overall: \(label)"
                )
                XCTAssertNotNil(
                    label.range(of: #"Coffee average \d+(\.\d)?"#, options: .regularExpression),
                    "a rated row has the coffee's average: \(label)"
                )
            } else {
                unrated += 1
                XCTAssertFalse(label.contains("Coffee average"), "an unrated row shows an average: \(label)")
            }
        }
        if rated != 3 || unrated != 1 {
            attachDiagnostics(app, "rows: rated \(rated), unrated \(unrated)")
        }
        XCTAssertEqual(rated, 3, "three rated rows")
        XCTAssertEqual(unrated, 1, "one unrated row")
    }
}
