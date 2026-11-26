import Foundation
import SwiftData

// Pending beans and queued label photos (M2-T25, docs/04 Non-functional: Offline).
//
// - A barcode scanned while the lookup cannot answer (no network, the service unavailable,
//   the daily lookup cap) is kept as a pending bean when its bag goes on the shelf: a
//   `StoredBean` with the barcode and no server id, and a `lookUp` operation, saved with the
//   shelf entry (`ShelfEntryEditorModel.Mode.addScanned`), so a cancelled form leaves nothing.
//   Brews can be logged at once. When the engine reaches the look-up it asks
//   `GET /barcodes/{barcode}`, then Open Food Facts through the backend: a known bean is used
//   without asking; a hit waits for the user's confirmation (`awaitConfirmation`); a miss, or a
//   hit the user rejects, waits for the user to describe the bean with pick lists and a label
//   photo, or to skip that (`awaitDescription`, docs/04 F1 step 4). The user is asked the next
//   time the app is opened.
// - A pending bean whose last shelf entry is removed goes with its operations and queued
//   photos; the engine drops one it finds without a shelf entry.
// - A bean described with pick lists while offline is a plain `create`: it is created without
//   asking (a 409 for its barcode adopts the catalogue's bean, ADR 0025). It never gets an
//   Open Food Facts name or image later.
// - The shelf entries and brews of a pending bean need no rewrite: their bodies are built when
//   they are sent and name the bean through the relationship (ADR 0025), so they carry its
//   server id. Until it has one they wait (`nextOutboxOperation(at:)`), and every other
//   operation goes out.
// - Label photos taken for a bean are queued here (`QueuedLabelPhoto`) and upload once the bean
//   has a server id (`LabelPhotoQueue`).

/// Where a pending bean's look-up stands, for the shelf.
enum PendingBeanState: Equatable, Sendable {
    /// The barcode is looked up once the device is online.
    case lookingUp
    /// Open Food Facts has a product for it: the user is asked to confirm it.
    case awaitingConfirmation
    /// Nothing the user accepted was found: the user is asked to describe it.
    case awaitingDescription

    /// Whether the user is asked something.
    var asksUser: Bool {
        self != .lookingUp
    }
}

/// A pending bean the user is asked about (M2-T25).
struct PendingBeanQuestion: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// Is this Open Food Facts product your coffee? Untrusted text (ADR 0005).
        case confirm(API.OpenFoodFactsProduct)
        /// Describe the bean with pick lists and a label photo, or skip.
        case describe
    }

    /// The bean's local id.
    let beanID: UUID
    /// The scanned barcode.
    let barcode: CanonicalBarcode?
    let kind: Kind
}

/// What `addOfflineBean` did with the picks.
struct OfflineBeanResult {
    let bean: StoredBean
    /// False when the bean already has a server id, so the picks could not be added to it.
    let picksKept: Bool
}

extension StoredBean {
    /// Whether the bean's Open Food Facts name and brand are shown: a catalogue bean's, or a
    /// hit the user confirmed. A hit that waits for the user's answer is shown only on the
    /// confirmation screen, not as the bean's name.
    var showsOpenFoodFactsText: Bool {
        serverID != nil || openFoodFactsConfirmed
    }

    /// Whether a shelf entry on the device names the bean, not counting removed ones.
    var hasLiveShelfEntries: Bool {
        shelfEntries.contains { entry in entry.syncState != .pendingDelete }
    }
}

extension AccountStore {
    // MARK: - Pending beans

    /// The bean for a barcode scanned while the lookup could not answer, inserted with its
    /// `lookUp` operation. A bean already on the device with this barcode (a cached catalogue
    /// bean, or one still pending) is returned instead, so a barcode has one local bean. Does
    /// not save: the caller saves it with the shelf entry that names it.
    func pendingBean(barcode: CanonicalBarcode) throws -> StoredBean {
        if let existing = try self.bean(barcode: barcode.digits) {
            return existing
        }
        let bean = StoredBean(barcode: barcode.digits)
        bean.syncState = .pendingCreate
        context.insert(bean)
        try enqueue(.lookUp, .bean, localID: bean.localID)
        return bean
    }

