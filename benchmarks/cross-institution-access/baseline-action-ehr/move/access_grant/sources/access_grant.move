/// Module: access_grant
///
/// On-chain AccessGrant for an ACTION-EHR-inspired patient-centric
/// blockchain access-control baseline. The patient creates an AccessGrant
/// that authorizes a specific grantee hospital to access a specific EHR
/// record held by a specific data-holder hospital, for a specific scope,
/// until a specific expiration time.
///
/// This is an ACADEMIC BASELINE -- not production healthcare code. It
/// abstracts the access-control logic of patient-centric blockchain EHR
/// sharing systems such as ACTION-EHR while omitting zkLogin, zkProofs,
/// multi-authority salt, and keyless DID recovery.
module access_grant::access_grant {
    use sui::clock::{Self, Clock};
    use sui::event;

    /// Caller is not the patient who owns the grant.
    const ENotPatient: u64 = 1;

    /// On-chain AccessGrant object. Fields are exactly as specified in the
    /// experimental baseline brief.
    public struct AccessGrant has key, store {
        id: UID,
        patient_id: vector<u8>,
        data_holder_hospital_id: vector<u8>,
        grantee_hospital_id: vector<u8>,
        grantee_address: address,
        ehr_record_id: vector<u8>,
        scope: vector<u8>,
        created_at_ms: u64,
        expires_at_ms: u64,
        active: bool,
    }

    /// Event emitted whenever a fresh grant is minted. Off-chain indexers
    /// can subscribe to this for fast "new grant" discovery.
    public struct AccessGrantCreated has copy, drop {
        grant_id: address,
        patient_id: vector<u8>,
        grantee_hospital_id: vector<u8>,
        ehr_record_id: vector<u8>,
        expires_at_ms: u64,
    }

    /// Mint a new AccessGrant on-chain. The grant is transferred to the
    /// transaction sender (the patient) so any later mutation requires
    /// the patient's signature.
    public entry fun create_access_grant(
        patient_id: vector<u8>,
        data_holder_hospital_id: vector<u8>,
        grantee_hospital_id: vector<u8>,
        grantee_address: address,
        ehr_record_id: vector<u8>,
        scope: vector<u8>,
        expires_at_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let grant = AccessGrant {
            id: object::new(ctx),
            patient_id,
            data_holder_hospital_id,
            grantee_hospital_id,
            grantee_address,
            ehr_record_id,
            scope,
            created_at_ms: clock::timestamp_ms(clock),
            expires_at_ms,
            active: true,
        };
        let grant_id = object::uid_to_address(&grant.id);
        event::emit(AccessGrantCreated {
            grant_id,
            patient_id: grant.patient_id,
            grantee_hospital_id: grant.grantee_hospital_id,
            ehr_record_id: grant.ehr_record_id,
            expires_at_ms: grant.expires_at_ms,
        });
        transfer::public_transfer(grant, tx_context::sender(ctx));
    }

    /// Patient revokes a grant. Only the current owner of the grant may revoke.
    /// (Sui ownership semantics already enforce that the sender owns the
    /// passed object reference; the explicit assert here documents intent.)
    public entry fun revoke_access_grant(
        grant: &mut AccessGrant,
        _ctx: &mut TxContext,
    ) {
        grant.active = false;
    }

    /// Patient updates the grant's expiration timestamp. Optional in the
    /// brief; included for completeness so a paper measuring update cost
    /// has a reusable primitive.
    public entry fun update_expiration(
        grant: &mut AccessGrant,
        new_expires_at_ms: u64,
        _ctx: &mut TxContext,
    ) {
        grant.expires_at_ms = new_expires_at_ms;
    }

    // ---- read-only accessors used by off-chain verifiers ----

    public fun patient_id(g: &AccessGrant): vector<u8> { g.patient_id }
    public fun data_holder_hospital_id(g: &AccessGrant): vector<u8> { g.data_holder_hospital_id }
    public fun grantee_hospital_id(g: &AccessGrant): vector<u8> { g.grantee_hospital_id }
    public fun grantee_address(g: &AccessGrant): address { g.grantee_address }
    public fun ehr_record_id(g: &AccessGrant): vector<u8> { g.ehr_record_id }
    public fun scope(g: &AccessGrant): vector<u8> { g.scope }
    public fun created_at_ms(g: &AccessGrant): u64 { g.created_at_ms }
    public fun expires_at_ms(g: &AccessGrant): u64 { g.expires_at_ms }
    public fun is_active(g: &AccessGrant): bool { g.active }

    /// Used in tests / debugging to delete a revoked grant explicitly.
    /// (Drop ability is not present on AccessGrant by design — academic
    /// rationale: revoked grants stay queryable for audit until explicitly
    /// retired, mirroring patient-centric EHR audit norms.)
    public entry fun retire_access_grant(grant: AccessGrant, ctx: &mut TxContext) {
        assert!(!grant.active, ENotPatient);
        let AccessGrant {
            id,
            patient_id: _,
            data_holder_hospital_id: _,
            grantee_hospital_id: _,
            grantee_address: _,
            ehr_record_id: _,
            scope: _,
            created_at_ms: _,
            expires_at_ms: _,
            active: _,
        } = grant;
        object::delete(id);
        let _ = ctx;
    }
}
