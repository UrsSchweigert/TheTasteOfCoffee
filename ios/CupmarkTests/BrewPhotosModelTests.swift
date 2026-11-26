import CoreGraphics
import XCTest
@testable import Cupmark

/// A camera environment that answers what the test says (the real one needs a device).
@MainActor
private final class FakeBrewCamera: LabelPhotoCameraEnvironment {
    var answer: LabelPhotoCameraAvailability

    init(_ answer: LabelPhotoCameraAvailability) {
        self.answer = answer
    }

    func availability() -> LabelPhotoCameraAvailability {
        answer
    }
}

/// Counts how often a stubbed encoder ran.
private final class CallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    var count: Int { lock.withLock { value } }

    func hit() {
        lock.withLock { value += 1 }
    }
}

/// The "Photos" section's model (M2-T42b): adding from the camera and from the picker, the limit,
/// failures, deleting with a confirmation, and a brew that disappears. Fixed dates, a temporary
/// folder per test, no camera and no photo library.
@MainActor
final class BrewPhotosModelTests: XCTestCase {
    private let root = BrewPhotoFixtures.temporaryDirectory()
    private let account = AccountID(subject: "brew-photos-model-tests")

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    private var files: BrewPhotoFileStore {
        BrewPhotoFolders(root: root.appending(path: "BrewPhotos", directoryHint: .isDirectory)).files(for: account)
    }

    private func makeStore() throws -> AccountStore {
        try AccountStore.inMemory(brewPhotoFiles: files)
    }

    private func makeModel(
        _ store: AccountStore,
        brew: StoredBrew,
        camera: LabelPhotoCameraAvailability = .available,
        encodeData: BrewPhotosModel.EncodeData? = nil,
        encodeCapture: BrewPhotosModel.EncodeCapture? = nil,
        minute: Int = 1
    ) throws -> BrewPhotosModel {
        let photo = try BrewPhotoFixtures.photo()
        return BrewPhotosModel(
            brew: brew.localID,
            store: store,
            camera: FakeBrewCamera(camera),
            encodeData: encodeData ?? { _ in photo },
            encodeCapture: encodeCapture ?? { _ in photo },
            now: { BrewPhotoFixtures.at(minute: minute) }
        )
    }

    private func capture() throws -> LabelPhotoCapture {
        LabelPhotoCapture(image: try LabelPhotoEncoderTests.quadrantImage(width: 64, height: 48), orientation: .up)
    }

    private func pick(_ model: BrewPhotosModel, _ data: Data = Data([1, 2, 3])) async {
        await model.addPicked { data }
    }

    // MARK: - Add

