module did_vc::store_did_vc {
    use sui::object;
    use sui::tx_context::TxContext;
    use sui::transfer;

    public struct DIDVC has key, store {
        id: UID,
        did: vector<u8>,
        vc: vector<u8>,
    }

    public entry fun create_did_vc(
        did: vector<u8>,
        vc: vector<u8>,
        ctx: &mut TxContext
    ) {
        let obj = DIDVC {
            id: object::new(ctx),
            did,
            vc,
        };
        transfer::transfer(obj, tx_context::sender(ctx));
    }
}