    /// The unparked look-up or question of a pending bean, nil for any other bean.
    func pendingScanOperation(of beanLocalID: UUID) throws -> OutboxOperation? {
        try outboxOperations(for: beanLocalID).first { operation in
            !operation.parked && operation.resource == .bean && operation.action?.isPendingScan == true
        }
    }

    /// Whether the bean is a pending scan: no server id, and a look-up or question queued.
    func isPendingScan(_ bean: StoredBean) throws -> Bool {
        guard bean.serverID == nil else {
            return false
        }
        return try pendingScanOperation(of: bean.localID) != nil
    }

    /// Whether `bean` is a pending scan that no live shelf entry but `entry` names: once
    /// `entry` is removed or moved to another bean, nothing needs it any more.
    func isOrphanedScan(_ bean: StoredBean, without entry: StoredShelfEntry) throws -> Bool {
        guard try isPendingScan(bean) else {
            return false
        }
        return !bean.shelfEntries.contains { other in other.localID != entry.localID && other.syncState != .pendingDelete }
    }

    /// Removes a pending bean with its operations and queued label photos (the files go with
    /// the folder clean-up, `LabelPhotoFolders`). Does not save.
    func dropPendingBean(_ bean: StoredBean) throws {
        let beanID = bean.localID
        try removeOutboxOperations(for: beanID)
        let descriptor = FetchDescriptor<QueuedLabelPhoto>(
            predicate: #Predicate<QueuedLabelPhoto> { photo in photo.beanLocalID == beanID }
        )
        for photo in try context.fetch(descriptor) {
            context.delete(photo)
        }
        context.delete(bean)
    }

    /// A bean described with pick lists while it could not be sent (`BeanEntryModel`), saved
    /// with its `create` and the label photos in `labelPhotoFiles` (file names in the account's
    /// queue folder), all in one save. A bean already on the device with the same barcode is
    /// used instead:
    /// - without a server id, it takes the picks (an unsent create sends them; a pending scan
    ///   becomes a create, without its Open Food Facts question);
    /// - with one, the server's bean cannot take them: `picksKept` is false, so the screen can
    ///   say so. The photos are queued for it all the same.
    ///
    /// On failure nothing is changed: an existing bean and its operation get their saved
    /// values back (`write`).
    @discardableResult
    func addOfflineBean(_ create: API.BeanCreate, labelPhotoFiles: [String] = []) throws -> OfflineBeanResult {
        try write {
            try storeOfflineBean(create, labelPhotoFiles: labelPhotoFiles)
        }
    }

    private func storeOfflineBean(_ create: API.BeanCreate, labelPhotoFiles: [String]) throws -> OfflineBeanResult {
        let bean: StoredBean
        var picksKept = true
        if let barcode = create.barcode, let existing = try self.bean(barcode: barcode) {
            bean = existing
            if existing.serverID == nil {
                existing.pickedAttributeIDs = BeanAttributeIDs(create.attributes)
                if let scan = try pendingScanOperation(of: existing.localID) {
                    // The user described it: no Open Food Facts question any more.
                    existing.openFoodFactsConfirmed = false
                    existing.clearOpenFoodFactsProduct()
                    scan.actionRaw = OutboxAction.create.rawValue
                    scan.attemptCount = 0
                    scan.nextAttemptAt = Date.distantPast
                }
            } else {
                picksKept = create.attributes == API.BeanAttributes()
            }
        } else {
            bean = StoredBean(create)
            bean.syncState = .pendingCreate
            context.insert(bean)
            try enqueue(.create, .bean, localID: bean.localID)
        }
        for fileName in labelPhotoFiles {
            queueLabelPhoto(fileName: fileName, beanLocalID: bean.localID)
        }
        try save()
        return OfflineBeanResult(bean: bean, picksKept: picksKept)
    }

    /// The pending beans the user is asked about, in queue order: an Open Food Facts hit to
    /// confirm, or a bean to describe. Beans without a live shelf entry are left out.
    func pendingBeanQuestions() throws -> [PendingBeanQuestion] {
        var questions: [PendingBeanQuestion] = []
        for operation in try questionOperations() {
            guard let bean = try self.bean(localID: operation.localID), bean.serverID == nil, bean.hasLiveShelfEntries else {
                continue
            }
            let barcode = bean.barcode.flatMap { code in CanonicalBarcode(code) }
            switch operation.action {
            case .awaitConfirmation?:
                if let product = bean.heldOpenFoodFactsProduct {
                    questions.append(PendingBeanQuestion(beanID: bean.localID, barcode: barcode, kind: .confirm(product)))
                } else {
                    questions.append(PendingBeanQuestion(beanID: bean.localID, barcode: barcode, kind: .describe))
                }
            case .awaitDescription?:
                questions.append(PendingBeanQuestion(beanID: bean.localID, barcode: barcode, kind: .describe))
            default:
                break
            }
        }
        return questions
    }

