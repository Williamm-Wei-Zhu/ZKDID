import fs from 'fs';

interface LogEntry {
    timestamp: string;
    event: string;
    data: {
        ephemeralPrivateKey?: string;
        randomness?: string; 
        nonce?: string;
        maxEpoch?: number;
        provider?: string;
    }
}

export function logZkLoginData(entry: LogEntry) {
    const logLine = `[${entry.timestamp}] ${entry.event}\n${JSON.stringify(entry.data, null, 2)}\n\n`;
    
    // Use console.log in development environment
    if (process.env.NODE_ENV === 'development') {
        console.log(logLine);
    }

    // Create and download the log file
    const blob = new Blob([logLine], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zklogin-${Date.now()}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Example usage:
// logZkLoginData({
//     timestamp: new Date().toISOString(),
//     event: 'Generated new ephemeral key',
//     data: {
//         ephemeralPrivateKey: 'base64Key...',
//         randomness: 'randomValue',
//         nonce: 'generatedNonce',
//         maxEpoch: 2,
//         provider: 'Google'
//     }
// });