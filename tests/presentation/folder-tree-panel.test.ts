import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { expect, it } from 'vitest'
import { FolderTreePanel } from '@/components/folders/FolderTreePanel'
import { createDefaultGenerationFolder } from '@/domain/generation-folders'

it('shows saved agent directories without registering new generation folders and bounds the list', async () => {
    const i18n = createInstance()
    await i18n.init({ lng: 'ko', resources: {}, interpolation: { escapeValue: false } })
    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n,
        children: createElement(FolderTreePanel, {
            folders: [], activeFolderId: '__saved_output__', counts: {}, onSelect: () => {}, onManage: () => {},
            savedDirectories: Array.from({ length: 100 }, (_, index) => ({ key: `saved-${index}`, path: `C:/Agent/${index}`, count: 2 })),
            selectedDirectory: 'saved-0', onSelectDirectory: () => {},
        }),
    }))
    expect(html).toContain('저장된 이미지 폴더')
    expect(html).toContain('C:/Agent/0')
    expect(html).not.toContain('C:/Agent/40')
    expect(html).toContain('폴더 더 보기')
})

it('renders nested folder navigation with descendant counts and safely ignores a rootless cycle', async () => {
    const i18n = createInstance()
    await i18n.init({ lng: 'ko', resources: {}, interpolation: { escapeValue: false } })
    const base = createDefaultGenerationFolder()
    const html = renderToStaticMarkup(createElement(I18nextProvider, {
        i18n,
        children: createElement(FolderTreePanel, {
            folders: [
                { ...base, id: 'root', name: '여행' },
                { ...base, id: 'child', name: '바다', parentId: 'root', rootDirectory: null },
                { ...base, id: 'cycle-a', name: '순환 A', parentId: 'cycle-b' },
                { ...base, id: 'cycle-b', name: '순환 B', parentId: 'cycle-a' },
            ],
            activeFolderId: 'child',
            counts: { root: 2, child: 3 },
            onSelect: () => {},
            onManage: () => {},
        }),
    }))

    expect(html).toContain('aria-label="여행 접기" aria-expanded="true"')
    expect(html).toContain('aria-label="이미지 5개"')
    expect(html).toContain('aria-current="page" title="여행/바다"')
    expect(html).toMatch(/여행<\/span>.*<ul class="fb-folder-list">.*바다<\/span>/u)
    expect(html).toContain('type="search"')
    expect(html).not.toContain('순환 A')
    expect(html).not.toContain('순환 B')
})
