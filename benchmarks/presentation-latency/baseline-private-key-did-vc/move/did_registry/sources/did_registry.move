/// Module: did_registry
///
/// Minimal on-chain DID registry for the Private-key DID/VC baseline.
/// Each `DIDObject` is owned by the controller account; the `create_did_object`
/// entry function emits a fresh object per DID establishment so the experiment
/// can measure the cost of on-chain registration including transaction
/// finality.
///
/// This is an academic baseline -- NOT production-grade. Real systems need
/// resolution registries, key rotation events, and access-control hooks.
module did_registry::did_registry {
    use sui::clock::{Self, Clock};
    use sui::transfer;

    /// Controller mismatch -- only the controller may mutate or deactivate.
    const ENotController: u64 = 1;

    public struct DIDObject has key, store {
        id: UID,
        did: vector<u8>,
        public_key: vector<u8>,
        controller: address,
        metadata: vector<u8>,
        created_at: u64,
        active: bool,
    }

    /// Register a new DID on chain. The DIDObject is transferred to the sender
    /// so subsequent updates / deactivations require the controller's signature.
    public entry fun create_did_object(
        did: vector<u8>,
        public_key: vector<u8>,
        metadata: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let did_obj = DIDObject {
            id: object::new(ctx),
            did,
            public_key,
            controller: tx_context::sender(ctx),
            metadata,
            created_at: clock::timestamp_ms(clock),
            active: true,
        };
        transfer::transfer(did_obj, tx_context::sender(ctx));
    }

    /// Replace the metadata blob associated with the DID.
    public entry fun update_did_metadata(
        did_object: &mut DIDObject,
        metadata: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == did_object.controller, ENotController);
        did_object.metadata = metadata;
    }

    /// Mark the DID inactive. Cannot be reversed in this baseline.
    public entry fun deactivate_did(
        did_object: &mut DIDObject,
        ctx: &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == did_object.controller, ENotController);
        did_object.active = false;
    }

    // ---- read-only accessors used by off-chain resolvers ---

    public fun did(did_object: &DIDObject): vector<u8> { did_object.did }
    public fun public_key(did_object: &DIDObject): vector<u8> { did_object.public_key }
    public fun controller(did_object: &DIDObject): address { did_object.controller }
    public fun metadata(did_object: &DIDObject): vector<u8> { did_object.metadata }
    public fun created_at(did_object: &DIDObject): u64 { did_object.created_at }
    public fun is_active(did_object: &DIDObject): bool { did_object.active }
}
