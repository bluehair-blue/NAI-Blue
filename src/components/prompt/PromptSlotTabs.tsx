import { useRef, type KeyboardEvent } from 'react'

import { cn } from '@/lib/utils'

export interface PromptSlotTab {
    id: string
    label: string
    filled: boolean
    negative?: boolean
    shortcut?: string
}

interface PromptSlotTabsProps {
    tabs: readonly PromptSlotTab[]
    activeId: string
    panelId: string
    label: string
    onChange(id: string): void
}

/** Shared, container-safe prompt navigation for narrow docks and wide editors. */
export function PromptSlotTabs({ tabs, activeId, panelId, label, onChange }: PromptSlotTabsProps) {
    const refs = useRef<Array<HTMLButtonElement | null>>([])

    const selectFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        let nextIndex: number | null = null
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
        else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
        else if (event.key === 'Home') nextIndex = 0
        else if (event.key === 'End') nextIndex = tabs.length - 1
        if (nextIndex === null) return

        event.preventDefault()
        onChange(tabs[nextIndex].id)
        refs.current[nextIndex]?.focus()
    }

    return (
        <div
            className="grid grid-flow-col auto-cols-fr border-b border-border/60"
            role="tablist"
            aria-label={label}
        >
            {tabs.map((tab, index) => {
                const active = tab.id === activeId
                return (
                    <button
                        key={tab.id}
                        ref={node => { refs.current[index] = node }}
                        type="button"
                        role="tab"
                        id={`${panelId}-${tab.id}-tab`}
                        aria-selected={active}
                        aria-controls={panelId}
                        aria-keyshortcuts={tab.shortcut}
                        tabIndex={active ? 0 : -1}
                        onClick={() => onChange(tab.id)}
                        onKeyDown={event => selectFromKeyboard(event, index)}
                        className={cn(
                            'relative min-h-11 min-w-0 truncate whitespace-nowrap border-b-2 border-border/35 px-1.5 py-2 text-sm leading-snug text-muted-foreground transition-colors duration-standard hover:bg-primary/[0.045] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @min-[40rem]:px-3',
                            active && (tab.negative
                                ? 'border-destructive font-semibold text-destructive'
                                : 'border-primary font-semibold text-foreground'),
                        )}
                    >
                        {tab.label}
                        {tab.filled && !active && (
                            <span className="ml-1.5 inline-block h-1 w-1 rounded-full bg-current align-middle opacity-60" aria-hidden="true" />
                        )}
                    </button>
                )
            })}
        </div>
    )
}