    /// The user confirms the Open Food Facts hit of a pending bean: it is created with
    /// `open_food_facts_confirmed` and the optional picks, and the operations that waited for
    /// it go out after it. False when the bean waits for no confirmation (any more).
    @discardableResult
    func confirmOpenFoodFacts(beanLocalID: UUID, picks: API.BeanAttributes) throws -> Bool {
        try write { () throws -> Bool in
            guard let operation = try question(.awaitConfirmation, of: beanLocalID), let bean = try self.bean(localID: beanLocalID) else {
                return false
            }
            bean.openFoodFactsConfirmed = true
            bean.pickedAttributeIDs = BeanAttributeIDs(picks)
            settleQuestion(operation, as: .create)
            try save()
            return true
        }
    }

    /// The user says the hit is not their coffee: the product is dropped and the user is asked
    /// to describe the bean instead (docs/04 F1 step 4). False when the bean waits for no
    /// confirmation (any more).
    @discardableResult
    func rejectOpenFoodFacts(beanLocalID: UUID) throws -> Bool {
        try write { () throws -> Bool in
            guard let operation = try question(.awaitConfirmation, of: beanLocalID), let bean = try self.bean(localID: beanLocalID) else {
                return false
            }
            bean.openFoodFactsConfirmed = false
            bean.clearOpenFoodFactsProduct()
            settleQuestion(operation, as: .awaitDescription)
            try save()
            return true
        }
    }

    /// The user described a pending bean: it is created with the picks, and the label photos in
    /// `labelPhotoFiles` (names in the account's queue folder) are queued, in one save. False
    /// when the bean waits for no description (any more).
    @discardableResult
    func describePendingBean(beanLocalID: UUID, picks: API.BeanAttributes, labelPhotoFiles: [String] = []) throws -> Bool {
        try write { () throws -> Bool in
            guard let operation = try question(.awaitDescription, of: beanLocalID), let bean = try self.bean(localID: beanLocalID) else {
                return false
            }
            bean.pickedAttributeIDs = BeanAttributeIDs(picks)
            for fileName in labelPhotoFiles {
                queueLabelPhoto(fileName: fileName, beanLocalID: beanLocalID)
            }
            settleQuestion(operation, as: .create)
            try save()
            return true
        }
    }

    /// The user skips the description: the bean is created from its barcode alone. False when
    /// the bean waits for no description (any more).
    @discardableResult
    func skipDescription(beanLocalID: UUID) throws -> Bool {
        try write { () throws -> Bool in
            guard let operation = try question(.awaitDescription, of: beanLocalID) else {
                return false
            }
            settleQuestion(operation, as: .create)
            try save()
            return true
        }
    }

    /// The state of every pending bean with a look-up or a question still queued, by its local
    /// id. Parked operations are sync issues and are left out.
    func pendingBeanStates() throws -> [UUID: PendingBeanState] {
        let beanRaw = OutboxResource.bean.rawValue
        let descriptor = FetchDescriptor<OutboxOperation>(
            predicate: #Predicate<OutboxOperation> { operation in operation.parked == false && operation.resourceRaw == beanRaw }
        )
        var states: [UUID: PendingBeanState] = [:]
        for operation in try context.fetch(descriptor) {
            switch operation.action {
            case .lookUp?: states[operation.localID] = .lookingUp
            case .awaitConfirmation?: states[operation.localID] = .awaitingConfirmation
            case .awaitDescription?: states[operation.localID] = .awaitingDescription
            default: break
            }
        }
        return states
    }

