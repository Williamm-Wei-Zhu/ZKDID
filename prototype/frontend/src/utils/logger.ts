import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';

export function logZkLoginSetup(data: {
    publicKey: Ed25519PublicKey,
    privateKey: string,
    randomness: bigint,
    nonce: string,
    maxEpoch: number
}) {
    const logContent = `
===== zkLogin Setup Info (${new Date().toISOString()}) =====
Ephemeral Public Key: ${data.publicKey.toBase64()}
Ephemeral Private Key: ${data.privateKey}
Randomness: ${data.randomness.toString()}
Nonce: ${data.nonce}
Max Epoch: ${data.maxEpoch}
===============================================
`;

    // Use console.log in development environment
    if (process.env.NODE_ENV === 'development') {
        console.log(logContent);
    }

    // Create Blob and trigger download
    const blob = new Blob([logContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zklogin-setup-${Date.now()}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}