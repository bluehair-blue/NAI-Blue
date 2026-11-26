import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { indexedDBStorage } from '@/lib/indexed-db'

export type PromptDialogRequest =
    | 'promptGenerator'
    | 'fragment'
    | 'parameterSettings'
    | 'imageReference'
    | 'characterPrompt'

export type PromptFocusTarget = 'model' | 'steps'

interface LayoutState {
    leftSidebarVisible: boolean
    rightSidebarVisible: boolean
    alwaysShowV5UsageLimit: boolean
    /** Transient compact-shell surface; a single value prevents overlapping sheets. */
    supportSheet: 'prompt' | 'history' | 'activity' | null
    /** Transient request queued by shell shortcuts when PromptPanel mounts on demand. */
    pendingPromptDialog: PromptDialogRequest | null
    /** Transient focus handoff from MainMode summary or low-steps feedback. */
    pendingPromptFocus: PromptFocusTarget | null
    /** Transient portal target mounted at the bottom of the docked Main prompt rail. */
    railActionsHost: HTMLDivElement | null
    toggleLeftSidebar: () => void
    toggleRightSidebar: () => void
    setLeftSidebarVisible: (visible: boolean) => void
    setRightSidebarVisible: (visible: boolean) => void
    setAlwaysShowV5UsageLimit: (visible: boolean) => void
    openSupportSheet: (sheet: Exclude<LayoutState['supportSheet'], null>) => void
    closeSupportSheet: () => void
    /** Closes the compact prompt sheet and drops the dialog/focus requests only that surface consumes. */
    dismissPromptSheet: () => void
    requestPromptDialog: (dialog: PromptDialogRequest) => void
    clearPendingPromptDialog: () => void
    requestPromptFocus: (target: PromptFocusTarget) => void
    clearPendingPromptFocus: () => void
    setRailActionsHost: (host: HTMLDivElement | null) => void
}

export const useLayoutStore = create<LayoutState>()(
    persist(
        (set) => ({
            leftSidebarVisible: true,
            rightSidebarVisible: true,
            alwaysShowV5UsageLimit: true,
            supportSheet: null,
            pendingPromptDialog: null,
            pendingPromptFocus: null,
            railActionsHost: null,
            toggleLeftSidebar: () => set((state) => ({ leftSidebarVisible: !state.leftSidebarVisible })),
            toggleRightSidebar: () => set((state) => ({ rightSidebarVisible: !state.rightSidebarVisible })),
            setLeftSidebarVisible: (visible) => set({ leftSidebarVisible: visible }),
            setRightSidebarVisible: (visible) => set({ rightSidebarVisible: visible }),
            setAlwaysShowV5UsageLimit: (visible) => set({ alwaysShowV5UsageLimit: visible }),
            openSupportSheet: (supportSheet) => set({ supportSheet }),
            closeSupportSheet: () => set({ supportSheet: null }),
            dismissPromptSheet: () => set({ supportSheet: null, pendingPromptDialog: null, pendingPromptFocus: null }),
            requestPromptDialog: (pendingPromptDialog) => set({ pendingPromptDialog }),
            clearPendingPromptDialog: () => set({ pendingPromptDialog: null }),
            requestPromptFocus: (pendingPromptFocus) => set({ pendingPromptFocus }),
            clearPendingPromptFocus: () => set({ pendingPromptFocus: null }),
            setRailActionsHost: (railActionsHost) => set({ railActionsHost }),
        }),
        {
            name: 'nai-blue-layout',
            storage: createJSONStorage(() => indexedDBStorage),
            // Dock preferences survive restarts; an open modal surface does not.
            partialize: ({ leftSidebarVisible, rightSidebarVisible, alwaysShowV5UsageLimit }) => ({
                leftSidebarVisible,
                rightSidebarVisible,
                alwaysShowV5UsageLimit,
            }),
        }
    )
)
