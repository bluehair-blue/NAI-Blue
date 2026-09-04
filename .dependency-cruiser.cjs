/** @type {import('dependency-cruiser').IConfiguration} */
const presentationTauriBaseline = require('./.dependency-cruiser-presentation-tauri-baseline.json')

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const knownPresentationTauriImporters = `^(?:${presentationTauriBaseline
    .map(entry => escapeRegex(entry.file))
    .join('|')})$`

module.exports = {
    // These rules depend on dependency-cruiser's resolved TypeScript graph and
    // guard the target domain/application/adapter boundaries. Existing debt is
    // captured in the checked-in baseline so only newly introduced edges fail CI.
    forbidden: [
        {
            name: 'no-circular',
            comment: 'Cycles hide ownership and make the planned modular-monolith cutover unsafe.',
            severity: 'error',
            from: {},
            to: { circular: true },
        },
        {
            name: 'domain-only-depends-on-domain',
            comment: 'Domain rules must remain portable and may only collaborate with other domain modules.',
            severity: 'error',
            from: { path: '^src/domain/' },
            to: {
                path: '^src/(?!domain/)',
            },
        },
        {
            name: 'domain-has-no-package-dependencies',
            comment: 'Domain code stays deterministic by avoiding runtime and UI packages.',
            severity: 'error',
            from: { path: '^src/domain/' },
            to: {
                dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg'],
            },
        },
        {
            name: 'application-does-not-depend-on-implementation-layers',
            comment: 'Application use cases collaborate through domain types and ports, not UI or concrete adapters.',
            severity: 'error',
            from: { path: '^src/application/' },
            to: {
                path: '^src/(?:adapters|components|hooks|lib|pages|platform|presentation|services|stores)/',
            },
        },
        {
            name: 'application-has-no-ui-runtime-packages',
            comment: 'React, Zustand, and Tauri belong outside application use cases.',
            severity: 'error',
            from: { path: '^src/application/' },
            to: {
                path: '^(?:node_modules/)?(?:react(?:/|$)|zustand(?:/|$)|@tauri-apps/)',
            },
        },
        {
            name: 'adapters-do-not-write-ui-state',
            comment: 'Adapters implement ports and must not reach into presentation stores or components.',
            severity: 'error',
            from: { path: '^src/adapters/' },
            to: { path: '^src/(?:components|hooks|pages|presentation|stores)/' },
        },
        {
            name: 'stores-do-not-import-stores',
            comment: 'Cross-store orchestration moves to application use cases instead of hidden Zustand coupling.',
            severity: 'error',
            from: { path: '^src/stores/' },
            to: { path: '^src/stores/' },
        },
        {
            name: 'services-do-not-import-components',
            comment: 'Infrastructure and legacy services must not depend on presentation modules.',
            severity: 'error',
            from: { path: '^src/services/' },
            to: { path: '^src/(?:components|pages|presentation)/' },
        },
        {
            name: 'main-queue-modules-do-not-import-stores',
            comment: 'Main planning and result projection cross Application ports instead of reaching into Zustand.',
            severity: 'error',
            from: { path: '^src/services/queue/main-queue-(?:adapter|executor|runtime-dependencies)\\.ts$' },
            to: { path: '^src/stores/' },
        },
        {
            name: 'durable-queue-executors-do-not-import-stores',
            comment: 'Durable execution replays snapshots and projects through workflow boundaries, not current UI state.',
            severity: 'error',
            from: {
                path: '^src/services/(?:queue/(?:main|scene)-queue-executor|style-lab/style-lab-queue-executor)\\.ts$',
            },
            to: { path: '^src/stores/' },
        },
        {
            name: 'generation-local-output-does-not-import-r2-services',
            comment: 'Generation and local output execution consume immutable delivery bindings instead of live R2 services.',
            severity: 'error',
            from: {
                path: '^src/(?:application/generation|services/(?:output|queue/(?:main|scene)-queue-executor))(?:/|\\.ts$)',
            },
            to: { path: '^src/services/r2/' },
        },
        {
            name: 'scene-output-transaction-does-not-import-presentation',
            comment: 'Scene output commits project through an Application port instead of importing UI state or notifications.',
            severity: 'error',
            from: { path: '^src/lib/scene-generation/save-scene-result\\.ts$' },
            to: { path: '^src/(?:components|hooks|i18n(?:/|\\.ts$)|pages|presentation|stores)/' },
        },
        {
            name: 'new-presentation-code-does-not-import-tauri',
            comment: 'New UI and store modules must use platform adapters; the exact transitional importer set is checked separately.',
            severity: 'error',
            from: {
                path: '^src/(?:components|hooks|pages|stores)/',
                pathNot: knownPresentationTauriImporters,
            },
            to: {
                path: '^(?:node_modules/)?@tauri-apps/',
                dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg'],
            },
        },
        {
            name: 'not-to-unresolvable',
            comment: 'Every import in the production graph must resolve on a clean checkout.',
            severity: 'error',
            from: {},
            to: { couldNotResolve: true },
        },
    ],
    options: {
        doNotFollow: {
            path: 'node_modules',
        },
        exclude: {
            path: '^(?:legacy|dist|src-tauri)/',
        },
        // TypeScript 7.0 does not expose the compiler API dependency-cruiser
        // needs yet. Its normal parser uses the already-installed SWC fallback,
        // while this alias config replaces the tsconfig-only resolution step.
        webpackConfig: {
            fileName: '.dependency-cruiser-webpack.cjs',
        },
        enhancedResolveOptions: {
            extensions: ['.js', '.jsx', '.ts', '.tsx', '.d.ts', '.json'],
            exportsFields: ['exports'],
            conditionNames: ['import', 'node', 'default', 'types'],
            mainFields: ['module', 'main', 'types', 'typings'],
        },
        reporterOptions: {
            archi: {
                collapsePattern: '^(?:src)/[^/]+|node_modules/(?:@[^/]+/[^/]+|[^/]+)',
            },
        },
    },
}