    func testAPickedPhotoIsAddedToTheBrewWithItsDateAndAFile() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew, minute: 7)
        XCTAssertTrue(model.isOffered)
        XCTAssertTrue(model.items.isEmpty)

        await pick(model)

        XCTAssertNil(model.failure)
        XCTAssertFalse(model.isAdding)
        XCTAssertEqual(model.items.count, 1)
        XCTAssertEqual(model.items.first?.createdAt, BrewPhotoFixtures.at(minute: 7))
        let url = try XCTUnwrap(model.items.first?.fileURL)
        XCTAssertTrue(BrewPhotoFixtures.exists(url))
        XCTAssertEqual(try store.brewPhotos(of: brew).count, 1)
        // Nothing of it is queued: brew photos never leave the device.
        XCTAssertTrue(try store.outboxOperations().isEmpty)
    }

    func testACameraCaptureIsAddedLikeAPick() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew)

        await model.add(try capture())

        XCTAssertNil(model.failure)
        XCTAssertEqual(model.items.count, 1)
        XCTAssertEqual(try store.brewPhotos(of: brew).count, 1)
    }

    func testTheRealEncoderStoresAPhotoWithoutMetadata() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = BrewPhotosModel(brew: brew.localID, store: store, camera: FakeBrewCamera(.available))
        let input = try LabelPhotoEncoderTests.jpegWithMetadata(try LabelPhotoEncoderTests.quadrantImage(width: 200, height: 100), orientation: 6)

        await pick(model, input)

        XCTAssertNil(model.failure)
        let url = try XCTUnwrap(model.items.first?.fileURL)
        try LabelPhotoEncoderTests.assertNoMetadata(in: try Data(contentsOf: url))
    }

    func testPhotosListNewestFirstAndAreNumberedFromOne() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let first = try makeModel(store, brew: brew, minute: 1)
        await pick(first)
        let second = try makeModel(store, brew: brew, minute: 2)
        await pick(second)

        XCTAssertEqual(second.items.map(\.createdAt), [BrewPhotoFixtures.at(minute: 2), BrewPhotoFixtures.at(minute: 1)])
        XCTAssertEqual(second.items.map { second.position(of: $0) }, [1, 2])
    }

    func testThePhotosOfAnotherBrewAreNotListed() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let other = try BrewPhotoFixtures.brew(in: store, entry: brew.shelfEntry, serverID: FakeSyncBackend.id(62), minute: 5)
        let otherModel = try makeModel(store, brew: other)
        await pick(otherModel)

        let model = try makeModel(store, brew: brew)

        XCTAssertTrue(model.items.isEmpty)
        XCTAssertEqual(otherModel.items.count, 1)
    }

    // MARK: - Limit

    func testAtTheLimitNothingIsEncodedAndTheModelSaysWhy() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let counter = CallCounter()
        let photo = try BrewPhotoFixtures.photo()
        let model = try makeModel(store, brew: brew, encodeData: { _ in
            counter.hit()
            return photo
        })
        for _ in 0..<BrewPhotoLimits.maxPerBrew {
            await pick(model)
        }
        XCTAssertEqual(model.count, BrewPhotoLimits.maxPerBrew)
        XCTAssertTrue(model.isFull)
        XCTAssertFalse(model.canAdd, "the add controls are disabled at the limit")
        XCTAssertEqual(counter.count, BrewPhotoLimits.maxPerBrew)

        await pick(model)
        XCTAssertEqual(model.failure, .limitReached)
        XCTAssertEqual(model.count, BrewPhotoLimits.maxPerBrew)
        XCTAssertEqual(counter.count, BrewPhotoLimits.maxPerBrew, "no image is encoded for a full brew")
        XCTAssertEqual(BrewPhotoFixtures.names(in: files).count, BrewPhotoLimits.maxPerBrew)
    }

    func testDeletingOneAtTheLimitEnablesAddingAgain() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew)
        for _ in 0..<BrewPhotoLimits.maxPerBrew {
            await pick(model)
        }
        let item = try XCTUnwrap(model.items.first)
        model.requestDelete(item)
        model.confirmDelete()

        XCTAssertFalse(model.isFull)
        XCTAssertTrue(model.canAdd)
    }

    // MARK: - Failures

    func testAnUnreadableImageIsAFailureAndKeepsTheBrewAsItWas() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew, encodeData: { _ in throw LabelPhotoEncodingError.unreadableImage })

        await pick(model)

        XCTAssertEqual(model.failure, .unreadable)
        XCTAssertFalse(model.isAdding)
        XCTAssertTrue(model.items.isEmpty)
        XCTAssertTrue(BrewPhotoFixtures.names(in: files).isEmpty)
        XCTAssertTrue(try store.brewPhotos(of: brew).isEmpty)
    }

    func testATooLargeImageIsItsOwnFailure() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew, encodeData: { _ in throw LabelPhotoEncodingError.tooLarge(bytesAtLowestQuality: 9_000_000) })

        await pick(model)

        XCTAssertEqual(model.failure, .tooLarge)
        XCTAssertTrue(model.items.isEmpty)
    }

    func testAFailedCaptureEncodingIsAFailure() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew, encodeCapture: { _ in throw LabelPhotoEncodingError.renderingFailed })

        await model.add(try capture())

        XCTAssertEqual(model.failure, .unreadable)
        XCTAssertTrue(model.items.isEmpty)
    }

    func testAPickThatCannotBeLoadedOrHasNoDataIsUnreadable() async throws {
        struct LoadFailed: Error {}
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew)

        await model.addPicked { throw LoadFailed() }
        XCTAssertEqual(model.failure, .unreadable)

        await model.addPicked { nil }
        XCTAssertEqual(model.failure, .unreadable)
        XCTAssertTrue(model.items.isEmpty)
    }

    func testTheNextAddClearsTheEarlierFailure() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew)
        await model.addPicked { nil }
        XCTAssertNotNil(model.failure)

        await pick(model)

        XCTAssertNil(model.failure)
        XCTAssertEqual(model.items.count, 1)
    }

    func testAStoreWithoutAPhotoFolderOffersNoSection() throws {
        let store = try AccountStore.inMemory()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = BrewPhotosModel(brew: brew.localID, store: store, camera: FakeBrewCamera(.available))

        XCTAssertTrue(model.brewExists)
        XCTAssertFalse(model.isOffered)
    }

    func testAStoreThatCannotWriteIsASaveFailure() async throws {
        let store = try AccountStore.inMemory()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew)

        await pick(model)

        XCTAssertEqual(model.failure, .saveFailed)
        XCTAssertTrue(model.items.isEmpty)
    }

    // MARK: - Delete

    func testDeletingAsksFirstAndCancelChangesNothing() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew)
        await pick(model)
        let item = try XCTUnwrap(model.items.first)

        XCTAssertFalse(model.isConfirmingDelete)
        model.requestDelete(item)
        XCTAssertTrue(model.isConfirmingDelete)
        XCTAssertEqual(model.count, 1, "asking deletes nothing")

        model.cancelDelete()
        XCTAssertFalse(model.isConfirmingDelete)
        XCTAssertEqual(model.count, 1)
        XCTAssertEqual(BrewPhotoFixtures.names(in: files).count, 1)

        // Dismissing the dialog through its binding is a cancel too.
        model.requestDelete(item)
        model.isConfirmingDelete = false
        XCTAssertEqual(model.count, 1)
    }

    func testConfirmingDeletesTheRecordAndTheFileButNotTheBrew() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew)
        await pick(model)
        let item = try XCTUnwrap(model.items.first)
        let url = try XCTUnwrap(item.fileURL)

        model.requestDelete(item)
        model.confirmDelete()

        XCTAssertNil(model.failure)
        XCTAssertFalse(model.isConfirmingDelete)
        XCTAssertTrue(model.items.isEmpty)
        XCTAssertFalse(BrewPhotoFixtures.exists(url), "the file is deleted")
        XCTAssertTrue(try store.brewPhotos(of: brew).isEmpty)
        XCTAssertNotNil(try store.brew(localID: brew.localID))
        XCTAssertEqual(brew.syncState, .synced, "the brew is untouched")
        XCTAssertTrue(try store.outboxOperations().isEmpty)
    }

    func testConfirmingWithoutAskingDeletesNothing() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew)
        await pick(model)

        model.confirmDelete()

        XCTAssertEqual(model.count, 1)
    }

    func testAPhotoDeletedMeanwhileEndsTheConfirmation() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew)
        await pick(model)
        let item = try XCTUnwrap(model.items.first)
        model.requestDelete(item)

        try store.deleteBrewPhoto(localID: item.id)
        model.refresh()

        XCTAssertFalse(model.isConfirmingDelete)
        model.confirmDelete()
        XCTAssertNil(model.failure)
    }

    func testAMissingFileIsListedWithoutAURLAndCanBeDeleted() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew)
        await pick(model)
        let url = try XCTUnwrap(model.items.first?.fileURL)
        try FileManager.default.removeItem(at: url)

        model.refresh()
        XCTAssertEqual(model.items.count, 1)
        XCTAssertNil(model.items.first?.fileURL)

        model.requestDelete(try XCTUnwrap(model.items.first))
        model.confirmDelete()
        XCTAssertTrue(model.items.isEmpty)
    }

    // MARK: - A brew that disappears

    func testABrewRemovedBeforeTheAddRefusesAndHidesTheSection() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew)
        try store.markDeleted(brew)

        await pick(model)

        XCTAssertEqual(model.failure, .brewNotFound)
        XCTAssertFalse(model.brewExists)
        XCTAssertFalse(model.isOffered)
        XCTAssertFalse(model.canAdd)
        XCTAssertTrue(model.items.isEmpty)
        XCTAssertTrue(BrewPhotoFixtures.names(in: files).isEmpty)
    }

    func testABrewRemovedWhileThePhotoIsPreparedLeavesNoFile() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew)

        await model.addPicked {
            // The pull removes the brew after the pick was accepted and before it is saved.
            try store.markDeleted(brew)
            return Data([1])
        }

        XCTAssertEqual(model.failure, .brewNotFound)
        XCTAssertTrue(model.items.isEmpty)
        XCTAssertTrue(BrewPhotoFixtures.names(in: files).isEmpty, "no file and no record is left")
        XCTAssertTrue(try store.allBrewPhotos().isEmpty)
    }

    func testAModelOfAnUnknownBrewOffersNothing() throws {
        let store = try makeStore()
        let model = BrewPhotosModel(brew: UUID(), store: store, camera: FakeBrewCamera(.available))

        XCTAssertFalse(model.isOffered)
        XCTAssertTrue(model.items.isEmpty)
    }

    // MARK: - Camera

    func testTheCameraIsHiddenWithoutOneAndOfferedOtherwise() throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let camera = FakeBrewCamera(.unavailable)
        let model = BrewPhotosModel(brew: brew.localID, store: store, camera: camera)
        XCTAssertFalse(model.offersCamera)

        camera.answer = .permissionDenied
        model.refresh()
        XCTAssertTrue(model.offersCamera)
        XCTAssertEqual(model.cameraAvailability, .permissionDenied, "the screen shows the Settings link")

        camera.answer = .available
        model.refresh()
        XCTAssertEqual(model.cameraAvailability, .available)
    }

    func testThePickerStillAddsWithoutACamera() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = try makeModel(store, brew: brew, camera: .unavailable)

        await pick(model)

        XCTAssertEqual(model.items.count, 1)
        XCTAssertTrue(model.canAdd)
    }

    // MARK: - Texts and thumbnails

    func testEveryFailureHasAMessageAndTheLabelsReadWithBothNumbersInEachLanguage() throws {
        let failures: [BrewPhotosModel.Failure] = [.unreadable, .tooLarge, .limitReached, .brewNotFound, .saveFailed]
        XCTAssertEqual(Set(failures.map { String(describing: BrewPhotosSection.message(for: $0)) }).count, failures.count)

        let appBundle = Bundle(for: AppBundleToken.self)
        var summaries: [String] = []
        for language in VocabularyLanguage.allCases {
            let path = try XCTUnwrap(appBundle.path(forResource: language.rawValue, ofType: "lproj"))
            let bundle = try XCTUnwrap(Bundle(path: path))
            let summary = L10n.brewPhotosSummary("2", of: "6", bundle: bundle)
            XCTAssertTrue(summary.contains("2") && summary.contains("6"), "\(language.rawValue): \(summary)")
            XCTAssertFalse(summary.contains("%") || summary.hasPrefix("brew_photos."), "\(language.rawValue): \(summary)")
            for text in [L10n.brewPhotosItem("1", of: "3", bundle: bundle), L10n.brewPhotosDelete("1", of: "3", bundle: bundle), L10n.brewPhotosCount("1", of: "6", bundle: bundle)] {
                XCTAssertTrue(text.contains("1") && !text.contains("%") && !text.hasPrefix("brew_photos."), "\(language.rawValue): \(text)")
            }
            summaries.append(summary)
        }
        XCTAssertEqual(summaries.first, "Brew photos, 2 of 6")
        XCTAssertEqual(Set(summaries).count, summaries.count, "a language is not translated")
    }

    func testAThumbnailIsDownsampledFromTheFile() async throws {
        let store = try makeStore()
        let brew = try BrewPhotoFixtures.brew(in: store)
        let model = BrewPhotosModel(brew: brew.localID, store: store, camera: FakeBrewCamera(.available))
        await pick(model, try LabelPhotoEncoderTests.jpegWithMetadata(try LabelPhotoEncoderTests.quadrantImage(width: 400, height: 200), orientation: 1))
        let url = try XCTUnwrap(model.items.first?.fileURL)

        let loaded = await BrewPhotoThumbnails.load(url, maxPixelSize: 50)
        let thumbnail = try XCTUnwrap(loaded)

        XCTAssertEqual(max(thumbnail.image.width, thumbnail.image.height), 50)
        let missing = await BrewPhotoThumbnails.load(root.appending(path: "none.jpg"))
        XCTAssertNil(missing)
    }
}
