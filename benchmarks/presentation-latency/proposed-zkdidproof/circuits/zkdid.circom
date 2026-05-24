pragma circom 2.1.8;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/eddsaposeidon.circom";

/*
 * Field representation used by this circuit:
 * - sub, iss, aud_jwt, nonce_jwt are canonicalized off-circuit into field elements.
 * - m_jwt is the Poseidon commitment to those canonicalized claims.
 * - sig_* is an EdDSA-Poseidon signature by the trusted OP over m_jwt.
 *
 * For production JWTs signed with RS256/ES256, replace JWTValidity with a
 * matching verifier or use a ZK-friendly OP signing adapter.
 */
template JWTValidity(PK_OP_X, PK_OP_Y) {
    signal input m_jwt;
    signal input sig_r8x;
    signal input sig_r8y;
    signal input sig_s;
    signal input sub;
    signal input iss;
    signal input aud_jwt;
    signal input nonce_jwt;

    component payload = Poseidon(4);
    payload.inputs[0] <== sub;
    payload.inputs[1] <== iss;
    payload.inputs[2] <== aud_jwt;
    payload.inputs[3] <== nonce_jwt;

    m_jwt === payload.out;

    component verifier = EdDSAPoseidonVerifier();
    verifier.enabled <== 1;
    verifier.Ax <== PK_OP_X;
    verifier.Ay <== PK_OP_Y;
    verifier.R8x <== sig_r8x;
    verifier.R8y <== sig_r8y;
    verifier.S <== sig_s;
    verifier.M <== m_jwt;
}

template ChallengeNonce() {
    signal input r;
    signal input T_exp;
    signal input chal;
    signal input nonce_jwt;

    component h = Poseidon(3);
    h.inputs[0] <== r;
    h.inputs[1] <== T_exp;
    h.inputs[2] <== chal;

    nonce_jwt === h.out;
}

template DIDDerivation() {
    signal input sub;
    signal input iss;
    signal input salt;
    signal input DID;

    component h = Poseidon(3);
    h.inputs[0] <== sub;
    h.inputs[1] <== iss;
    h.inputs[2] <== salt;

    DID === h.out;
}

template PublicBinding() {
    signal input aud_jwt;
    signal input aud;

    aud_jwt === aud;
}

template ZkDIDProof(PK_OP_X, PK_OP_Y) {
    signal input DID;
    signal input aud;
    signal input T_exp;
    signal input chal;

    signal input m_jwt;
    signal input sig_r8x;
    signal input sig_r8y;
    signal input sig_s;
    signal input sub;
    signal input iss;
    signal input aud_jwt;
    signal input nonce_jwt;
    signal input salt;
    signal input r;

    component jwt = JWTValidity(PK_OP_X, PK_OP_Y);
    jwt.m_jwt <== m_jwt;
    jwt.sig_r8x <== sig_r8x;
    jwt.sig_r8y <== sig_r8y;
    jwt.sig_s <== sig_s;
    jwt.sub <== sub;
    jwt.iss <== iss;
    jwt.aud_jwt <== aud_jwt;
    jwt.nonce_jwt <== nonce_jwt;

    component nonce = ChallengeNonce();
    nonce.r <== r;
    nonce.T_exp <== T_exp;
    nonce.chal <== chal;
    nonce.nonce_jwt <== nonce_jwt;

    component did = DIDDerivation();
    did.sub <== sub;
    did.iss <== iss;
    did.salt <== salt;
    did.DID <== DID;

    component bind = PublicBinding();
    bind.aud_jwt <== aud_jwt;
    bind.aud <== aud;
}
