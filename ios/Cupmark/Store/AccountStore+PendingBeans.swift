import Foundation
import SwiftData

// Pending beans and queued label photos (M2-T25, docs/04 Non-functional: Offline).
//
// - A barcode scanned while the lookup cannot answer (no network, the service unavailable,
//   the daily lookup cap) is kept as a pending bean: a `StoredBean` with the barcode and no
//   server id, and a `lookUp` operation. It can go on the shelf and have brews at once. When
//   the engine reaches the look-up it asks `GET /barcodes/{barcode}`, then Open Food Facts
//   through the backend: a known bean is used, a miss is created as it is, a hit waits for the
//   user (`awaitConfirmation`), who is asked the next time the app is opened.
// - A bean described with pick lists while offline is a plain `create`: it is created without
//   asking (a 409 for its barcode adopts the catalogue's bean, ADR 0025).
// - The shelf entries and brews of a pending bean need no rewrite: their bodies are built when
//   they are sent and name the bean through the relationship (ADR 0025), so they carry its
//   server id. Until it has one they wait, and every other operation goes out.
// - Label photos taken for a bean are queued here (`QueuedLabelPhoto`) and upload once the bean
//   has a server id (`LabelPhotoQueue`).

/// Where a pending bean's look-up stands, for the shelf.
enum PendingBeanState: Equatable, Sendable {
    /// The barcode is looked up once the device is online.
    case lookingUp
    /// Open Food Facts has a product for it: the user is asked to confirm it.
    case awaitingConfirmation
}

extension StoredBean {
    /// Whether the bean's Open Food Facts name and brand are shown: a catalogue bean's, or a
    /// hit the user confirmed. A hit that waits for the user's answer is shown only on the
    /// confirmation screen, not as the bean's name.
    var showsOpenFoodFactsText: Bool {
        serverID != nil || openFoodFactsConfirmed
    }
}

extension AccountStore {
    // MARK: - Pending beans

    /// The bean for a barcode scanned while the lookup could not answer, saved with its
    /// `lookUp` operation. A bean already on the device with this barcode (a cached catalogue
    /// bean, or one still pending) is returned instead, so a barcode has one local bean.
    @discardableResult
    func pendingBean(barcode: CanonicalBarcode) throws -> StoredBean {
        if let existing = try self.bean(barcode: barcode.digits) {
            return existing
        }
        let bean = StoredBean(barcode: barcode.digits)
        bean.syncState = .pendingCreate
        context.insert(bean)
        try enqueue(.lookUp, .bean, localID: bean.localID)
        try save()
        return bean
    }

    /// A bean described with pick lists while it could not be sent (`BeanEntryModel`), saved
    /// with its `create` and the label photos in `labelPhotoFiles` (file names in the account's
    /// queue folder), all in one save. A bean already on the device with the same barcode is
    /// used instead: a pending scan of it takes the picks and is created without a look-up.
    @discardableResult
    func addOfflineBean(_ create: API.BeanCreate, labelPhotoFiles: [String] = []) throws -> StoredBean {
        let bean: StoredBean
        if let barcode = create.barcode, let existing = try self.bean(barcode: barcode) {
            bean = existing
            let operations = try outboxOperations(for: existing.localID)
            if existing.serverID == nil,
               let lookUp = operations.first(where: { operation in operation.action == .lookUp || operation.action == .awaitConfirmation }) {
                // The user described it: no Open Food Facts question any more.
                existing.pickedAttributeIDs = BeanAttributeIDs(create.attributes)
                existing.openFoodFactsConfirmed = false
                existing.clearOpenFoodFactsProduct()
                lookUp.actionRaw = OutboxAction.create.rawValue
                lookUp.attemptCount = 0
                lookUp.nextAttemptAt = Date.distantPast
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
        return bean
    }

    /// The beans with an Open Food Facts hit waiting for the user's answer, in queue order.
    func beansAwaitingConfirmation() throws -> [StoredBean] {
        var beans: [StoredBean] = []
        for operation in try awaitingConfirmationOperations() {
            if let bean = try self.bean(localID: operation.localID), bean.serverID == nil {
                beans.append(bean)
            }
        }
        return beans
    }

    /// The user confirms the Open Food Facts hit of a pending bean: it is created with
    /// `open_food_facts_confirmed` and the optional picks, and the operations that waited for
    /// it go out after it. False when the bean waits for no confirmation (any more).
    @discardableResult
    func confirmOpenFoodFacts(beanLocalID: UUID, picks: API.BeanAttributes) throws -> Bool {
        guard let operation = try awaitingConfirmation(of: beanLocalID), let bean = try self.bean(localID: beanLocalID) else {
            return false
        }
        bean.openFoodFactsConfirmed = true
        bean.pickedAttributeIDs = BeanAttributeIDs(picks)
        operation.actionRaw = OutboxAction.create.rawValue
        operation.attemptCount = 0
        operation.nextAttemptAt = Date.distantPast
        try save()
        return true
    }

    /// The user says the hit is not their coffee: the bean is created from its barcode alone,
    /// without the Open Food Facts product, and the operations that waited go out after it.
    /// False when the bean waits for no confirmation (any more).
    @discardableResult
    func rejectOpenFoodFacts(beanLocalID: UUID) throws -> Bool {
        guard let operation = try awaitingConfirmation(of: beanLocalID), let bean = try self.bean(localID: beanLocalID) else {
            return false
        }
        bean.openFoodFactsConfirmed = false
        bean.clearOpenFoodFactsProduct()
        operation.actionRaw = OutboxAction.create.rawValue
        operation.attemptCount = 0
        operation.nextAttemptAt = Date.distantPast
        try save()
        return true
    }

    /// The state of every pending bean with a look-up or a confirmation still queued, by its
    /// local id. Parked operations are sync issues and are left out.
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
            default: break
            }
        }
        return states
    }

    private func awaitingConfirmationOperations() throws -> [OutboxOperation] {
        let awaiting = OutboxAction.awaitConfirmation.rawValue
        let beanRaw = OutboxResource.bean.rawValue
        let descriptor = FetchDescriptor<OutboxOperation>(
            predicate: #Predicate<OutboxOperation> { operation in
                operation.parked == false && operation.actionRaw == awaiting && operation.resourceRaw == beanRaw
            },
            sortBy: [SortDescriptor(\OutboxOperation.sequence)]
        )
        return try context.fetch(descriptor)
    }

    private func awaitingConfirmation(of beanLocalID: UUID) throws -> OutboxOperation? {
        try outboxOperations(for: beanLocalID).first { operation in
            !operation.parked && operation.action == .awaitConfirmation && operation.resource == .bean
        }
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
