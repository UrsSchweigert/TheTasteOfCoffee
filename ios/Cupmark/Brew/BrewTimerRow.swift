import SwiftUI

/// The brew timer of the brew form (M2-T21, docs/04 Input model "Timer").
///
/// - The readout shows the running time, or the brew time once it is stopped (the value that
///   is saved), in the large title text style, so it follows Dynamic Type.
/// - Start and Stop share one button; Reset sets the timer back and clears the brew time.
///   Nothing is typed (invariant 1).
/// - While the timer runs, a `TimelineView` redraws the readout; each redraw reads the time
///   from the start instant, so time in the background or with the phone locked counts.
/// - VoiceOver reads the readout as "Brew time" with the time in words, and the model
///   announces start, stop (with the brew time) and reset.
struct BrewTimerRow: View {
    let timer: BrewTimerModel
    /// `brew_time_s` of the draft, shown while the timer is not running.
    let brewTimeS: API.BrewTimeS?
    let onStart: @MainActor () -> Void
    let onStop: @MainActor () -> Void
    let onReset: @MainActor () -> Void
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// How often the running readout is redrawn, in seconds. Shorter than a second, so the
    /// shown second never lags by more than this.
    private static let redrawInterval: Double = 0.2

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            TimelineView(.animation(minimumInterval: BrewTimerRow.redrawInterval, paused: !timer.isRunning)) { _ in
                readout(seconds: shownSeconds)
            }
            buttons
        }
        .padding(.vertical, 4)
    }

    /// The seconds the readout shows: the running time, else the draft's brew time, else zero.
    private var shownSeconds: Int? {
        if timer.isRunning {
            return timer.elapsed().wholeSeconds
        }
        return brewTimeS
    }

    private func readout(seconds: Int?) -> some View {
        Text(verbatim: BrewTimerFormat.readout(seconds ?? 0, locale: locale))
            .font(.largeTitle.monospacedDigit())
            .foregroundStyle(seconds == nil ? Color.secondary : Color.primary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(L10n.brewTimer))
            .accessibilityValue(spokenValue(seconds: seconds))
            .accessibilityAddTraits(.updatesFrequently)
            .accessibilityIdentifier("brew-timer-readout")
    }

    private func spokenValue(seconds: Int?) -> Text {
        if let seconds {
            return Text(verbatim: BrewTimerFormat.spoken(seconds, locale: locale))
        }
        return Text(L10n.lookupPickNotSet)
    }

    private var buttons: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 12))
        return layout {
            startStopButton
            Button {
                onReset()
            } label: {
                Label {
                    Text(L10n.brewTimerReset)
                } icon: {
                    Image(systemName: "arrow.counterclockwise")
                        .accessibilityHidden(true)
                }
            }
            // An explicit style keeps each button its own tap target inside the form row.
            .buttonStyle(.bordered)
            .disabled(!timer.isRunning && brewTimeS == nil)
            .accessibilityHint(Text(L10n.brewTimerResetHint))
            .accessibilityIdentifier("brew-timer-reset")
        }
    }

    @ViewBuilder
    private var startStopButton: some View {
        if timer.isRunning {
            Button {
                onStop()
            } label: {
                Label {
                    Text(L10n.brewTimerStop)
                } icon: {
                    Image(systemName: "stop.fill")
                        .accessibilityHidden(true)
                }
            }
            .buttonStyle(.borderedProminent)
            .accessibilityHint(Text(L10n.brewTimerStopHint))
            .accessibilityIdentifier("brew-timer-stop")
        } else {
            Button {
                onStart()
            } label: {
                Label {
                    Text(L10n.brewTimerStart)
                } icon: {
                    Image(systemName: "play.fill")
                        .accessibilityHidden(true)
                }
            }
            .buttonStyle(.borderedProminent)
            .accessibilityHint(Text(L10n.brewTimerStartHint))
            .accessibilityIdentifier("brew-timer-start")
        }
    }
}
