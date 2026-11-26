import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('GenerationFolderManagerDialog authority contract', () => {
    it('saves parent and editable fields through one atomic store action', () => {
        const formSource = readFileSync('src/components/generation-folders/GenerationFolderForm.tsx', 'utf8')
        const dialogSource = readFileSync('src/components/generation-folders/GenerationFolderManagerDialog.tsx', 'utf8')

        expect(formSource).toContain('await saveFolder(selected.id, parentId, {')
        expect(formSource).not.toContain('moveFolders([selected.id], parentId)')
        expect(formSource).not.toContain('updateFolder(selected.id, {')
        expect(dialogSource).toContain('<GenerationFolderForm')
    })

    it('awaits guarded mutations before selection, close, and success feedback', () => {
        const formSource = readFileSync('src/components/generation-folders/GenerationFolderForm.tsx', 'utf8')
        const dialogSource = readFileSync('src/components/generation-folders/GenerationFolderManagerDialog.tsx', 'utf8')
        const save = formSource.indexOf('await saveFolder(selected.id, parentId, {')
        const savedCallback = formSource.indexOf('onSaved?.(selected.id)', save)
        const success = formSource.indexOf("variant: 'success'", save)

        expect(dialogSource).toContain('const id = await addFolder({')
        expect(formSource).toContain('await copyPrompt(selected.id, transferTargets, commonPrompt)')
        expect(dialogSource).toContain('await deleteFolders([selected.id])')
        expect(dialogSource).toContain('onOpenChange(false)')
        expect(save).toBeGreaterThan(-1)
        expect(savedCallback).toBeGreaterThan(save)
        expect(success).toBeGreaterThan(save)
    })

    it('embeds GenerationFolderForm directly inside the folder workbench settings sheet', () => {
        const workbenchSource = readFileSync('src/pages/FolderWorkbench.tsx', 'utf8')

        expect(workbenchSource).toContain('<GenerationFolderForm')
        expect(workbenchSource).not.toContain('changeFolderSettings')
    })
})
