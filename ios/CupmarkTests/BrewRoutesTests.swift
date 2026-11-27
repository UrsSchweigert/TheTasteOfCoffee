import SwiftUI
import XCTest
@testable import Cupmark

/// The brew routes (M2-T40): value routes, resolved by destinations at the stack root, so
/// back from a rating shows the brew list. The destinations' registration is checked in
/// `scripts/ios-scripts.test.mjs`; the push and pop run in `AccessibilityVoiceOverTests` on a Mac.
final class BrewRoutesTests: XCTestCase {
    func testRoutesAreEqualByTheirId() {
        let id = UUID()
        XCTAssertEqual(BrewListRoute(shelfEntryLocalID: id), BrewListRoute(shelfEntryLocalID: id))
        XCTAssertNotEqual(BrewListRoute(shelfEntryLocalID: id), BrewListRoute(shelfEntryLocalID: UUID()))
        XCTAssertEqual(BrewRatingRoute(brewLocalID: id), BrewRatingRoute(brewLocalID: id))
        XCTAssertNotEqual(BrewRatingRoute(brewLocalID: id), BrewRatingRoute(brewLocalID: UUID()))
    }

    func testRoutesHashByTheirId() {
        let id = UUID()
        XCTAssertEqual(Set([BrewListRoute(shelfEntryLocalID: id), BrewListRoute(shelfEntryLocalID: id)]).count, 1)
        XCTAssertEqual(Set([BrewRatingRoute(brewLocalID: id), BrewRatingRoute(brewLocalID: id)]).count, 1)
    }

    func testAPathHoldsTheRoutesInOrder() {
        // The shelf's stack path: entry, brew list, rating; popping one leaves the list.
        let entry = UUID()
        var path = NavigationPath()
        path.append(ShelfEntryRoute(localID: entry))
        path.append(BrewListRoute(shelfEntryLocalID: entry))
        path.append(BrewRatingRoute(brewLocalID: UUID()))
        XCTAssertEqual(path.count, 3)
        path.removeLast()
        XCTAssertEqual(path.count, 2)
    }
}
