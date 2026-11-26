import XCTest

/// The averages on the shelf list (M2-T49). The fixture store has two bags of two different
/// beans: the first holds three rated brews, the second none. So exactly one row shows the bag
/// line "Overall 7.4, rated brews 3", and no row shows the product line (that needs two bags of
/// one bean; the unit tests in `ShelfAveragesTests` cover it). Nothing is typed (invariant 1).
final class ShelfAveragesUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testOnlyTheBagWithRatedBrewsShowsItsAverageAndNoRowShowsAProductLine() throws {
        let app = XCUIApplication()
        app.launchArguments = [
            "-CupmarkUITestScreen", "shelf",
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        app.launch()
        let rows = app.buttons.matching(identifier: "shelf-entry-row")
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 30), "the shelf did not appear")
        XCTAssertEqual(rows.count, 2, "the fixture has two bags")

        let withAverage = rows.matching(NSPredicate(format: "label CONTAINS %@", "Overall"))
        XCTAssertEqual(withAverage.count, 1, "only the bag with rated brews shows an average")
        let withProduct = rows.matching(NSPredicate(format: "label CONTAINS %@", "All bags"))
        XCTAssertEqual(withProduct.count, 0, "two different beans: no product line")
        XCTAssertTrue(withAverage.firstMatch.label.contains("rated brews 3"), "the label was: \(withAverage.firstMatch.label)")
    }
}
