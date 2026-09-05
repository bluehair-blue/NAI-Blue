import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { indexedDBStorage } from '@/lib/indexed-db'

export interface LibraryItem {
    id: string
    name: string
    path: string
    width: number
    height: number
    createdAt: number
    generationFolderId?: string | null
    format?: 'png' | 'webp'
    sidecarPath?: string | null
    r2JobIds?: readonly string[]
    r2Status?: 'not-requested' | 'queued' | 'uploaded' | 'pending-or-failed'
    // Stack support
    isStack?: boolean
    stackItems?: LibraryItem[]  // Items inside this stack (only if isStack=true)
}

interface LibraryState {
    items: LibraryItem[]
    draggedSource: { name: string, path: string } | null
    gridColumns: number

    // Edit Mode (Multi-Select)
    isEditMode: boolean
    selectedItemIds: string[]
    lastSelectedItemId: string | null

    setGridColumns: (columns: number) => void

    addItem: (item: LibraryItem) => void
    removeItem: (id: string) => void
    removeItems: (ids: string[]) => void
    setItems: (items: LibraryItem[]) => void
    updateItem: (id: string, updates: Partial<LibraryItem>) => void
    setDraggedSource: (source: { name: string, path: string } | null) => void

    // Edit Mode Actions
    setEditMode: (isEdit: boolean) => void
    toggleItemSelection: (itemId: string, clearOthers?: boolean) => void
    selectItemRange: (fromId: string, toId: string) => void
    selectAllItems: () => void
    selectItems: (ids: readonly string[]) => void
    clearSelection: () => void
    deleteSelectedItems: () => void
    setLastSelectedItemId: (id: string | null) => void

    // Stack Actions
    createStackFromSelected: () => void
    unstack: (stackId: string) => void
    getStackItems: (stackId: string) => LibraryItem[]

    // Current Stack View (for navigation into a stack)
    currentStackId: string | null
    setCurrentStackId: (id: string | null) => void
}

