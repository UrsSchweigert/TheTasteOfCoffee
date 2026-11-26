import Foundation
import Observation

/// The brew sheet's flow (M2-T20, M2-T27): the brew form of a shelf entry until the brew is
/// saved, then the rating of that brew, with no tap in between. A repeat (`BrewRoute.start`)
/// opens the form prefilled with the last brew or a recipe and the timer ready, so the brew can
/// be saved with no further input and goes on to the rating.
@MainActor
@Observable
final class BrewFlowModel {
    enum Phase: Equatable, Sendable {
        /// The brew form is shown.
        case brewing
        /// The brew was saved; its rating is shown.
        case rating(brewLocalID: UUID)
    }

    let route: BrewRoute
    let form: BrewFormModel

    init(
        route: BrewRoute,
        store: AccountStore,
        now: @escaping () -> Date = { Date() },
        calendar: Calendar = .current,
        timer: BrewTimerModel? = nil
    ) {
        self.route = route
        form = BrewFormModel(
            shelfEntry: route.shelfEntryLocalID,
            store: store,
            now: now,
            calendar: calendar,
            start: route.start,
            timer: timer
        )
    }

    /// The rating follows as soon as the form saved its brew.
    var phase: Phase {
        if let brewID = form.savedBrewID {
            return .rating(brewLocalID: brewID)
        }
        return .brewing
    }

    /// Saves the form's brew (`BrewFormModel.save()`); the phase then moves on to the rating.
    @discardableResult
    func save() -> UUID? {
        form.save()
    }
}
