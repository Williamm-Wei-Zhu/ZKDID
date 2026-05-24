import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    // circomlibjs references Node globals (global, process) that the browser
    // doesn't provide. Alias them to safe browser equivalents.
    define: {
        global: 'globalThis',
        'process.env.NODE_DEBUG': 'undefined',
        'process.browser': 'true',
    },
    resolve: {
        alias: {
            buffer: 'buffer',
        },
    },
    optimizeDeps: {
        include: ['buffer', 'circomlibjs'],
    },
    build: {
        chunkSizeWarningLimit: 1000,
    },
    server: {
        port: 1234,
        host: true,
        allowedHosts: true,
    }
})
