/**
 * Minimal ambient type declarations for snarkjs and circomlibjs.
 *
 * Both packages ship as plain JS without TS types. We only declare the
 * surfaces actually used by the ZK-VC experiment so we keep `strict: true`
 * but don't pull in transitive `any` from across the package.
 */

declare module "snarkjs" {
  export namespace groth16 {
    export function fullProve(
      input: Record<string, unknown>,
      wasmFile: string | Uint8Array,
      zkeyFile: string | Uint8Array,
    ): Promise<{ proof: unknown; publicSignals: string[] }>;

    export function verify(
      vKey: unknown,
      publicSignals: string[],
      proof: unknown,
    ): Promise<boolean>;
  }
}

declare module "circomlibjs" {
  export interface PoseidonF {
    toObject(value: unknown): bigint;
    e(value: bigint | string | number): unknown;
  }
  export interface Poseidon {
    (inputs: Array<bigint | string | number>): unknown;
    F: PoseidonF;
  }
  export interface EddsaSignature {
    R8: [unknown, unknown];
    S: bigint;
  }
  export interface Eddsa {
    F: PoseidonF;
    prv2pub(privateKey: Uint8Array | Buffer): [unknown, unknown];
    signPoseidon(privateKey: Uint8Array | Buffer, message: unknown): EddsaSignature;
    verifyPoseidon(message: unknown, signature: EddsaSignature, publicKey: [unknown, unknown]): boolean;
  }

  export function buildPoseidon(): Promise<Poseidon>;
  export function buildEddsa(): Promise<Eddsa>;
}
