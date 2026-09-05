import { isR2BucketName, normalizeR2Prefix, type R2DestinationProvenance } from '@/domain/r2/types'

export const DEFAULT_GENERATION_FOLDER_ID = 'generation-folder-default'
export const MAX_GENERATION_FOLDER_NAME_LENGTH = 96
/** Rotation output gets one stable parent without changing explicit flat destinations. */
export const CHARACTER_SCENES_DIRECTORY_NAME = 'Character_Scenes'

export interface GenerationFolderR2Policy {
    readonly autoUpload: boolean
    /** null inherits the closest parent override, then the saved R2 profile. */
    readonly bucket: string | null
    /** null derives from the closest parent prefix, then the saved R2 profile. */
    readonly prefix: string | null
}

export interface GenerationFolder {
    readonly schemaVersion: 1
    readonly id: string
    readonly name: string
    readonly parentId: string | null
    /** Only a root folder owns the local directory authority. */
    readonly rootDirectory: string | null
    readonly useAbsolutePath: boolean
    readonly commonPrompt: string
    readonly r2: GenerationFolderR2Policy
    readonly createdAt: string
    readonly updatedAt: string
}

export interface ResolvedGenerationFolder {
    readonly id: string
    readonly path: string
    readonly directory: string
    readonly useAbsolutePath: boolean
    readonly commonPrompt: string
    readonly r2: {
        readonly autoUpload: boolean
        readonly profileId?: string | null
        readonly bucket: string | null
        readonly prefix: string
        readonly prefixSource: 'folder' | 'ancestor' | 'profile'
        readonly provenance?: R2DestinationProvenance
    }
}

export interface GenerationFolderSelection {
    readonly folder: ResolvedGenerationFolder
    readonly r2Ready: boolean
}

/** Legacy Zustand fields needed to reproduce V1 folder hydration and resolution. */
export interface GenerationFolderV1Projection {
    readonly savePath: string
    readonly useAbsolutePath: boolean
    readonly generationFolders: GenerationFolder[]
    readonly activeGenerationFolderId: string
}

export interface GenerationFolderDefaults {
    readonly directory: string
    readonly useAbsolutePath: boolean
    readonly r2ProfileId?: string | null
    readonly r2Bucket?: string | null
    readonly r2Prefix?: string | null
}

export type InheritedValue<T> =
    | { readonly mode: 'inherit' }
    | { readonly mode: 'set'; readonly value: T }
    | { readonly mode: 'clear' }

/** V2 separates mutable labels from the segments that own physical destinations. */
export interface GenerationFolderV2 {
    readonly id: string
    readonly displayName: string
    readonly pathSegment: string
    readonly parentId: string | null
    readonly rootDirectory: string | null
    readonly useAbsolutePath: boolean
    readonly commonPrompt: string
    readonly autoUpload: boolean
    readonly r2ProfilePolicy: InheritedValue<string>
    readonly r2BucketPolicy: InheritedValue<string>
    readonly r2PrefixPolicy: InheritedValue<string>
}

export interface GenerationFolderDocument {
    readonly schemaVersion: 2
    readonly workspaceId: string
    readonly revision: number
    readonly folders: readonly GenerationFolderV2[]
}

export type GenerationFolderV2Defaults = GenerationFolderDefaults

export interface ResolvedGenerationFolderV2 {
    readonly id: string
    readonly displayPath: string
    readonly logicalPath: string
    readonly directory: string
    readonly useAbsolutePath: boolean
    readonly commonPrompt: string
    readonly autoUpload: boolean
    readonly r2: {
        readonly enabled: boolean
        readonly profileId: string | null
        readonly bucket: string | null
        readonly prefix: string
    }
    readonly sources: {
        readonly rootDirectory: string
        readonly useAbsolutePath: string
        readonly commonPrompt: string
        readonly autoUpload: string
        readonly r2Profile: string | null
        readonly r2Bucket: string | null
        readonly r2Prefix: string | null
    }
    readonly provenance: {
        readonly r2Profile: 'folder' | 'ancestor' | 'workspace' | 'cleared'
        readonly r2Bucket: 'folder' | 'ancestor' | 'workspace' | 'cleared'
        readonly r2Prefix: 'folder' | 'ancestor' | 'workspace' | 'cleared'
    }
}

