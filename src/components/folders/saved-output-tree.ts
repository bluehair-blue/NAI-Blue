import type { SavedOutputDirectory } from '@/services/organizer/saved-output-catalog'

export interface SavedOutputNode {
    id: string
    name: string
    path: string
    directory?: SavedOutputDirectory
    children: SavedOutputNode[]
}

/** Build a display-only tree; Windows and UNC paths use the catalog's case-insensitive identity. */
export function buildSavedOutputTree(directories: readonly SavedOutputDirectory[]): SavedOutputNode[] {
    const roots: SavedOutputNode[] = []
    for (const directory of directories) {
        const path = directory.path.replace(/\\/gu, '/')
        const windows = /^[a-z]:\//iu.test(path) || path.startsWith('//') || /^[a-z]:$/iu.test(path)
        const parts = path.startsWith('//')
            ? ['//' + path.slice(2).split('/').filter(Boolean)[0], ...path.slice(2).split('/').filter(Boolean).slice(1)]
            : path.startsWith('/') ? ['/', ...path.slice(1).split('/').filter(Boolean)] : path.split('/').filter(Boolean)
        let siblings = roots
        let currentPath = ''
        let node: SavedOutputNode | undefined
        for (const part of parts) {
            currentPath = currentPath === '/' ? `/${part}` : currentPath ? `${currentPath}/${part}` : part
            const id = windows ? currentPath.toLocaleLowerCase() : currentPath
            node = siblings.find(item => item.id === id)
            if (!node) {
                node = { id, name: part, path: currentPath, children: [] }
                siblings.push(node)
            }
            siblings = node.children
        }
        if (node) node.directory = directory
    }
    // Keep roots visible, but combine unbranched intermediate paths to fit the narrow sidebar.
    const compact = (nodes: SavedOutputNode[]) => {
        for (const node of nodes) {
            while (!node.directory && node.children.length === 1 && !node.children[0].directory) {
                const child = node.children[0]
                node.name += ` / ${child.name}`
                node.id = child.id
                node.path = child.path
                node.children = child.children
            }
            compact(node.children)
        }
    }
    for (const root of roots) compact(root.children)
    return roots
}
