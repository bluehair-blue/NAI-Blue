import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import {
    BriefcaseBusiness,
    Keyboard,
    Moon,
    PanelLeft,
    PanelRight,
    Play,
    Search,
    Sun,
    type LucideIcon,
} from 'lucide-react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { NAVIGATION_ITEMS } from '@/components/layout/navigation-items'
import { SHORTCUT_EVENTS } from '@/hooks/useShortcuts'
import { cn } from '@/lib/utils'
import { executePromptGenerationCommand } from '@/services/generation/prompt-generation-command'
import { useShortcutStore } from '@/stores/shortcut-store'
import { useThemeStore } from '@/stores/theme-store'

interface CommandEntry {
    readonly id: string
    readonly label: string
    readonly group: string
    readonly keywords: string
    readonly icon: LucideIcon
    readonly shortcut?: string
    readonly run: () => void
}

export interface CommandPaletteProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    canOpenPrompt: boolean
    onOpenPrompt: () => void
    onOpenHistory: () => void
    onOpenActivity: () => void
}

/** Keyboard-first command finder backed by Radix Dialog without extra dependencies. */
export function CommandPalette({
    open,
    onOpenChange,
    canOpenPrompt,
    onOpenPrompt,
    onOpenHistory,
    onOpenActivity,
}: CommandPaletteProps) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const location = useLocation()
    const listboxId = useId()
    const inputRef = useRef<HTMLInputElement>(null)
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
    const bindings = useShortcutStore(state => state.bindings)
    const theme = useThemeStore(state => state.theme)
    const setTheme = useThemeStore(state => state.setTheme)
    const [query, setQuery] = useState('')
    const [activeIndex, setActiveIndex] = useState(0)

    useEffect(() => {
        if (open) {
            setQuery('')
            setActiveIndex(0)
        }
    }, [open])

    const isDark = theme === 'dark' || (theme === 'system' && typeof document !== 'undefined' && document.documentElement.classList.contains('dark'))
    const generateShortcut = bindings['action:generate']?.label || undefined

    const commands = useMemo<CommandEntry[]>(() => {
        const navGroupLabels: Record<string, string> = {
            primary: t('commandPalette.groups.navigate', '화면 이동'),
            authoring: t('folderWorkbench.navigation.groups.authoring', '제작 보조'),
            archive: t('folderWorkbench.navigation.groups.archive', '보관'),
            data: t('folderWorkbench.navigation.groups.data', '데이터'),
            settings: t('commandPalette.groups.settings', '설정'),
        }

        const list: CommandEntry[] = NAVIGATION_ITEMS.map(item => {
            const label = t(item.labelKey, item.fallbackLabel)
            return {
                id: `nav:${item.path}`,
                label,
                group: navGroupLabels[item.group] ?? t('commandPalette.groups.navigate', '화면 이동'),
                keywords: `${label} ${item.fallbackLabel} ${item.path}`,
                icon: item.icon,
                shortcut: item.shortcutAction ? bindings[item.shortcutAction]?.label || undefined : undefined,
                run: () => navigate(item.path),
            }
        })

        const panelsGroup = t('folderWorkbench.navigation.groups.panels', '패널')
        if (canOpenPrompt) {
            list.push({
                id: 'panel:prompt',
                label: t('commandPalette.actions.openPrompt', '프롬프트 열기'),
                group: panelsGroup,
                keywords: 'prompt 프롬프트 패널',
                icon: PanelLeft,
                run: onOpenPrompt,
            })
        }
        list.push(
            {
                id: 'panel:history',
                label: t('commandPalette.actions.openHistory', '기록 열기'),
                group: panelsGroup,
                keywords: 'history 기록 최근 생성',
                icon: PanelRight,
                run: onOpenHistory,
            },
            {
                id: 'panel:activity',
                label: t('commandPalette.actions.openActivity', '내 작업 열기'),
                group: panelsGroup,
                keywords: 'activity my work 내 작업 진행',
                icon: BriefcaseBusiness,
                run: onOpenActivity,
            },
        )

        const actionsGroup = t('commandPalette.groups.actions', '동작')
        const canRunRoutePrimary = location.pathname === '/advanced'
            || location.pathname === '/folders'
            || location.pathname === '/'
            || location.pathname === '/scenes'
            || location.pathname.startsWith('/scenes/')
        if (canRunRoutePrimary) {
            list.push({
                id: 'action:primary',
                label: t('commandPalette.actions.runPrimary', '현재 화면 생성 실행'),
                group: actionsGroup,
                keywords: 'generate create make run 생성 만들기 실행',
                icon: Play,
                shortcut: generateShortcut,
                run: () => {
                    if (location.pathname === '/advanced') {
                        void executePromptGenerationCommand('main')
                    } else {
                        window.dispatchEvent(new CustomEvent(SHORTCUT_EVENTS.GENERATE))
                    }
                },
            })
        }

        list.push(
            {
                id: 'action:theme',
                label: isDark
                    ? t('folderWorkbench.design.toLight', '밝은 화면으로 바꾸기')
                    : t('folderWorkbench.design.toDark', '어두운 화면으로 바꾸기'),
                group: actionsGroup,
                keywords: 'theme dark light 테마 밝게 어둡게 다크 라이트',
                icon: isDark ? Sun : Moon,
                run: () => setTheme(isDark ? 'light' : 'dark'),
            },
            {
                id: 'action:shortcuts',
                label: t('commandPalette.actions.openShortcuts', '단축키 설정 열기'),
                group: t('commandPalette.groups.settings', '설정'),
                keywords: 'shortcut keybinding keyboard 단축키 키 설정',
                icon: Keyboard,
                run: () => navigate('/settings?section=shortcuts'),
            },
        )

        return list
    }, [
        bindings,
        canOpenPrompt,
        generateShortcut,
        isDark,
        location.pathname,
        navigate,
        onOpenActivity,
        onOpenHistory,
        onOpenPrompt,
        setTheme,
        t,
    ])

    const filtered = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase()
        if (!needle) return commands
        return commands.filter(item =>
            item.label.toLocaleLowerCase().includes(needle)
            || item.group.toLocaleLowerCase().includes(needle)
            || item.keywords.toLocaleLowerCase().includes(needle),
        )
    }, [commands, query])

    const safeIndex = filtered.length > 0 ? Math.min(activeIndex, filtered.length - 1) : -1

    useEffect(() => {
        if (safeIndex >= 0) {
            itemRefs.current[safeIndex]?.scrollIntoView({ block: 'nearest' })
        }
    }, [safeIndex])

    const executeEntry = (entry: CommandEntry) => {
        onOpenChange(false)
        entry.run()
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'ArrowDown') {
            event.preventDefault()
            if (filtered.length > 0) setActiveIndex(prev => (prev + 1) % filtered.length)
            return
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault()
            if (filtered.length > 0) setActiveIndex(prev => (prev - 1 + filtered.length) % filtered.length)
            return
        }
        if (event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            if (safeIndex >= 0 && filtered[safeIndex]) {
                executeEntry(filtered[safeIndex])
            }
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                closeLabel={t('common.close', '닫기')}
                data-testid="command-palette"
                className="max-w-xl gap-0 overflow-hidden p-0"
                onOpenAutoFocus={event => {
                    event.preventDefault()
                    inputRef.current?.focus()
                }}
            >
                <DialogHeader className="sr-only">
                    <DialogTitle>{t('folderWorkbench.navigation.commandPalette', '명령 찾기')}</DialogTitle>
                    <DialogDescription>{t('commandPalette.description', '화면 이동, 패널 열기, 실행 명령을 검색해 바로 실행합니다.')}</DialogDescription>
                </DialogHeader>
                <div className="flex items-center gap-2 border-b border-border/60 px-4 pr-14 py-2">
                    <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <Input
                        ref={inputRef}
                        type="text"
                        role="combobox"
                        aria-expanded={true}
                        aria-controls={listboxId}
                        aria-activedescendant={safeIndex >= 0 && filtered[safeIndex] ? `${listboxId}-${filtered[safeIndex].id}` : undefined}
                        aria-label={t('folderWorkbench.navigation.commandPalette', '명령 찾기')}
                        placeholder={t('commandPalette.placeholder', '화면이나 명령 이름을 입력하세요…')}
                        value={query}
                        onChange={event => {
                            setQuery(event.target.value)
                            setActiveIndex(0)
                        }}
                        onKeyDown={handleKeyDown}
                        className="h-11 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
                    />
                </div>
                <div
                    id={listboxId}
                    role="listbox"
                    aria-label={t('folderWorkbench.navigation.commandPalette', '명령 찾기')}
                    className="max-h-[min(60dvh,420px)] overflow-y-auto p-2"
                >
                    {filtered.length === 0 ? (
                        <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                            {t('commandPalette.empty', '일치하는 명령이 없어요.')}
                        </p>
                    ) : (
                        filtered.map((entry, index) => {
                            const active = index === safeIndex
                            const Icon = entry.icon
                            return (
                                <button
                                    key={entry.id}
                                    id={`${listboxId}-${entry.id}`}
                                    ref={node => { itemRefs.current[index] = node }}
                                    type="button"
                                    role="option"
                                    aria-selected={active}
                                    onMouseEnter={() => setActiveIndex(index)}
                                    onClick={() => executeEntry(entry)}
                                    className={cn(
                                        'flex min-h-11 w-full items-center gap-3 rounded-control px-3 py-2 text-left text-sm transition-colors',
                                        active ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/55',
                                    )}
                                >
                                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                    <span className="min-w-0 flex-1 truncate font-medium">{entry.label}</span>
                                    <span className="shrink-0 text-xs text-muted-foreground">{entry.group}</span>
                                    {entry.shortcut && (
                                        <kbd className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                                            {entry.shortcut}
                                        </kbd>
                                    )}
                                </button>
                            )
                        })
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}
