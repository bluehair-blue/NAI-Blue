import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const fsCapture = vi.hoisted(() => ({
    calls: [] as Array<{ operation: string; path?: string; to?: string; options?: unknown }>,
    existing: new Set<string>(),
    files: new Map<string, Uint8Array>(),
    entries: [] as Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymlink: boolean }>,
}))

const nativeScopeCapture = vi.hoisted(() => ({
    paths: [] as string[],
    commits: [] as Array<{ temporaryPath: string; finalPath: string }>,
}))

vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (command: string, args?: { path?: string; temporaryPath?: string; finalPath?: string }) => {
        if (command === 'authorize_native_directory' && args?.path) nativeScopeCapture.paths.push(args.path)
        if (command === 'commit_native_sibling_if_absent'
            && args?.temporaryPath !== undefined
            && args.finalPath !== undefined) {
            nativeScopeCapture.commits.push({
                temporaryPath: args.temporaryPath,
                finalPath: args.finalPath,
            })
            return 'committed'
        }
    },
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
    BaseDirectory: { AppData: 1, Picture: 2 },
    exists: async (path: string, options?: unknown) => {
        fsCapture.calls.push({ operation: 'exists', path, options })
        return fsCapture.existing.has(path) || fsCapture.files.has(path)
    },
    mkdir: async (path: string, options?: unknown) => {
        fsCapture.calls.push({ operation: 'mkdir', path, options })
        fsCapture.existing.add(path)
    },
    readDir: async (path: string, options?: unknown) => {
        fsCapture.calls.push({ operation: 'readDir', path, options })
        return fsCapture.entries
    },
    readFile: async (path: string, options?: unknown) => {
        fsCapture.calls.push({ operation: 'readFile', path, options })
        const bytes = fsCapture.files.get(path)
        if (bytes === undefined) throw new Error(`missing ${path}`)
        return new Uint8Array(bytes)
    },
    remove: async (path: string, options?: unknown) => {
        fsCapture.calls.push({ operation: 'remove', path, options })
        fsCapture.files.delete(path)
        fsCapture.existing.delete(path)
    },
    rename: async (path: string, to: string, options?: unknown) => {
        fsCapture.calls.push({ operation: 'rename', path, to, options })
        const bytes = fsCapture.files.get(path)
        if (bytes !== undefined) {
            fsCapture.files.set(to, bytes)
            fsCapture.files.delete(path)
        }
    },
    writeFile: async (path: string, bytes: Uint8Array, options?: unknown) => {
        fsCapture.calls.push({ operation: 'writeFile', path, options })
        fsCapture.files.set(path, new Uint8Array(bytes))
    },
}))

vi.mock('@tauri-apps/api/path', () => ({
    appDataDir: async () => 'C:/Synthetic/AppData',
    pictureDir: async () => 'C:/Synthetic/Pictures',
    join: async (...parts: string[]) => parts.join('/').split('\\').join('/'),
}))

vi.mock('@/platform/runtime', () => ({ isMobileRuntime: false }))

import {
    childOutputRef,
    directoryIdentityForResolvedOutputDirectory,
} from '@/services/output/platform-adapter'
import { createRuntimeCapabilities } from '@/platform/capabilities'
import { InMemoryPlatformTokenRegistry } from '@/platform/portable-resources'
import {
    AppScopedOutputPlatformAdapter,
    DesktopOutputPlatformAdapter,
    UnresolvedOutputPathError,
} from '@/services/output/tauri-output-adapter'

beforeEach(() => {
    fsCapture.calls.length = 0
    fsCapture.existing.clear()
    fsCapture.files.clear()
    fsCapture.entries.length = 0
    nativeScopeCapture.paths.length = 0
    nativeScopeCapture.commits.length = 0
})

