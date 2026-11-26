import SwiftData
import XCTest
@testable import Cupmark

/// Brew photos in the device backup (M2-T45, ADR 0033 addendum M2-T45): the setting's default,
/// `isExcludedFromBackup` on the folder and every file for both states, a photo written after a
/// change, a folder created lazily, the correction at store open, and that the sweep and the
/// removal of folders are unaffected.
///
/// The setting lives in a throwaway `UserDefaults` suite and every folder is a temporary one,
/// so the device's real setting and photos are never read or written.
@MainActor
final class BrewPhotoBackupTests: XCTestCase {
    private let root = BrewPhotoFixtures.temporaryDirectory()
    private let suiteName = "BrewPhotoBackupTests-\(UUID().uuidString)"
    private let account = AccountID(subject: "brew-photo-backup-tests-account")
    private let other = AccountID(subject: "brew-photo-backup-tests-other-account")

    private var defaults: UserDefaults {
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            preconditionFailure("The test suite of UserDefaults could not be made.")
        }
        return defaults
    }

    private var setting: BrewPhotoBackupSetting {
        BrewPhotoBackupSetting(defaults: defaults)
    }

    private var folders: BrewPhotoFolders {
        BrewPhotoFolders(root: root.appending(path: "BrewPhotos", directoryHint: .isDirectory), backup: setting)
    }

    override func tearDown() {
        UserDefaults.standard.removePersistentDomain(forName: suiteName)
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    /// Whether the item is excluded from the backup; fails the test when it cannot be read.
    private func excluded(_ url: URL, file: StaticString = #filePath, line: UInt = #line) -> Bool? {
        let value = BrewPhotoFileStore.isExcludedFromBackup(url)
        XCTAssertNotNil(value, "the resource value could not be read", file: file, line: line)
        return value
    }

    private func photoURLs(in files: BrewPhotoFileStore) -> [URL] {
        let names = BrewPhotoFixtures.names(in: files)
        return names.compactMap { files.url(of: $0) }
    }

    // MARK: - The setting

    func testTheSettingIsOffByDefaultAndIsKeptPerDevice() {
        XCTAssertFalse(setting.isIncluded)
        setting.isIncluded = true
        XCTAssertTrue(setting.isIncluded)
        XCTAssertTrue(BrewPhotoBackupSetting(defaults: defaults).isIncluded, "a new reader sees the stored value")
        setting.isIncluded = false
        XCTAssertFalse(setting.isIncluded)
    }

    func testAFileStoreWithoutASettingExcludesItsPhotos() throws {
        let files = BrewPhotoFileStore(directory: root.appending(path: "plain", directoryHint: .isDirectory))
        let name = try files.write(try BrewPhotoFixtures.photo())
        let url = try XCTUnwrap(files.url(of: name))
        XCTAssertEqual(excluded(files.directory), true)
        XCTAssertEqual(excluded(url), true)
    }

    // MARK: - Off (the default)

    func testANewFolderAndItsFirstPhotoAreExcludedByDefault() throws {
        let files = folders.files(for: account)
        XCTAssertFalse(BrewPhotoFixtures.exists(files.directory), "the folder is created lazily")
        let name = try files.write(try BrewPhotoFixtures.photo())
        let url = try XCTUnwrap(files.url(of: name))
        XCTAssertEqual(excluded(files.directory), true)
        XCTAssertEqual(excluded(url), true)
    }

    // MARK: - On

    func testAFolderCreatedWhileTheSettingIsOnIsIncluded() throws {
        setting.isIncluded = true
        let files = folders.files(for: account)
        let name = try files.write(try BrewPhotoFixtures.photo())
        let url = try XCTUnwrap(files.url(of: name))
        XCTAssertEqual(excluded(files.directory), false)
        XCTAssertEqual(excluded(url), false)
    }

    func testChangingTheSettingSetsTheFolderAndEveryFileBothWays() throws {
        let files = folders.files(for: account)
        _ = try files.write(try BrewPhotoFixtures.photo())
        _ = try files.write(try BrewPhotoFixtures.photo())
        let urls = photoURLs(in: files)
        XCTAssertEqual(urls.count, 2)
        for url in urls {
            XCTAssertEqual(excluded(url), true)
        }

        setting.isIncluded = true
        XCTAssertTrue(files.applyBackupSetting())
        XCTAssertEqual(excluded(files.directory), false)
        for url in urls {
            XCTAssertEqual(excluded(url), false)
        }

        setting.isIncluded = false
        XCTAssertTrue(files.applyBackupSetting())
        XCTAssertEqual(excluded(files.directory), true)
        for url in urls {
            XCTAssertEqual(excluded(url), true)
        }
    }

    func testAPhotoWrittenAfterAChangeFollowsTheSetting() throws {
        let files = folders.files(for: account)
        let first = try files.write(try BrewPhotoFixtures.photo())

        setting.isIncluded = true
        files.applyBackupSetting()
        let second = try files.write(try BrewPhotoFixtures.photo())
        XCTAssertEqual(excluded(try XCTUnwrap(files.url(of: first))), false)
        XCTAssertEqual(excluded(try XCTUnwrap(files.url(of: second))), false)
        XCTAssertEqual(excluded(files.directory), false)

        setting.isIncluded = false
        files.applyBackupSetting()
        let third = try files.write(try BrewPhotoFixtures.photo())
        for name in [first, second, third] {
            XCTAssertEqual(excluded(try XCTUnwrap(files.url(of: name))), true)
        }
        XCTAssertEqual(excluded(files.directory), true)
    }

    func testAChangeAppliesToEveryAccountsFolderOnTheDevice() throws {
        let mine = folders.files(for: account)
        let theirs = folders.files(for: other)
        let mineName = try mine.write(try BrewPhotoFixtures.photo())
        let theirName = try theirs.write(try BrewPhotoFixtures.photo())

        setting.isIncluded = true
        XCTAssertTrue(folders.applyBackupSettingToAllFolders())
        XCTAssertEqual(excluded(mine.directory), false)
        XCTAssertEqual(excluded(theirs.directory), false)
        XCTAssertEqual(excluded(try XCTUnwrap(mine.url(of: mineName))), false)
        XCTAssertEqual(excluded(try XCTUnwrap(theirs.url(of: theirName))), false)
    }

    func testApplyingToAFolderThatIsNotThereChangesNothingAndCreatesNothing() {
        let files = folders.files(for: account)
        XCTAssertTrue(files.applyBackupSetting())
        XCTAssertFalse(BrewPhotoFixtures.exists(files.directory))
        XCTAssertTrue(BrewPhotoFolders(root: root.appending(path: "none", directoryHint: .isDirectory), backup: setting).applyBackupSettingToAllFolders())
    }

    // MARK: - Store open

    func testTheStoreCorrectsAnOlderFolderThatWasBackedUp() throws {
        // A folder made before the setting existed: included in the backup, with a photo and a
        // temporary file an ended app left.
        let files = folders.files(for: account)
        let name = try files.write(try BrewPhotoFixtures.photo())
        let url = try XCTUnwrap(files.url(of: name))
        let partial = files.directory.appending(path: ".left\(BrewPhotoFileStore.temporarySuffix)", directoryHint: .notDirectory)
        try Data([1]).write(to: partial)
        var values = URLResourceValues()
        values.isExcludedFromBackup = false
        for item in [files.directory, url, partial] {
            var target = item
            try target.setResourceValues(values)
            XCTAssertEqual(excluded(item), false)
        }

        let store = try AccountStore.inMemory(brewPhotoFiles: files)
        XCTAssertTrue(store.applyBrewPhotoBackupSetting())
        for item in [files.directory, url, partial] {
            XCTAssertEqual(excluded(item), true, "off is the default, so the folder and every file are excluded")
        }

        // With the setting on, a restored folder that was excluded is included again.
        setting.isIncluded = true
        XCTAssertTrue(store.applyBrewPhotoBackupSetting())
        for item in [files.directory, url, partial] {
            XCTAssertEqual(excluded(item), false)
        }
    }

    func testAStoreWithoutAPhotoFolderHasNothingToApply() throws {
        let store = try AccountStore.inMemory()
        XCTAssertTrue(store.applyBrewPhotoBackupSetting())
    }

    // MARK: - The sweep and the removal of folders are unaffected

    func testTheSweepDeletesTheSameFilesWhateverTheSetting() throws {
        for included in [false, true] {
            setting.isIncluded = included
            let files = folders.files(for: included ? other : account)
            let store = try AccountStore.inMemory(brewPhotoFiles: files)
            let brew = try BrewPhotoFixtures.brew(in: store)
            let kept = try store.addBrewPhoto(to: brew, jpeg: try BrewPhotoFixtures.photo(), createdAt: BrewPhotoFixtures.at(minute: 0))
            let orphan = try files.write(try BrewPhotoFixtures.photo())
            let partial = files.directory.appending(path: ".left\(BrewPhotoFileStore.temporarySuffix)", directoryHint: .notDirectory)
            try Data([1]).write(to: partial)

            let sweep = store.sweepBrewPhotos()

            XCTAssertEqual(sweep, BrewPhotoSweep(recordsRemoved: 0, filesRemoved: 2), "included: \(included)")
            XCTAssertEqual(BrewPhotoFixtures.names(in: files), [kept.fileName])
            XCTAssertFalse(files.fileExists(orphan))
            XCTAssertTrue(files.fileExists(kept.fileName))
            XCTAssertEqual(excluded(try XCTUnwrap(files.url(of: kept.fileName))), !included)
        }
    }

    func testRemovingFoldersWorksInBothStates() throws {
        for included in [false, true] {
            setting.isIncluded = included
            let mine = folders.files(for: account)
            let theirs = folders.files(for: other)
            _ = try mine.write(try BrewPhotoFixtures.photo())
            _ = try theirs.write(try BrewPhotoFixtures.photo())

            try folders.removeFolders(exceptOf: account)
            XCTAssertTrue(BrewPhotoFixtures.exists(mine.directory), "included: \(included)")
            XCTAssertFalse(BrewPhotoFixtures.exists(theirs.directory))

            // The account deletion's call, repeated.
            try folders.removeFolder(of: account)
            try folders.removeFolder(of: account)
            XCTAssertFalse(BrewPhotoFixtures.exists(mine.directory))
        }
    }

    // MARK: - Settings model

    func testTheSettingsModelStartsOffStoresTheChoiceAndAppliesItWithoutTouchingTheStore() throws {
        let files = folders.files(for: account)
        let theirs = folders.files(for: other)
        let name = try files.write(try BrewPhotoFixtures.photo())
        _ = try theirs.write(try BrewPhotoFixtures.photo())
        let store = try AccountStore.inMemory(brewPhotoFiles: files)
        let model = SettingsModel(store: store, backup: setting, folders: folders)
        XCTAssertFalse(model.brewPhotosInBackup, "the default is off")
        XCTAssertFalse(model.backupApplyFailed)

        model.setBrewPhotosInBackup(true)
        XCTAssertTrue(model.brewPhotosInBackup)
        XCTAssertTrue(setting.isIncluded, "kept on the device")
        XCTAssertEqual(excluded(files.directory), false)
        XCTAssertEqual(excluded(try XCTUnwrap(files.url(of: name))), false)
        XCTAssertEqual(excluded(theirs.directory), false, "every account's folder on the device")
        XCTAssertFalse(model.backupApplyFailed)

        // A model made later reads the stored choice.
        XCTAssertTrue(SettingsModel(store: store, backup: setting, folders: folders).brewPhotosInBackup)

        model.setBrewPhotosInBackup(false)
        XCTAssertFalse(model.brewPhotosInBackup)
        XCTAssertFalse(setting.isIncluded)
        XCTAssertEqual(excluded(files.directory), true)
        XCTAssertEqual(excluded(theirs.directory), true)

        // Per device and not synced: no profile and no outbox operation came of it.
        XCTAssertNil(try store.profile())
        XCTAssertEqual(try store.outboxOperations().count, 0)
    }

    func testTheSettingsModelWithoutFoldersAppliesToTheOpenStoresFolderOnly() throws {
        let files = folders.files(for: account)
        let theirs = folders.files(for: other)
        _ = try files.write(try BrewPhotoFixtures.photo())
        _ = try theirs.write(try BrewPhotoFixtures.photo())
        let store = try AccountStore.inMemory(brewPhotoFiles: files)
        let model = SettingsModel(store: store, backup: setting, folders: nil)

        model.setBrewPhotosInBackup(true)

        XCTAssertEqual(excluded(files.directory), false)
        XCTAssertEqual(excluded(theirs.directory), true, "corrected when that account's store opens")
    }
}