    private func questionOperations() throws -> [OutboxOperation] {
        let confirm = OutboxAction.awaitConfirmation.rawValue
        let describe = OutboxAction.awaitDescription.rawValue
        let beanRaw = OutboxResource.bean.rawValue
        let descriptor = FetchDescriptor<OutboxOperation>(
            predicate: #Predicate<OutboxOperation> { operation in
                operation.parked == false && operation.resourceRaw == beanRaw
                    && (operation.actionRaw == confirm || operation.actionRaw == describe)
            },
            sortBy: [SortDescriptor(\OutboxOperation.sequence)]
        )
        return try context.fetch(descriptor)
    }

    private func question(_ action: OutboxAction, of beanLocalID: UUID) throws -> OutboxOperation? {
        try outboxOperations(for: beanLocalID).first { operation in
            !operation.parked && operation.action == action && operation.resource == .bean
        }
    }

    /// Turns a question into `action`, to be sent at once. Does not save; only called inside a
    /// `write`, so a failed save puts the question back.
    private func settleQuestion(_ operation: OutboxOperation, as action: OutboxAction) {
        operation.actionRaw = action.rawValue
        operation.attemptCount = 0
        operation.nextAttemptAt = Date.distantPast
    }

    // MARK: - Queued label photos

    /// Adds a queued label photo for the bean. Does not save: the caller saves it with the
    /// bean, or on its own.
    @discardableResult
    func queueLabelPhoto(fileName: String, beanLocalID: UUID) -> QueuedLabelPhoto {
        let photo = QueuedLabelPhoto(beanLocalID: beanLocalID, fileName: fileName)
        context.insert(photo)
        return photo
    }

    /// Every queued label photo, oldest first.
    func queuedLabelPhotos() throws -> [QueuedLabelPhoto] {
        try context.fetch(FetchDescriptor<QueuedLabelPhoto>(sortBy: [SortDescriptor(\QueuedLabelPhoto.createdAt)]))
    }

    func queuedLabelPhoto(localID: UUID) throws -> QueuedLabelPhoto? {
        var descriptor = FetchDescriptor<QueuedLabelPhoto>(
            predicate: #Predicate<QueuedLabelPhoto> { photo in photo.localID == localID }
        )
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    /// The file names of every queued label photo: the files of the account's queue folder
    /// that must stay (`LabelPhotoFolders`).
    func queuedLabelPhotoFileNames() throws -> Set<String> {
        Set(try queuedLabelPhotos().map(\.fileName))
    }

    /// Removes a queued label photo. Does not save and does not touch the file.
    func removeQueuedLabelPhoto(_ photo: QueuedLabelPhoto) {
        context.delete(photo)
    }

    /// Moves the queued label photos of one local bean to another, when the engine merges a
    /// pending bean into the local copy of the same catalogue bean. Does not save.
    func moveQueuedLabelPhotos(from oldBean: UUID, to newBean: UUID) throws {
        let descriptor = FetchDescriptor<QueuedLabelPhoto>(
            predicate: #Predicate<QueuedLabelPhoto> { photo in photo.beanLocalID == oldBean }
        )
        for photo in try context.fetch(descriptor) {
            photo.beanLocalID = newBean
        }
    }
}

extension StoredBean {
    /// Drops the Open Food Facts product of a pending bean (a rejected or replaced hit).
    func clearOpenFoodFactsProduct() {
        hasOpenFoodFactsProduct = false
        openFoodFactsMatch = false
        openFoodFactsName = nil
        openFoodFactsBrand = nil
        openFoodFactsImageID = nil
    }

    /// Keeps the Open Food Facts product the lookup found for a pending bean, until the user
    /// confirms or rejects it. Untrusted text (ADR 0005): shown with `Text(verbatim:)` only,
    /// never sent back and never logged.
    func holdOpenFoodFactsProduct(_ product: API.OpenFoodFactsProduct) {
        hasOpenFoodFactsProduct = true
        openFoodFactsMatch = false
        openFoodFactsName = product.name
        openFoodFactsBrand = product.brand
        openFoodFactsImageID = product.imageId
    }

    /// The held Open Food Facts product, nil without one.
    var heldOpenFoodFactsProduct: API.OpenFoodFactsProduct? {
        guard hasOpenFoodFactsProduct else {
            return nil
        }
        return API.OpenFoodFactsProduct(name: openFoodFactsName, brand: openFoodFactsBrand, imageId: openFoodFactsImageID)
    }
}