export const useLibraryStore = create<LibraryState>()(
    persist(
        (set, get) => ({
            items: [],
            draggedSource: null,
            gridColumns: 4,

            // Edit Mode State
            isEditMode: false,
            selectedItemIds: [],
            lastSelectedItemId: null,

            // Current Stack View
            currentStackId: null,

            setGridColumns: (columns) => set({ gridColumns: columns }),

            addItem: (item) => set((state) => ({
                items: [item, ...state.items]
            })),

            removeItem: (id) => set((state) => ({
                // LibraryContextMenu also operates inside stacks; pruning both
                // levels keeps its trash handoff aligned with the visible item.
                items: state.items
                    .filter(item => item.id !== id)
                    .map(item => item.stackItems
                        ? { ...item, stackItems: item.stackItems.filter(stackItem => stackItem.id !== id) }
                        : item),
            })),

            removeItems: (ids) => set((state) => ({
                items: state.items.filter((item) => !ids.includes(item.id))
            })),

            setItems: (items) => set({ items }),

            updateItem: (id, updates) => set((state) => ({
                items: state.items.map(item => {
                    if (item.id === id) return { ...item, ...updates }
                    if (!item.stackItems) return item
                    return {
                        ...item,
                        stackItems: item.stackItems.map(stackItem => stackItem.id === id
                            ? { ...stackItem, ...updates }
                            : stackItem),
                    }
                }),
            })),

            setDraggedSource: (source) => set({ draggedSource: source }),

            // Edit Mode Actions
            setEditMode: (isEdit) => set({
                isEditMode: isEdit,
                selectedItemIds: isEdit ? [] : [],
                lastSelectedItemId: null
            }),

            toggleItemSelection: (itemId, clearOthers = false) => {
                const { selectedItemIds } = get()
                if (clearOthers) {
                    // Single select - toggle only this one
                    set({
                        selectedItemIds: selectedItemIds.includes(itemId) ? [] : [itemId],
                        lastSelectedItemId: itemId
                    })
                } else {
                    // Multi-select toggle
                    set({
                        selectedItemIds: selectedItemIds.includes(itemId)
                            ? selectedItemIds.filter(id => id !== itemId)
                            : [...selectedItemIds, itemId],
                        lastSelectedItemId: itemId
                    })
                }
            },

            selectItemRange: (fromId, toId) => {
                const { items, currentStackId } = get()
                // Get current view items (either main or inside stack)
                const viewItems = currentStackId
                    ? items.find(i => i.id === currentStackId)?.stackItems || []
                    : items

                const fromIndex = viewItems.findIndex(i => i.id === fromId)
                const toIndex = viewItems.findIndex(i => i.id === toId)
                if (fromIndex === -1 || toIndex === -1) return

                const start = Math.min(fromIndex, toIndex)
                const end = Math.max(fromIndex, toIndex)
                const rangeIds = viewItems.slice(start, end + 1).map(i => i.id)

                set({ selectedItemIds: rangeIds, lastSelectedItemId: toId })
            },

            selectAllItems: () => {
                const { items, currentStackId } = get()
                const viewItems = currentStackId
                    ? items.find(i => i.id === currentStackId)?.stackItems || []
                    : items.filter(i => !i.isStack) // Exclude stacks from selection
                set({ selectedItemIds: viewItems.map(i => i.id) })
            },

            selectItems: ids => set({ selectedItemIds: [...new Set(ids)], lastSelectedItemId: ids[ids.length - 1] ?? null }),

            clearSelection: () => set({ selectedItemIds: [], lastSelectedItemId: null }),

            deleteSelectedItems: () => {
                const { items, selectedItemIds, currentStackId } = get()
                
                if (currentStackId) {
                    // Delete from inside a stack
                    set({
                        items: items.map(item =>
                            item.id === currentStackId
                                ? {
                                    ...item,
                                    stackItems: (item.stackItems || []).filter(si => !selectedItemIds.includes(si.id))
                                }
                                : item
                        ),
                        selectedItemIds: [],
                        isEditMode: false
                    })
                } else {
                    // Delete from main library
                    set({
                        items: items.filter(item => !selectedItemIds.includes(item.id)),
                        selectedItemIds: [],
                        isEditMode: false
                    })
                }
            },

            setLastSelectedItemId: (id) => set({ lastSelectedItemId: id }),

            // Stack Actions
            createStackFromSelected: () => {
                const { items, selectedItemIds } = get()
                if (selectedItemIds.length < 2) return

                // Get the selected items in order
                const selectedItems = items.filter(i => selectedItemIds.includes(i.id))
                const firstSelected = selectedItems[0]

                // Create a new stack item
                // Note: Stack name uses first item's name + count format
                // The display format will be handled by UI components with i18n
                const stackItem: LibraryItem = {
                    id: crypto.randomUUID(),
                    name: firstSelected.name,
                    path: firstSelected.path, // Use first item's path as thumbnail
                    width: firstSelected.width,
                    height: firstSelected.height,
                    createdAt: Date.now(),
                    isStack: true,
                    stackItems: selectedItems
                }

                // Find the position of the first selected item
                const firstIndex = items.findIndex(i => i.id === selectedItemIds[0])

                // Remove selected items and insert stack at the first item's position
                const remainingItems = items.filter(i => !selectedItemIds.includes(i.id))
                const newItems = [
                    ...remainingItems.slice(0, firstIndex),
                    stackItem,
                    ...remainingItems.slice(firstIndex)
                ]

                set({
                    items: newItems,
                    selectedItemIds: [],
                    isEditMode: false
                })
            },

            unstack: (stackId) => {
                const { items } = get()
                const stackItem = items.find(i => i.id === stackId)
                if (!stackItem || !stackItem.isStack || !stackItem.stackItems) return

                const stackIndex = items.findIndex(i => i.id === stackId)
                const newItems = [
                    ...items.slice(0, stackIndex),
                    ...stackItem.stackItems,
                    ...items.slice(stackIndex + 1)
                ]

                set({ items: newItems, currentStackId: null })
            },

            getStackItems: (stackId) => {
                const stack = get().items.find(i => i.id === stackId)
                return stack?.stackItems || []
            },

            setCurrentStackId: (id) => set({
                currentStackId: id,
                isEditMode: false,
                selectedItemIds: []
            }),
        }),
        {
            name: 'nai-blue-library',
            storage: createJSONStorage(() => indexedDBStorage),
            partialize: (state) => ({ items: state.items, gridColumns: state.gridColumns }), // Don't persist draggedSource, editMode, selection
        }
    )
)