function boundedText(value: string, maximum: number): boolean {
    return value.length > 0
        && value.length <= maximum
        && value.trim() === value
        && !/[\u0000-\u001f\u007f]/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const allowed = new Set(keys)
    return Object.keys(value).every(key => allowed.has(key))
}

const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

export function isGenerationFolderPathSegment(value: unknown): value is string {
    return typeof value === 'string'
        && isGenerationFolderName(value)
        && !/[. ]$/u.test(value)
        && !WINDOWS_RESERVED_SEGMENT.test(value)
}

function isInheritedValue<T>(
    value: unknown,
    isValue: (candidate: unknown) => candidate is T,
): value is InheritedValue<T> {
    if (!isRecord(value)) return false
    if (value.mode === 'inherit' || value.mode === 'clear') {
        return hasOnlyKeys(value, ['mode'])
    }
    return value.mode === 'set'
        && hasOnlyKeys(value, ['mode', 'value'])
        && isValue(value.value)
}

function isR2Prefix(value: unknown): value is string {
    if (typeof value !== 'string') return false
    try {
        return normalizeR2Prefix(value) !== null
    } catch {
        return false
    }
}

export function isGenerationFolderV2(value: unknown): value is GenerationFolderV2 {
    if (!isRecord(value) || !hasOnlyKeys(value, [
        'id', 'displayName', 'pathSegment', 'parentId', 'rootDirectory', 'useAbsolutePath',
        'commonPrompt', 'autoUpload', 'r2ProfilePolicy', 'r2BucketPolicy', 'r2PrefixPolicy',
    ])) return false
    return typeof value.id === 'string'
        && boundedText(value.id, 128)
        && typeof value.displayName === 'string'
        && boundedText(value.displayName, MAX_GENERATION_FOLDER_NAME_LENGTH)
        && isGenerationFolderPathSegment(value.pathSegment)
        && (value.parentId === null || (typeof value.parentId === 'string' && boundedText(value.parentId, 128)))
        && (value.rootDirectory === null || (typeof value.rootDirectory === 'string' && value.rootDirectory.trim().length > 0))
        && typeof value.useAbsolutePath === 'boolean'
        && typeof value.commonPrompt === 'string'
        && value.commonPrompt.length <= 20_000
        && typeof value.autoUpload === 'boolean'
        && isInheritedValue(value.r2ProfilePolicy, (candidate): candidate is string => (
            typeof candidate === 'string' && boundedText(candidate, 128)
        ))
        && isInheritedValue(value.r2BucketPolicy, isR2BucketName)
        && isInheritedValue(value.r2PrefixPolicy, isR2Prefix)
}

/** Validates both the persisted shape and the complete tree; malformed authority fails closed. */
export function isGenerationFolderDocument(value: unknown): value is GenerationFolderDocument {
    if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'workspaceId', 'revision', 'folders'])
        || value.schemaVersion !== 2
        || typeof value.workspaceId !== 'string'
        || !boundedText(value.workspaceId, 128)
        || typeof value.revision !== 'number'
        || !Number.isSafeInteger(value.revision)
        || value.revision < 1
        || !Array.isArray(value.folders)
        || !value.folders.every(isGenerationFolderV2)) return false

    const folders = value.folders as GenerationFolderV2[]
    const byId = new Map(folders.map(folder => [folder.id, folder]))
    if (byId.size !== folders.length) return false
    const siblings = new Set<string>()
    for (const folder of folders) {
        if (folder.parentId === null) {
            if (folder.rootDirectory === null) return false
        } else {
            if (!byId.has(folder.parentId) || folder.rootDirectory !== null || folder.useAbsolutePath) return false
        }
        const siblingKey = `${folder.parentId ?? '<root>'}\u0000${folder.pathSegment.toLocaleLowerCase('en-US')}`
        if (siblings.has(siblingKey)) return false
        siblings.add(siblingKey)
        const visited = new Set<string>()
        let current: GenerationFolderV2 | undefined = folder
        while (current !== undefined) {
            if (visited.has(current.id)) return false
            visited.add(current.id)
            current = current.parentId === null ? undefined : byId.get(current.parentId)
        }
    }
    return true
}

