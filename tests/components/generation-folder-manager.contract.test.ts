import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('GenerationFolderManagerDialog authority contract', () => {
    it('saves parent and editable fields through one atomic store action', () => {
        const source = readFileSync('src/components/generation-folders/GenerationFolderManagerDialog.tsx', 'utf8')

        expect(source).toContain('await saveFolder(selected.id, parentId, {')
        expect(source).not.toContain('moveFolders([selected.id], parentId)')
        expect(source).not.toContain('updateFolder(selected.id, {')
    })

    it('awaits guarded mutations before selection, close, and success feedback', () => {
        const source = readFileSync('src/components/generation-folders/GenerationFolderManagerDialog.tsx', 'utf8')
        const save = source.indexOf('await saveFolder(selected.id, parentId, {')
        const close = source.indexOf('onOpenChange(false)', save)
        const success = source.indexOf("variant: 'success'", save)

        expect(source).toContain('const id = await addFolder({')
        expect(source).toContain('await copyPrompt(selected.id, transferTargets, commonPrompt)')
        expect(source).toContain('await deleteFolders([selected.id])')
        expect(save).toBeGreaterThan(-1)
        expect(close).toBeGreaterThan(save)
        expect(success).toBeGreaterThan(save)
    })
})
