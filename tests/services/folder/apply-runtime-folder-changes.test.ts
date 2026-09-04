import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authorizeNativeDirectory } = vi.hoisted(() => ({
    authorizeNativeDirectory: vi.fn<(_: string) => Promise<void>>(),
}))
vi.mock('@/platform/native-file-system', () => ({ authorizeNativeDirectory }))

import { authorizeRequiredNativeDirectories } from '@/services/folder/apply-runtime-folder-changes'

describe('runtime Folder directory authorization', () => {
    beforeEach(() => authorizeNativeDirectory.mockReset().mockResolvedValue(undefined))

    it('deduplicates resolved directories and authorizes them sequentially', async () => {
        let active = 0
        let maxActive = 0
        authorizeNativeDirectory.mockImplementation(async () => {
            active += 1
            maxActive = Math.max(maxActive, active)
            await Promise.resolve()
            active -= 1
        })

        await authorizeRequiredNativeDirectories([
            { folderId: 'one', directory: 'D:\\output' },
            { folderId: 'two', directory: 'D:\\output' },
            { folderId: 'three', directory: 'E:\\output' },
        ])

        expect(authorizeNativeDirectory.mock.calls).toEqual([['D:\\output'], ['E:\\output']])
        expect(maxActive).toBe(1)
    })
})
