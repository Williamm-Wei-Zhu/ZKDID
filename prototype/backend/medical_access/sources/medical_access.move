/// Module: medical_access
/// Stores medical access grants and Verifiable Credentials
module medical_access::medical_access {
    use std::string::{Self, String};

    /// Access grant record
    public struct AccessGrant has key, store {
        id: UID,
        patient_did: vector<u8>,    // Patient DID
        hospital_did: vector<u8>,   // Hospital/institution DID (owner/creator/custodian of EHR records)
        grantee_did: vector<u8>,    // Grantee DID (entity being granted access)
        record_id: vector<u8>,      // Record ID or VC JSON
        timestamp: u64,             // Grant timestamp
        is_active: bool,            // Whether the grant is active
    }

    /// Create a new access grant
    public entry fun create_access_grant(
        patient_did: vector<u8>,
        hospital_did: vector<u8>,
        grantee_did: vector<u8>,
        record_id: vector<u8>,
        timestamp: u64,
        ctx: &mut TxContext
    ) {
        let grant = AccessGrant {
            id: object::new(ctx),
            patient_did,
            hospital_did,
            grantee_did,
            record_id,
            timestamp,
            is_active: true,
        };
        transfer::transfer(grant, tx_context::sender(ctx));
    }

    /// Revoke an access grant
    public entry fun revoke_access_grant(
        grant: &mut AccessGrant,
        _ctx: &mut TxContext
    ) {
        grant.is_active = false;
    }

    /// Check if the grant is active
    public fun is_grant_active(grant: &AccessGrant): bool {
        grant.is_active
    }

    /// Get patient DID
    public fun get_patient_did(grant: &AccessGrant): vector<u8> {
        grant.patient_did
    }

    /// Get hospital/institution DID
    public fun get_hospital_did(grant: &AccessGrant): vector<u8> {
        grant.hospital_did
    }

    /// Get grantee DID
    public fun get_grantee_did(grant: &AccessGrant): vector<u8> {
        grant.grantee_did
    }

    /// Get record content
    public fun get_record_id(grant: &AccessGrant): vector<u8> {
        grant.record_id
    }
}
