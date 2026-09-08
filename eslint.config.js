import babelParser from '@babel/eslint-parser'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

const restrictedTauriCoreImports = ['error', {
    paths: [
        {
            name: '@tauri-apps/api/core',
            importNames: ['isTauri'],
            message: 'Use src/platform/runtime or the runtime capability matrix instead of adding a raw platform branch.',
        },
        {
            name: '@tauri-apps/api/core',
            importNames: ['convertFileSrc'],
            message: 'Use src/platform/asset-url so native asset protocol details stay in the platform layer.',
        },
    ],
}]

const restrictedAssetUrlImport = ['error', {
    paths: [{
        name: '@tauri-apps/api/core',
        importNames: ['convertFileSrc'],
        message: 'Use src/platform/asset-url so native asset protocol details stay in the platform layer.',
    }],
}]

// Babel 8 uses extension-independent TypeScript parsing for ESLint, while the
// JSX syntax plugin keeps the same parser contract for both .ts and .tsx files.
const typescriptParserOptions = {
    ecmaVersion: 'latest',
    sourceType: 'module',
    requireConfigFile: false,
    babelOptions: {
        presets: [['@babel/preset-typescript', { ignoreExtensions: true }]],
        plugins: ['@babel/plugin-syntax-jsx'],
    },
}

export default [
    {
        ignores: [
            'dist/**',
            // Local QA evidence may contain deliberately failing fixtures; maintained tests live under tests/.
            'artifacts/**',
            'node_modules/**',
            'NAI-Blue-main/**',
            'src-tauri/**',
        ],
    },
    {
        files: ['src/**/*.{ts,tsx}', 'vite.config.ts'],
        languageOptions: {
            // Babel's ESLint parser supplies the TypeScript/TSX ESTree consumed by
            // React Hooks and import-boundary rules without coupling lint to tsc.
            parser: babelParser,
            parserOptions: typescriptParserOptions,
            globals: {
                ...globals.browser,
                ...globals.es2020,
                ...globals.node,
            },
        },
        plugins: {
            'react-hooks': reactHooks,
        },
        rules: {
            // Keep the established hook correctness gate while React Hooks 7's
            // compiler-oriented rules are evaluated in a dedicated refactor.
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'off',
            'no-restricted-imports': restrictedTauriCoreImports,
        },
    },
    {
        // Transitional rollback allowlist. These existing native adapters still
        // own platform-specific I/O; new call sites must use the capability matrix.
        files: [
            'src/components/backup/StoreSnapshotRestoreDialog.tsx',
            'src/components/backup/RestoreDialog.tsx',
            'src/components/layout/CustomTitleBar.tsx',
            'src/components/layout/HistoryPanel.tsx',
            'src/lib/auto-backup.ts',
            'src/lib/store-snapshots.ts',
            'src/pages/AssetModuleStudio.tsx',
            'src/services/asset-profile-file.ts',
            'src/services/credentials/legacy-credential-cleanup.ts',
            'src/services/credentials/stronghold-credential-vault.ts',
            'src/services/diagnostics/exporter.ts',
            'src/services/nai/transport.ts',
            'src/services/r2/native-r2-adapter.ts',
            'src/services/sync/native-lan-transport-adapter.ts',
        ],
        rules: {
            // These transition files may still probe isTauri, but asset URL
            // conversion is now owned exclusively by the platform adapter.
            'no-restricted-imports': restrictedAssetUrlImport,
        },
    },
    {
        // This adapter is the single approved owner of Tauri asset protocol conversion.
        files: ['src/platform/asset-url.ts'],
        rules: {
            'no-restricted-imports': 'off',
        },
    },
    {
        files: ['tests/**/*.ts', 'vitest.config.ts'],
        languageOptions: {
            parser: babelParser,
            parserOptions: typescriptParserOptions,
            globals: {
                ...globals.es2020,
                ...globals.node,
            },
        },
    },
    {
        files: ['cloudflare/**/*.ts'],
        languageOptions: {
            parser: babelParser,
            parserOptions: typescriptParserOptions,
            globals: {
                ...globals.es2020,
                ...globals.worker,
            },
        },
    },
    {
        files: ['scripts/**/*.mjs', 'eslint.config.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.es2020,
            },
        },
    },
]