export function isGenerationFolderName(value: unknown): value is string {
    return typeof value === 'string'
        && boundedText(value, MAX_GENERATION_FOLDER_NAME_LENGTH)
        && value !== '.'
        && value !== '..'
        && !/[<>:"/\\|?*]/u.test(value)
}

export function createDefaultGenerationFolder(
    directory = 'NAI_Blue_Output',
    useAbsolutePath = false,
    now = new Date().toISOString(),
): GenerationFolder {
    return {
        schemaVersion: 1,
        id: DEFAULT_GENERATION_FOLDER_ID,
        name: '기본 출력',
        parentId: null,
        rootDirectory: directory.trim() || 'NAI_Blue_Output',
        useAbsolutePath,
        commonPrompt: '',
        r2: { autoUpload: false, bucket: null, prefix: null },
        createdAt: now,
        updatedAt: now,
    }
}

/**
 * Projects unknown V1 settings through the same legacy save-path authority used
 * by Zustand hydration, without introducing a new persisted document or write.
 */
export function normalizeGenerationFolderV1Projection(value: unknown): GenerationFolderV1Projection {
    const persisted = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
    const savePath = typeof persisted.savePath === 'string' && persisted.savePath.trim()
        ? persisted.savePath
        : 'NAI_Blue_Output'
    const useAbsolutePath = typeof persisted.useAbsolutePath === 'boolean'
        ? persisted.useAbsolutePath
        : false
    const validFolders = Array.isArray(persisted.generationFolders)
        ? persisted.generationFolders.filter(isGenerationFolder)
        : []
    const hasDefaultFolder = validFolders.some(folder => folder.id === DEFAULT_GENERATION_FOLDER_ID)
    const generationFolders = (hasDefaultFolder
        ? validFolders
        : [createDefaultGenerationFolder(savePath, useAbsolutePath), ...validFolders])
        .map(folder => folder.id === DEFAULT_GENERATION_FOLDER_ID
            ? { ...folder, rootDirectory: savePath, useAbsolutePath }
            : folder)
    const activeGenerationFolderId = typeof persisted.activeGenerationFolderId === 'string'
        && generationFolders.some(folder => folder.id === persisted.activeGenerationFolderId)
        ? persisted.activeGenerationFolderId
        : DEFAULT_GENERATION_FOLDER_ID

    return { savePath, useAbsolutePath, generationFolders, activeGenerationFolderId }
}

function folderChain(folders: readonly GenerationFolder[], folderId: string): GenerationFolder[] | null {
    const byId = new Map(folders.map(folder => [folder.id, folder]))
    const visited = new Set<string>()
    const chain: GenerationFolder[] = []
    let current = byId.get(folderId)
    while (current) {
        if (visited.has(current.id)) return null
        visited.add(current.id)
        chain.unshift(current)
        current = current.parentId === null ? undefined : byId.get(current.parentId)
        if (chain[0]?.parentId !== null && current === undefined) return null
    }
    return chain.length === 0 ? null : chain
}

function appendLocalPath(root: string, segments: readonly string[]): string {
    const base = root.replace(/[\\/]+$/u, '')
    const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
    return [base, ...segments].filter(Boolean).join(separator)
}

function joinR2Prefix(...parts: Array<string | null | undefined>): string {
    return parts
        .flatMap(part => normalizeR2Prefix(part)?.split('/') ?? [])
        .join('/')
}

export function resolveGenerationFolder(
    folders: readonly GenerationFolder[],
    folderId: string | null | undefined,
    defaults: GenerationFolderDefaults,
): ResolvedGenerationFolder | null {
    if (!folderId) return null
    const chain = folderChain(folders, folderId)
    if (chain === null) return null
    const selected = chain[chain.length - 1]
    const root = chain[0]
    const rootDirectory = root.rootDirectory?.trim() || defaults.directory.trim() || 'NAI_Blue_Output'
    const childNames = chain.slice(1).map(folder => folder.name)

    let bucket = defaults.r2Bucket?.trim() || null
    for (const folder of chain) {
        if (folder.r2.bucket?.trim()) bucket = folder.r2.bucket.trim()
    }

    let explicitPrefixIndex = -1
    for (let index = 0; index < chain.length; index += 1) {
        if (normalizeR2Prefix(chain[index].r2.prefix) !== null) explicitPrefixIndex = index
    }
    const implicitPrefixNames = chain
        .filter(folder => folder.id !== DEFAULT_GENERATION_FOLDER_ID)
        .map(folder => folder.name)
    const prefix = explicitPrefixIndex >= 0
        ? joinR2Prefix(chain[explicitPrefixIndex].r2.prefix, ...chain.slice(explicitPrefixIndex + 1).map(folder => folder.name))
        : joinR2Prefix(defaults.r2Prefix, ...implicitPrefixNames)

    return {
        id: selected.id,
        path: chain.map(folder => folder.name).join(' / '),
        directory: appendLocalPath(rootDirectory, childNames),
        useAbsolutePath: root.useAbsolutePath,
        commonPrompt: selected.commonPrompt,
        r2: {
            autoUpload: selected.r2.autoUpload,
            bucket,
            prefix,
            prefixSource: explicitPrefixIndex === chain.length - 1
                ? 'folder'
                : explicitPrefixIndex >= 0
                    ? 'ancestor'
                    : 'profile',
        },
    }
}

export function generationFolderDescendantIds(
    folders: readonly GenerationFolder[],
    folderId: string,
): string[] {
    const descendants = new Set<string>()
    let changed = true
    while (changed) {
        changed = false
        for (const folder of folders) {
            if (folder.parentId === folderId || (folder.parentId !== null && descendants.has(folder.parentId))) {
                if (!descendants.has(folder.id)) {
                    descendants.add(folder.id)
                    changed = true
                }
            }
        }
    }
    return [...descendants]
}

export function isGenerationFolder(value: unknown): value is GenerationFolder {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const folder = value as Partial<GenerationFolder>
    if (folder.schemaVersion !== 1
        || typeof folder.id !== 'string'
        || !boundedText(folder.id, 128)
        || !isGenerationFolderName(folder.name)
        || (folder.parentId !== null && typeof folder.parentId !== 'string')
        || (folder.rootDirectory !== null && typeof folder.rootDirectory !== 'string')
        || typeof folder.useAbsolutePath !== 'boolean'
        || typeof folder.commonPrompt !== 'string'
        || folder.commonPrompt.length > 20_000
        || typeof folder.r2 !== 'object'
        || folder.r2 === null
        || typeof folder.r2.autoUpload !== 'boolean'
        || (folder.r2.bucket !== null && !isR2BucketName(folder.r2.bucket))
        || typeof folder.createdAt !== 'string'
        || typeof folder.updatedAt !== 'string') return false
    try {
        normalizeR2Prefix(folder.r2.prefix)
        return folder.r2.prefix === null || typeof folder.r2.prefix === 'string'
    } catch {
        return false
    }
}

/** Pure forward migration. The caller retains the untouched V1 preimage for rollback. */
export function migrateGenerationFolderV1Projection(
    workspaceId: string,
    projection: GenerationFolderV1Projection,
): GenerationFolderDocument {
    const folders = projection.generationFolders.map(folder => {
        const prefix = normalizeR2Prefix(folder.r2.prefix)
        return {
            id: folder.id,
            displayName: folder.name,
            pathSegment: folder.name,
            parentId: folder.parentId,
            rootDirectory: folder.parentId === null ? (folder.rootDirectory?.trim() || projection.savePath) : null,
            useAbsolutePath: folder.parentId === null ? folder.useAbsolutePath : false,
            commonPrompt: folder.commonPrompt,
            autoUpload: folder.r2.autoUpload,
            r2ProfilePolicy: { mode: 'inherit' } as const,
            r2BucketPolicy: folder.r2.bucket === null
                ? { mode: 'inherit' } as const
                : { mode: 'set', value: folder.r2.bucket } as const,
            r2PrefixPolicy: prefix === null
                ? { mode: 'inherit' } as const
                : { mode: 'set', value: prefix } as const,
        }
    })
    const document: GenerationFolderDocument = {
        schemaVersion: 2,
        workspaceId,
        revision: 1,
        folders,
    }
    if (!isGenerationFolderDocument(document)) {
        throw new TypeError('Generation folder V1 projection cannot be migrated safely')
    }
    return document
}

function folderChainV2(
    folders: readonly GenerationFolderV2[],
    folderId: string,
): GenerationFolderV2[] | null {
    const byId = new Map(folders.map(folder => [folder.id, folder]))
    const chain: GenerationFolderV2[] = []
    const visited = new Set<string>()
    let current = byId.get(folderId)
    while (current !== undefined) {
        if (visited.has(current.id)) return null
        visited.add(current.id)
        chain.unshift(current)
        if (current.parentId === null) break
        current = byId.get(current.parentId)
        if (current === undefined) return null
    }
    return chain.length > 0 && chain[0].parentId === null ? chain : null
}

interface PolicyResolution<T> {
    readonly value: T | null
    readonly sourceId: string | null
    readonly sourceIndex: number
    readonly mode: 'set' | 'clear' | 'workspace'
}

function resolvePolicy<T>(
    chain: readonly GenerationFolderV2[],
    getPolicy: (folder: GenerationFolderV2) => InheritedValue<T>,
    workspaceValue: T | null,
): PolicyResolution<T> {
    for (let index = chain.length - 1; index >= 0; index -= 1) {
        const policy = getPolicy(chain[index])
        if (policy.mode === 'set') return { value: policy.value, sourceId: chain[index].id, sourceIndex: index, mode: 'set' }
        if (policy.mode === 'clear') return { value: null, sourceId: chain[index].id, sourceIndex: index, mode: 'clear' }
    }
    return { value: workspaceValue, sourceId: null, sourceIndex: -1, mode: 'workspace' }
}

function resolveProfilePolicy(
    chain: readonly GenerationFolderV2[],
    workspaceValue: string | null,
): PolicyResolution<string> {
    let clearedIndex = -1
    for (let index = 0; index < chain.length; index += 1) {
        if (chain[index].r2ProfilePolicy.mode === 'clear') clearedIndex = index
    }
    return clearedIndex >= 0
        ? { value: null, sourceId: chain[clearedIndex].id, sourceIndex: clearedIndex, mode: 'clear' }
        : resolvePolicy(chain, folder => folder.r2ProfilePolicy, workspaceValue)
}

function policyProvenance(
    resolution: PolicyResolution<unknown>,
    selectedIndex: number,
): 'folder' | 'ancestor' | 'workspace' | 'cleared' {
    if (resolution.mode === 'workspace') return 'workspace'
    if (resolution.mode === 'clear') return 'cleared'
    return resolution.sourceIndex === selectedIndex ? 'folder' : 'ancestor'
}

/** Resolves a validated V2 tree without filesystem or network side effects. */
export function resolveGenerationFolderV2(
    document: GenerationFolderDocument,
    folderId: string | null | undefined,
    defaults: GenerationFolderV2Defaults,
): ResolvedGenerationFolderV2 | null {
    if (!folderId || !isGenerationFolderDocument(document)) return null
    const chain = folderChainV2(document.folders, folderId)
    if (chain === null) return null
    const selected = chain[chain.length - 1]
    const root = chain[0]
    const localSegments = chain.slice(1).map(folder => folder.pathSegment)
    const profile = resolveProfilePolicy(chain, defaults.r2ProfileId?.trim() || null)
    const bucket = resolvePolicy(chain, folder => folder.r2BucketPolicy, defaults.r2Bucket?.trim() || null)
    const prefix = resolvePolicy(chain, folder => folder.r2PrefixPolicy, normalizeR2Prefix(defaults.r2Prefix))
    const prefixSegments = prefix.sourceIndex < 0
        ? chain.filter(folder => folder.id !== DEFAULT_GENERATION_FOLDER_ID).map(folder => folder.pathSegment)
        : chain.slice(prefix.sourceIndex + 1).map(folder => folder.pathSegment)
    const prefixBase = prefix.mode === 'clear' ? null : prefix.value
    const rootDirectory = root.rootDirectory?.trim() || defaults.directory.trim() || 'NAI_Blue_Output'

    return {
        id: selected.id,
        displayPath: chain.map(folder => folder.displayName).join(' / '),
        logicalPath: chain.map(folder => folder.pathSegment).join('/'),
        directory: appendLocalPath(rootDirectory, localSegments),
        useAbsolutePath: root.useAbsolutePath,
        commonPrompt: selected.commonPrompt,
        autoUpload: selected.autoUpload,
        r2: {
            enabled: profile.mode !== 'clear',
            profileId: profile.value,
            bucket: bucket.value,
            prefix: joinR2Prefix(prefixBase, ...prefixSegments),
        },
        sources: {
            rootDirectory: root.id,
            useAbsolutePath: root.id,
            commonPrompt: selected.id,
            autoUpload: selected.id,
            r2Profile: profile.sourceId,
            r2Bucket: bucket.sourceId,
            r2Prefix: prefix.sourceId,
        },
        provenance: {
            r2Profile: policyProvenance(profile, chain.length - 1),
            r2Bucket: policyProvenance(bucket, chain.length - 1),
            r2Prefix: policyProvenance(prefix, chain.length - 1),
        },
    }
}

export interface GenerationFolderSelectorCandidate {
    readonly id: string
    readonly path: string
}

export type GenerationFolderSelectorResult =
    | { readonly status: 'FOUND'; readonly folder: GenerationFolderV2; readonly path: string }
    | { readonly status: 'NOT_FOUND' }
    | { readonly status: 'AMBIGUOUS'; readonly candidates: readonly GenerationFolderSelectorCandidate[] }

/** Stable ID wins; labels and logical paths must resolve uniquely. */
export function selectGenerationFolderV2(
    document: GenerationFolderDocument,
    selector: string,
): GenerationFolderSelectorResult {
    if (!isGenerationFolderDocument(document) || selector.length === 0) return { status: 'NOT_FOUND' }
    const exact = document.folders.find(folder => folder.id === selector)
    const candidate = (folder: GenerationFolderV2): GenerationFolderSelectorCandidate => ({
        id: folder.id,
        path: folderChainV2(document.folders, folder.id)?.map(item => item.pathSegment).join('/') ?? '',
    })
    if (exact !== undefined) return { status: 'FOUND', folder: structuredClone(exact), path: candidate(exact).path }
    const normalized = selector.replace(/\s*\/\s*/gu, '/')
    const matches = document.folders.filter(folder => {
        const chain = folderChainV2(document.folders, folder.id)
        return folder.displayName === selector
            || chain?.map(item => item.displayName).join('/') === normalized
            || chain?.map(item => item.pathSegment).join('/') === normalized
    })
    if (matches.length === 0) return { status: 'NOT_FOUND' }
    if (matches.length > 1) return {
        status: 'AMBIGUOUS',
        candidates: matches.map(candidate).sort((left, right) => left.id.localeCompare(right.id)),
    }
    return { status: 'FOUND', folder: structuredClone(matches[0]), path: candidate(matches[0]).path }
}
