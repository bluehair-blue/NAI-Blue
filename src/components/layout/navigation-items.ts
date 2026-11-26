import type { LucideIcon } from 'lucide-react'
import {
    CloudUpload,
    DatabaseZap,
    Film,
    FlaskConical,
    FolderTree,
    Globe,
    Home,
    Images,
    ListTodo,
    Settings,
    Trash2,
    Wand2,
    Zap,
} from 'lucide-react'
import type { ShortcutAction } from '@/stores/shortcut-store'

export type NavigationGroup = 'primary' | 'authoring' | 'archive' | 'data' | 'settings'

export interface NavigationItem {
    readonly path: string
    readonly icon: LucideIcon
    readonly labelKey: string
    readonly fallbackLabel: string
    readonly compactLabelKey?: string
    readonly compactFallbackLabel?: string
    readonly group: NavigationGroup
    readonly shortcutAction?: ShortcutAction
    readonly primaryOnMobile?: boolean
}

/** Single source of truth for top-level navigation order, grouping, and keyboard bindings. */
export const NAVIGATION_ITEMS: readonly NavigationItem[] = [
    {
        path: '/folders',
        icon: FolderTree,
        labelKey: 'folderWorkbench.design.navCreate',
        fallbackLabel: '이미지 만들기',
        compactLabelKey: 'folderWorkbench.design.navCreateCompact',
        compactFallbackLabel: '만들기',
        group: 'primary',
        shortcutAction: 'navigate:folders',
        primaryOnMobile: true,
    },
    {
        path: '/advanced',
        icon: Home,
        labelKey: 'folderWorkbench.design.navSingle',
        fallbackLabel: '단건 생성',
        group: 'primary',
        shortcutAction: 'navigate:main',
    },
    {
        path: '/scenes',
        icon: Film,
        labelKey: 'folderWorkbench.design.navScenes',
        fallbackLabel: '씬',
        group: 'primary',
        shortcutAction: 'navigate:scenes',
    },
    {
        path: '/queue',
        icon: ListTodo,
        labelKey: 'folderWorkbench.design.navHistory',
        fallbackLabel: '작업 기록',
        compactLabelKey: 'folderWorkbench.design.navHistoryCompact',
        compactFallbackLabel: '기록',
        group: 'primary',
        shortcutAction: 'navigate:queue',
        primaryOnMobile: true,
    },
    {
        path: '/tools',
        icon: Wand2,
        labelKey: 'smartTools.title',
        fallbackLabel: '스마트 툴',
        group: 'authoring',
        shortcutAction: 'navigate:tools',
    },
    {
        path: '/style-lab',
        icon: FlaskConical,
        labelKey: 'nav.styleLab',
        fallbackLabel: '그림체 연구소',
        group: 'authoring',
    },
    {
        path: '/guided-preview',
        icon: Zap,
        labelKey: 'guided.home.choices',
        fallbackLabel: '작업 선택',
        group: 'authoring',
    },
    {
        path: '/library',
        icon: Images,
        labelKey: 'nav.library',
        fallbackLabel: '라이브러리',
        group: 'archive',
        shortcutAction: 'navigate:library',
    },
    {
        path: '/trash',
        icon: Trash2,
        labelKey: 'nav.trash',
        fallbackLabel: '휴지통',
        group: 'archive',
    },
    {
        path: '/data',
        icon: DatabaseZap,
        labelKey: 'nav.dataHub',
        fallbackLabel: '데이터 허브',
        group: 'data',
    },
    {
        path: '/r2',
        icon: CloudUpload,
        labelKey: 'nav.r2Upload',
        fallbackLabel: 'R2 업로드',
        group: 'data',
    },
    {
        path: '/web',
        icon: Globe,
        labelKey: 'nav.web',
        fallbackLabel: '웹',
        group: 'data',
        shortcutAction: 'navigate:web',
    },
    {
        path: '/settings',
        icon: Settings,
        labelKey: 'nav.settings',
        fallbackLabel: '설정',
        group: 'settings',
        shortcutAction: 'navigate:settings',
    },
]

export const NAVIGATION_ROUTE_ORDER: readonly string[] = [
    '/folders',
    '/advanced',
    '/scenes',
    '/queue',
    '/tools',
    '/library',
    '/web',
    '/data',
    '/settings',
]

export function isNavigationPathActive(pathname: string, itemPath: string): boolean {
    if (itemPath === '/folders') return pathname === '/folders' || pathname === '/'
    return pathname === itemPath || pathname.startsWith(`${itemPath}/`)
}
