import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { expect, it } from 'vitest'
import { FolderTreePanel } from '@/components/folders/FolderTreePanel'
import { createDefaultGenerationFolder } from '@/domain/generation-folders'
import { buildSavedOutputTree } from '@/components/folders/saved-output-tree'

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
    expect(html).toMatch(/E:|C:/u)
    expect(html).toContain('aria-label="C: 접기"')
    expect(html).toMatch(/C:<\/span>.*Agent<\/span>.*0<\/span>/u)
    expect(html).toContain('C:/Agent/0')
    expect(html).not.toContain('C:/Agent/40')
    expect(html).toContain('폴더 더 보기')
})

it('groups common paths without losing selectable parent folders or platform path identity', () => {
    const tree = buildSavedOutputTree([
        { key: 'parent', path: 'E:/Photos', count: 2 },
        { key: 'child', path: 'e:\\photos\\Trip\\Sea', count: 3 },
        { key: 'other', path: 'E:/Photos/Trip/Mountain', count: 1 },
        { key: 'unc', path: '//server/share/images', count: 1 },
        { key: 'posix-a', path: '/Images/One', count: 1 },
        { key: 'posix-b', path: '/images/Two', count: 1 },
    ])
    expect(tree.map(node => node.name)).toEqual(['E:', '//server', '/'])
    const photos = tree[0].children[0]
    expect(photos.directory?.key).toBe('parent')
    expect(photos.children[0].name).toBe('Trip')
    expect(photos.children[0].children.map(node => node.directory?.key)).toEqual(['child', 'other'])
    expect(tree[1].children[0].name).toBe('share')
    expect(tree[2].children.map(node => node.name)).toEqual(['Images', 'images'])
})

it('keeps saved parent and child folders selectable with their own image counts', async () => {
    const i18n = createInstance()
    await i18n.init({ lng: 'ko', resources: {}, interpolation: { escapeValue: false } })
    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n,
        children: createElement(FolderTreePanel, {
            folders: [], activeFolderId: '__saved_output__', counts: {}, onSelect: () => {}, onManage: () => {},
            savedDirectories: [{ key: 'parent', path: 'E:/Photos', count: 2 }, { key: 'child', path: 'E:/Photos/Sea', count: 3 }],
            selectedDirectory: 'parent', onSelectDirectory: () => {},
        }),
    }))
    expect(html).toContain('aria-label="Photos 접기"')
    expect(html).toContain('title="E:/Photos" aria-current="page"')
    expect(html).toContain('title="E:/Photos/Sea"')
    expect(html).toContain('aria-label="저장된 이미지 2장"')
    expect(html).toContain('aria-label="저장된 이미지 3장"')
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