describe('Tauri output platform adapters', () => {
    it('fingerprints resolved directories with runtime filesystem semantics', () => {
        const directory = (path: string) => ({
            path, displayPath: path, capabilityFallbackUsed: false,
        })

        expect(directoryIdentityForResolvedOutputDirectory(directory('C:\\Output\\Portraits'), 'windows'))
            .toBe(directoryIdentityForResolvedOutputDirectory(directory('c:/output/portraits'), 'windows'))
        expect(directoryIdentityForResolvedOutputDirectory(directory('/data/Output'), 'linux'))
            .not.toBe(directoryIdentityForResolvedOutputDirectory(directory('/data/output'), 'linux'))
        expect(directoryIdentityForResolvedOutputDirectory(directory('/Users/CAFÉ'), 'macos'))
            .toBe(directoryIdentityForResolvedOutputDirectory(directory('/users/cafe\u0301'), 'macos'))
    })

    it('grants atomic temp files only inside the existing output roots on Unix-like runtimes', async () => {
        const capabilityPaths = async (relativePath: string): Promise<string[]> => {
            const parsed = JSON.parse(await readFile(resolve(process.cwd(), relativePath), 'utf8')) as {
                permissions: Array<string | { identifier: string, allow?: Array<{ path: string }> }>
            }
            return parsed.permissions
                .filter((permission): permission is { identifier: string, allow?: Array<{ path: string }> } => (
                    typeof permission === 'object' && permission.identifier === 'fs:scope'
                ))
                .flatMap(permission => permission.allow ?? [])
                .map(entry => entry.path)
        }

        const [desktop, mobile, tauriConfig, cargoManifest, nativeEntry] = await Promise.all([
            capabilityPaths('src-tauri/capabilities/default.json'),
            capabilityPaths('src-tauri/capabilities/mobile.json'),
            readFile(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'),
            readFile(resolve(process.cwd(), 'src-tauri/Cargo.toml'), 'utf8'),
            readFile(resolve(process.cwd(), 'src-tauri/src/lib.rs'), 'utf8'),
        ])

        // OutputWriter journals and commit siblings depend on a literal leading dot;
        // keeping explicit scoped patterns avoids globally exposing unrelated hidden files.
        expect(desktop).toEqual(expect.arrayContaining([
            '$PICTURE/**/.*', '$APPDATA/**/.*', '$LOCALAPPDATA/**/.*',
        ]))
        expect(mobile).toContain('$APPDATA/**/.*')
        expect(tauriConfig).not.toContain('requireLiteralLeadingDot')
        expect(cargoManifest).toContain('tauri-plugin-persisted-scope')
        expect(nativeEntry.indexOf('.plugin(tauri_plugin_fs::init())'))
            .toBeLessThan(nativeEntry.indexOf('.plugin(tauri_plugin_persisted_scope::init())'))
    })

    it('uses Pictures-relative paths on desktop and preserves explicit absolute paths', async () => {
        const adapter = new DesktopOutputPlatformAdapter()
        const relative = await adapter.resolveDirectory({
            directory: 'NAI Blue/Output',
            useAbsolutePath: false,
            workflowDefaultDirectory: 'NAI_Blue_Output',
        })
        const absolute = await adapter.resolveDirectory({
            directory: 'D:\\Exports\\NAI Blue',
            useAbsolutePath: true,
            workflowDefaultDirectory: 'NAI_Blue_Output',
        })

        expect(relative).toEqual({
            path: 'NAI Blue/Output',
            displayPath: 'C:/Synthetic/Pictures/NAI Blue/Output',
            baseDir: 2,
            capabilityFallbackUsed: false,
        })
        expect(absolute).toEqual({
            path: 'D:\\Exports\\NAI Blue',
            displayPath: 'D:\\Exports\\NAI Blue',
            capabilityFallbackUsed: false,
        })
        expect(nativeScopeCapture.paths).toEqual(['D:\\Exports\\NAI Blue'])
    })

    it('falls back from an Android absolute path to AppData without leaking the raw path', async () => {
        const adapter = new AppScopedOutputPlatformAdapter()
        const directory = await adapter.resolveDirectory({
            directory: 'D:\\Users\\Example\\Pictures',
            useAbsolutePath: true,
            capabilityFallbackDirectory: 'NAI_Blue_Output/mobile',
            workflowDefaultDirectory: 'NAI_Blue_Output',
        })
        const image = childOutputRef(directory, 'result.png')
        await adapter.ensureDirectory(directory)
        await adapter.writeFile(image, new Uint8Array([1, 2, 3]))

        expect(directory).toEqual(expect.objectContaining({
            path: 'NAI_Blue_Output/mobile',
            displayPath: 'C:/Synthetic/AppData/NAI_Blue_Output/mobile',
            baseDir: 1,
            capabilityFallbackUsed: true,
            fallbackReason: expect.any(String),
            fallbackAlternative: expect.any(String),
        }))
        expect(JSON.stringify(fsCapture.calls)).not.toContain('D:\\\\Users')
        expect(fsCapture.calls).toContainEqual({
            operation: 'writeFile',
            path: 'NAI_Blue_Output/mobile/result.png',
            options: { baseDir: 1 },
        })
    })

    it('keeps recovery journals in AppData for both runtime adapters', async () => {
        const desktop = new DesktopOutputPlatformAdapter()
        await desktop.writeJournal('txn-one', new Uint8Array([1]))

        expect(fsCapture.calls).toContainEqual({
            operation: 'writeFile',
            path: 'nai-blue/output-journal/.txn-one.tmp',
            options: { baseDir: 1 },
        })
        expect(fsCapture.calls).toContainEqual({
            operation: 'rename',
            path: 'nai-blue/output-journal/.txn-one.tmp',
            to: 'nai-blue/output-journal/txn-one.json',
            options: { oldPathBaseDir: 1, newPathBaseDir: 1 },
        })

        fsCapture.existing.add('nai-blue/output-journal')
        fsCapture.entries.push(
            { name: 'txn-one.json', isFile: true, isDirectory: false, isSymlink: false },
            { name: 'txn-z.json', isFile: true, isDirectory: false, isSymlink: false },
            { name: '.txn-z.tmp', isFile: true, isDirectory: false, isSymlink: false },
            { name: 'txn-a.json', isFile: true, isDirectory: false, isSymlink: false },
        )
        await expect(new AppScopedOutputPlatformAdapter().listJournalIds())
            .resolves.toEqual(['txn-a', 'txn-one', 'txn-z'])
    })

    it('reads only shallow directory entry names for batch planning', async () => {
        fsCapture.existing.add('output')
        fsCapture.entries.push(
            { name: 'result.png', isFile: true, isDirectory: false, isSymlink: false },
            { name: '._nai-blue-private', isFile: false, isDirectory: true, isSymlink: false },
        )

        await expect(new DesktopOutputPlatformAdapter().readDirectoryEntries({
            path: 'output', displayPath: 'output', baseDir: 2,
        })).resolves.toEqual(['result.png', '._nai-blue-private'])
        expect(fsCapture.calls.filter(call => call.operation === 'readDir')).toHaveLength(1)
        expect(fsCapture.calls.some(call => call.operation === 'mkdir')).toBe(false)
    })

    it('materializes scoped sibling paths for native no-replace publication', async () => {
        const adapter = new DesktopOutputPlatformAdapter(createRuntimeCapabilities('windows'))

        await expect(adapter.commitSiblingIfAbsent(
            { path: 'output/.nai-blue-txn-a-image.tmp', displayPath: 'temp', baseDir: 1 },
            { path: 'output/result.png', displayPath: 'final', baseDir: 1 },
        )).resolves.toEqual({ status: 'committed' })

        expect(adapter.capabilities.outputReservationGuarantee).toBe('atomic-no-replace')
        expect(nativeScopeCapture.commits).toEqual([{
            temporaryPath: 'C:/Synthetic/AppData/output/.nai-blue-txn-a-image.tmp',
            finalPath: 'C:/Synthetic/AppData/output/result.png',
        }])
    })

    it('blocks an unresolved desktop portable destination on Android instead of falling back', async () => {
        const registry = new InMemoryPlatformTokenRegistry()
        registry.register({
            logicalId: 'output:selected',
            platform: 'windows',
            kind: 'directory',
            opaqueToken: 'D:\\Exports',
            displayPath: 'Exports',
        })
        const adapter = new AppScopedOutputPlatformAdapter(
            createRuntimeCapabilities('android'),
            registry,
        )

        await expect(adapter.resolveDirectory({
            portableDirectory: { kind: 'bookmark', bookmarkId: 'output:selected', segments: [] },
            workflowDefaultDirectory: 'NAI_Blue_Output',
        })).rejects.toBeInstanceOf(UnresolvedOutputPathError)
        expect(JSON.stringify(fsCapture.calls)).not.toContain('D:\\Exports')
    })

    it('resolves Android app-data portable output without an absolute path', async () => {
        const adapter = new AppScopedOutputPlatformAdapter(createRuntimeCapabilities('android'))
        await expect(adapter.resolveDirectory({
            portableDirectory: { kind: 'standard', root: 'app-data', segments: ['NAI Blue', 'Output'] },
            workflowDefaultDirectory: 'NAI_Blue_Output',
        })).resolves.toEqual({
            path: 'NAI Blue/Output',
            displayPath: 'C:/Synthetic/AppData/NAI Blue/Output',
            baseDir: 1,
            capabilityFallbackUsed: false,
        })
    })
})
