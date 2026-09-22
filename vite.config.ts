import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

const tauriPlatform = (process.env.TAURI_ENV_PLATFORM ?? '').toLowerCase()
const tauriBuild = ['android', 'ios', 'windows', 'macos', 'linux'].includes(tauriPlatform)

const getNodePackageName = (normalizedId: string) => {
    const marker = '/node_modules/'
    const markerIndex = normalizedId.lastIndexOf(marker)

    if (markerIndex === -1) {
        return undefined
    }

    const packagePath = normalizedId.slice(markerIndex + marker.length)
    const segments = packagePath.split('/')

    if (segments[0]?.startsWith('@')) {
        return segments[1] ? `${segments[0]}/${segments[1]}` : segments[0]
    }

    return segments[0]
}

// https://vite.dev/config/
export default defineConfig({
    // React compiles the UI while Tailwind's dedicated Vite integration scans
    // the same module graph and emits the CSS consumed by desktop and Android.
    plugins: [react(), tailwindcss()],
    define: {
        __NAI_BLUE_TAURI_PLATFORM__: JSON.stringify(process.env.TAURI_ENV_PLATFORM ?? ''),
        __NAI_BLUE_TAURI_BUILD__: JSON.stringify(tauriBuild),
    },
    resolve: {
        alias: {
            '@': path.resolve(import.meta.dirname, './src'),
        },
    },
    build: {
        chunkSizeWarningLimit: 30000,
        rollupOptions: {
            output: {
                manualChunks(id) {
                    const normalizedId = id.replace(/\\/g, '/')

                    if (normalizedId.includes('/src/assets/tags.json')) {
                        return 'tag-data'
                    }

                    if (!normalizedId.includes('/node_modules/')) {
                        return undefined
                    }

                    const packageName = getNodePackageName(normalizedId)

                    if (
                        packageName === 'react' ||
                        packageName === 'react-dom' ||
                        packageName === 'react-router' ||
                        packageName === 'scheduler'
                    ) {
                        return 'react-vendor'
                    }

                    if (packageName?.startsWith('@tauri-apps/')) {
                        return 'tauri-vendor'
                    }

                    if (
                        packageName?.startsWith('@radix-ui/') ||
                        packageName === 'framer-motion' ||
                        packageName === 'lucide-react'
                    ) {
                        return 'ui-vendor'
                    }

                    if (
                        packageName?.startsWith('@gradio/') ||
                        packageName?.startsWith('@msgpack/') ||
                        packageName === 'fuse.js' ||
                        packageName === 'jszip' ||
                        packageName === 'pako'
                    ) {
                        return 'data-vendor'
                    }

                    return 'vendor'
                },
            },
        },
    },
    // Tauri dev server 설정
    clearScreen: false,
    server: {
        port: 9090,
        strictPort: true,
        watch: {
            ignored: ['**/src-tauri/**'],
        },
    },
})
