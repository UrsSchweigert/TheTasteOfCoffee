import SwiftUI

/// Settings, then Export (M2-T30). One button runs `ExportModel.export()`; the file it makes
/// is offered with `ShareLink` and deleted when the user taps Done or leaves the screen.
struct ExportScreen: View {
    @State private var model: ExportModel

    init(model: ExportModel) {
        _model = State(initialValue: model)
    }

    var body: some View {
        List {
            Section {
                Button {
                    Task {
                        await model.export()
                    }
                } label: {
                    Label {
                        Text(L10n.exportStart)
                    } icon: {
                        Image(systemName: "square.and.arrow.up.on.square")
                            .accessibilityHidden(true)
                    }
                }
                .disabled(model.isPreparing)
                .accessibilityIdentifier("export-start")
                if model.isPreparing {
                    HStack {
                        ProgressView()
                            .accessibilityHidden(true)
                        Text(L10n.exportPreparing)
                    }
                    .accessibilityElement(children: .combine)
                }
            } footer: {
                Text(L10n.exportFooter)
            }
            switch model.state {
            case .ready(let file):
                Section {
                    ShareLink(item: file.url) {
                        Label {
                            Text(L10n.exportShare)
                        } icon: {
                            Image(systemName: "square.and.arrow.up")
                                .accessibilityHidden(true)
                        }
                    }
                    .accessibilityIdentifier("export-share")
                    Button {
                        model.discardFile()
                    } label: {
                        Text(L10n.exportDone)
                    }
                    .accessibilityIdentifier("export-done")
                } footer: {
                    if file.hasPendingChanges {
                        Text(L10n.exportPendingChanges)
                    }
                }
            case .failed(let failure):
                Section {
                    Text(ExportScreen.message(for: failure))
                        .accessibilityIdentifier("export-failure")
                }
            case .idle, .preparing:
                EmptyView()
            }
        }
        .navigationTitle(Text(L10n.exportTitle))
        .onDisappear {
            model.discardFile()
        }
    }

    /// The localised message of a failure.
    static func message(for failure: ExportModel.Failure) -> LocalizedStringKey {
        switch failure {
        case .offline: return L10n.exportFailedOffline
        case .tooLarge: return L10n.exportFailedTooLarge
        case .signInRequired: return L10n.exportFailedSignIn
        case .tooManyRequests: return L10n.exportFailedTooManyRequests
        case .unavailable: return L10n.exportFailedUnavailable
        case .fileNotWritten: return L10n.exportFailedFile
        }
    }
}
