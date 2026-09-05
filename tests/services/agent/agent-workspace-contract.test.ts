import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createDefaultAssetProfile } from '@/types/asset-profile'
import { normalizeAssetProfile } from '@/services/asset-profile-file'
import { createDefaultPreset } from '@/stores/preset-store'
import {
    createAgentWorkspaceSnapshot,
    parseAgentEditRequest,
    patchAgentPreset,
    validateAgentAssetProfile,
} from '@/services/agent/agent-workspace-contract'

describe('agent workspace contract', () => {
    it.each(['intent_assessment.record', 'assessment.record', 'style_lab.record_preference'])(
        'rejects external human recording through %s', type => {
            expect(() => parseAgentEditRequest({
                schemaVersion: 1, requestId: 'forged-human', baseRevision: 1, status: 'ready',
                action: { type, evaluator: { kind: 'human', actorId: 'local-user' } },
            })).toThrow(/Unsupported agent action/)
        },
    )
    it('grants the desktop bridge exactly the file commands it invokes', () => {
        const capability = JSON.parse(readFileSync(
            new URL('../../../src-tauri/capabilities/default.json', import.meta.url),
            'utf8',
        )) as { permissions: Array<string | Record<string, unknown>> }
        const permissionNames = capability.permissions.filter((permission): permission is string => (
            typeof permission === 'string'
        ))

        // The bridge depends on these granular Tauri v2 commands in addition
        // to the existing AppData scope; broad read/write stream grants do not
        // authorize text-file or metadata operations.
        expect(permissionNames).toEqual(expect.arrayContaining([
            'fs:allow-exists',
            'fs:allow-mkdir',
            'fs:allow-stat',
            'fs:allow-read-text-file',
            'fs:allow-write-text-file',
        ]))
    })

    it('accepts one bounded preset edit and preserves immutable identity', () => {
        const preset = createDefaultPreset()
        const request = parseAgentEditRequest({
            schemaVersion: 1,
            requestId: 'qa-edit-1',
            baseRevision: 7,
            status: 'ready',
            action: {
                type: 'preset.patch',
                presetId: preset.id,
                patch: {
                    basePrompt: 'cinematic portrait, soft daylight',
                    steps: 32,
                    selectedResolution: { label: 'Portrait', width: 832, height: 1_216 },
                },
            },
        })

        expect(request?.action.type).toBe('preset.patch')
        if (request?.action.type !== 'preset.patch') throw new Error('Expected preset.patch')
        const updated = patchAgentPreset(preset, request.action.patch)
        expect(updated.basePrompt).toContain('cinematic portrait')
        expect(updated.steps).toBe(32)
        expect(updated.id).toBe(preset.id)
        expect(updated.createdAt).toBe(preset.createdAt)
        expect(updated.isDefault).toBe(preset.isDefault)
    })

    it('treats draft files as inert and rejects unsupported or unsafe fields', () => {
        expect(parseAgentEditRequest({ status: 'draft' })).toBeNull()
        expect(() => parseAgentEditRequest({
            schemaVersion: 1,
            requestId: 'bad-resolution',
            baseRevision: 1,
            status: 'ready',
            action: {
                type: 'preset.patch',
                presetId: 'default',
                patch: { selectedResolution: { label: 'bad', width: 800, height: 1_217 } },
            },
        })).toThrow(/multiples of 64/i)
        expect(() => validateAgentAssetProfile({
            ...createDefaultAssetProfile(),
            settings: { apiToken: 'must-not-enter-workspace' },
        })).toThrow(/not allowed/i)
    })

    it('creates a credential-free, detached workspace snapshot', () => {
        const preset = createDefaultPreset()
        const sceneDocument = {
            schemaVersion: 1 as const,
            presetId: 'scene-preset-1',
            revision: 7,
            scenes: [],
            updatedAt: '2026-07-26T00:00:00.000Z',
        }
        const folderDocument = {
            schemaVersion: 2 as const,
            workspaceId: 'local',
            revision: 9,
            folders: [{
                id: 'generation-folder-default',
                displayName: 'Default',
                pathSegment: 'Default',
                parentId: null,
                rootDirectory: 'NAI_Blue_Output',
                useAbsolutePath: false,
                commonPrompt: '',
                autoUpload: false,
                r2ProfilePolicy: { mode: 'inherit' as const },
                r2BucketPolicy: { mode: 'inherit' as const },
                r2PrefixPolicy: { mode: 'inherit' as const },
            }],
        }
        const snapshot = createAgentWorkspaceSnapshot({
            revision: 3,
            generatedAt: '2026-07-26T00:00:00.000Z',
            activePresetId: preset.id,
            presets: [preset],
            directories: {
                output: { path: 'NAI_Blue_Output', useAbsolutePath: false },
                scene: { path: 'NAI_Blue_Scene', useAbsolutePath: false },
                styleLab: { path: 'nai-blue-style', useAbsolutePath: false },
                tools: { path: 'nai-blue-tools', useAbsolutePath: false },
                library: { path: 'NAI_Blue_Library', useAbsolutePath: false },
            },
            assetProfile: createDefaultAssetProfile('2026-07-26T00:00:00.000Z'),
            sceneDocuments: [sceneDocument],
            generationFolderDocument: folderDocument,
        })

        preset.basePrompt = 'mutated after snapshot'
        expect(snapshot.editable.presets[0]?.basePrompt).toBe('')
        expect(snapshot.editable.sceneDocuments[0]).toMatchObject({ presetId: 'scene-preset-1', revision: 7 })
        expect(snapshot.editable.sceneDocuments[0]).not.toBe(sceneDocument)
        expect(snapshot.editable.generationFolderDocument).toMatchObject({ workspaceId: 'local', revision: 9 })
        expect(snapshot.editable.generationFolderDocument).not.toBe(folderDocument)
        expect(snapshot.privacy).toMatchObject({
            credentialsIncluded: false,
            imageBytesIncluded: false,
            historyIncluded: false,
        })
        expect(snapshot.capabilities).toEqual({
            'agent-intent-assessment': { available: false, reason: expect.any(String) },
            'bounded-candidate-search': { available: false, reason: expect.any(String) },
        })
        expect(JSON.stringify(snapshot)).not.toMatch(/api.?token|authorization|image.?bytes\s*:/i)

        expect(() => createAgentWorkspaceSnapshot({
            revision: 4,
            activePresetId: preset.id,
            presets: [preset],
            directories: snapshot.editable.directories,
            assetProfile: createDefaultAssetProfile(),
            sceneDocuments: [{
                ...sceneDocument,
                scenes: [{
                    id: 'scene-unsafe',
                    name: 'Unsafe',
                    scenePrompt: '',
                    artifactRefs: [],
                    createdAt: 0,
                    compositionRef: {
                        recipeId: 'scene:direct',
                        extensions: { apiToken: 'must-not-enter-workspace' },
                    },
                }],
            }],
            generationFolderDocument: folderDocument,
        })).toThrow(/not allowed/i)
    })

    it('omits normalized optional fields that JSON serialization cannot represent', () => {
        const normalized = normalizeAssetProfile(createDefaultAssetProfile('2026-07-26T00:00:00.000Z'))

        expect(normalized.output.directory).toBeUndefined()
        expect(() => validateAgentAssetProfile(normalized)).not.toThrow()
        expect(JSON.stringify(validateAgentAssetProfile(normalized))).not.toContain('undefined')
    })

    it('accepts only the documented directory keys', () => {
        const request = parseAgentEditRequest({
            schemaVersion: 1,
            requestId: 'path-edit-1',
            baseRevision: 2,
            status: 'ready',
            action: {
                type: 'paths.patch',
                patch: { output: { path: 'D:\\NAI Blue Output', useAbsolutePath: true } },
            },
        })
        expect(request?.action).toEqual({
            type: 'paths.patch',
            patch: { output: { path: 'D:\\NAI Blue Output', useAbsolutePath: true } },
        })

        expect(() => parseAgentEditRequest({
            schemaVersion: 1,
            requestId: 'path-edit-2',
            baseRevision: 2,
            status: 'ready',
            action: {
                type: 'paths.patch',
                patch: { credentials: { path: 'unsafe', useAbsolutePath: false } },
            },
        })).toThrow(/not supported/i)
    })

    it('requires stable resource IDs and expected revisions for Scene and Folder patches', () => {
        const sceneRequest = parseAgentEditRequest({
            schemaVersion: 1,
            requestId: 'scene-edit-1',
            baseRevision: 5,
            status: 'ready',
            action: {
                type: 'scene.patch',
                presetId: 'preset-1',
                expectedRevision: 3,
                scenePatches: [{
                    sceneId: 'scene-1',
                    patches: [{ op: 'set-parameter', field: 'steps', value: 32 }],
                }],
            },
        })
        expect(sceneRequest?.action).toMatchObject({
            type: 'scene.patch',
            presetId: 'preset-1',
            expectedRevision: 3,
        })

        const folderRequest = parseAgentEditRequest({
            schemaVersion: 1,
            requestId: 'folder-edit-1',
            baseRevision: 5,
            status: 'ready',
            action: {
                type: 'folder.patch',
                workspaceId: 'local',
                expectedRevision: 4,
                patches: [{ folderId: 'folder-1', displayName: 'Renamed' }],
            },
        })
        expect(folderRequest?.action).toEqual({
            type: 'folder.patch',
            workspaceId: 'local',
            expectedRevision: 4,
            patches: [{ folderId: 'folder-1', displayName: 'Renamed' }],
        })

        expect(() => parseAgentEditRequest({
            schemaVersion: 1,
            requestId: 'scene-edit-missing-revision',
            baseRevision: 5,
            status: 'ready',
            action: {
                type: 'scene.patch',
                presetId: 'preset-1',
                scenePatches: [{ sceneId: 'scene-1', patches: [{ op: 'inherit-parameter', field: 'steps' }] }],
            },
        })).toThrow(/expectedRevision/i)
        expect(() => parseAgentEditRequest({
            schemaVersion: 1,
            requestId: 'folder-edit-unknown-field',
            baseRevision: 5,
            status: 'ready',
            action: {
                type: 'folder.patch',
                workspaceId: 'local',
                expectedRevision: 4,
                patches: [{ folderId: 'folder-1', physicalMove: true }],
            },
        })).toThrow(/not supported/i)
    })
})
