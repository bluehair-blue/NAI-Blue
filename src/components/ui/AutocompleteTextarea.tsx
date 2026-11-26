import {
    useState,
    useRef,
    useEffect,
    useId,
    Fragment,
    KeyboardEvent,
    useCallback,
} from 'react'
import { createPortal } from 'react-dom'
import EditorExport from 'react-simple-code-editor'
import { getCaretCoordinates } from '@/utils/caret-coords'
import { cn } from '@/lib/utils'
import { loadAutocompleteTagIndex } from '@/lib/tag-data'
import { useFragmentStore } from '@/stores/fragment-store'

// react-simple-code-editor publishes a transpiled CommonJS default; Vite 8 can
// preserve that wrapper, so normalize both the wrapped and direct ESM shapes.
const Editor = (EditorExport as unknown as { default?: typeof EditorExport }).default ?? EditorExport

interface SuggestionItem {
    label: string
    value: string
    count?: number
    type: string
    _lower?: string
}

interface AutocompleteTextareaProps {
    value: string
    onChange: (e: { target: { value: string } }) => void
    className?: string
    maxSuggestions?: number
    style?: React.CSSProperties
    placeholder?: string
    disabled?: boolean
    readOnly?: boolean
    id?: string
    ariaLabel?: string
    onPromptContextMenu?: (context: {
        value: string
        selectionStart: number
        selectionEnd: number
    }) => void
}

// Single source of truth for Typography to ensure Textarea and Pre match perfectly.
const TYPOGRAPHY = {
    fontFamily: '"Pretendard", "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif',
    lineHeight: '1.5',
    letterSpacing: 'normal',
    fontVariantLigatures: 'none',
    tabSize: 4,
}

export function AutocompleteTextarea({
    value,
    onChange,
    className,
    maxSuggestions = 15,
    style, // mainly used for fontSize
    placeholder,
    id,
    ariaLabel,
    onPromptContextMenu,
    ...props
}: AutocompleteTextareaProps) {
    const generatedId = useId()
    const editorId = id ?? `prompt-editor-${generatedId.replace(/:/g, '')}`
    // --- Refs ---
    const textareaRef = useRef<HTMLTextAreaElement | null>(null)
    const containerRef = useRef<HTMLDivElement>(null) // The scrolling container
    const listRef = useRef<HTMLDivElement>(null)
    const autocompleteRequestRef = useRef(0)

    // onChange 디바운스를 위한 타이머 ref
    const onChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const pendingExternalValueRef = useRef<string | null>(null)
    const onChangeRef = useRef(onChange)
    onChangeRef.current = onChange

    // The editor renders from local state for typing performance, while prompt
    // tabs and responsive containers can unmount it before the debounce fires.
    // Flushing on blur/unmount keeps the owning GenerationDraft store in sync.
    const flushPendingChange = useCallback(() => {
        if (onChangeTimerRef.current !== null) {
            clearTimeout(onChangeTimerRef.current)
            onChangeTimerRef.current = null
        }
        const pendingValue = pendingExternalValueRef.current
        if (pendingValue === null) return
        pendingExternalValueRef.current = null
        onChangeRef.current({ target: { value: pendingValue } })
    }, [])

    const scheduleExternalChange = useCallback((nextValue: string, delayMs: number) => {
        pendingExternalValueRef.current = nextValue
        if (onChangeTimerRef.current !== null) clearTimeout(onChangeTimerRef.current)
        onChangeTimerRef.current = setTimeout(flushPendingChange, delayMs)
    }, [flushPendingChange])

    // Fragment Store 구독 (조각 프롬프트 목록)
    const fragmentFiles = useFragmentStore(state => state.files)

    // --- State ---
    // 내부 state로 즉시 렌더링 (uncontrolled 방식)
    const [internalValue, setInternalValue] = useState(value)
    const [suggestions, setSuggestions] = useState<SuggestionItem[]>([])
    const [selectedIndex, setSelectedIndex] = useState(0)
    const [isVisible, setIsVisible] = useState(false)
    const [coords, setCoords] = useState({ top: 0, left: 0 })
    const [suggestionMode, setSuggestionMode] = useState<'tag' | 'wildcard'>('tag')

    // 외부 value가 변경되면 내부 state 동기화 (예: 프리셋 로드)
    // 단, 내부값과 동일하면 동기화 스킵 (커서 점프 방지)
    useEffect(() => {
        if (value !== internalValue) {
            setInternalValue(value)
        }
    }, [value]) // internalValue는 의도적으로 dependency에서 제외

    // --- Helpers ---
    const getCurrentWord = (text: string, position: number) => {
        const left = text.slice(0, position)
        // Match backwards to comma, newline, or :: (for V4 weight syntax like 2::tag::)
        const match = left.match(/[^,\n:]*$/)
        return match ? match[0].trimStart() : ''
    }

    // `<` 이후의 와일드카드 이름 추출
    const getWildcardWord = (text: string, position: number): string | null => {
        const left = text.slice(0, position)
        // `<` 이후의 텍스트 찾기 (아직 닫히지 않은 경우)
        const match = left.match(/<([^<>]*)$/)
        return match ? match[1] : null
    }

    // --- Autocomplete Logic ---
    const checkAutocomplete = useCallback(async (val: string, el: HTMLTextAreaElement) => {
        const requestId = ++autocompleteRequestRef.current

        const pos = el.selectionEnd || val.length

        // 1. 조각 모드 체크 (`<` 이후)
        const wildcardWord = getWildcardWord(val, pos)
        if (wildcardWord !== null) {
            // 조각 프롬프트 자동완성 (즉시, 디바운스 없음)
            const lower = wildcardWord.toLowerCase()
            const matches: SuggestionItem[] = []

            for (const file of fragmentFiles) {
                if (matches.length >= maxSuggestions) break
                const fullPath = file.folder ? `${file.folder}/${file.name}` : file.name
                const fullPathLower = fullPath.toLowerCase()

                // 빈 문자열이면 모든 파일 표시, 아니면 필터링
                if (wildcardWord === '' || fullPathLower.includes(lower)) {
                    matches.push({
                        label: fullPath,
                        value: fullPath,
                        count: file.lineCount,
                        type: 'fragment'
                    })
                }
            }

            if (matches.length > 0) {
                setSuggestions(matches)
                setSuggestionMode('wildcard')
                setSelectedIndex(0)

                const rect = el.getBoundingClientRect()
                const caret = getCaretCoordinates(el, pos)

                setCoords({
                    // The list is position:fixed, so coordinates must stay in
                    // viewport space. Clamping prevents mobile sheet overflow.
                    top: Math.min(Math.max(8, rect.top + caret.top + 24), Math.max(8, window.innerHeight - 160)),
                    left: Math.min(Math.max(8, rect.left + caret.left), Math.max(8, window.innerWidth - 264))
                })
                setIsVisible(true)
            } else {
                setIsVisible(false)
            }
            return
        }

        // 2. 일반 태그 자동완성
        const word = getCurrentWord(val, pos)
        if (word.length < 2) {
            setIsVisible(false)
            return
        }

        const lower = word.toLowerCase()
        const firstChar = lower[0] || ''
        let tagIndex

        try {
            tagIndex = await loadAutocompleteTagIndex()
        } catch (err) {
            console.error('[Autocomplete] Failed to load tag data:', err)
            setIsVisible(false)
            return
        }

        if (requestId !== autocompleteRequestRef.current || textareaRef.current !== el || el.value !== val) {
            return
        }

        // 인덱스 기반 검색 (해당 첫 글자 태그만 검색)
        const indexedTags = tagIndex.byFirstChar[firstChar] || []
        const matches: SuggestionItem[] = []

        // 1단계: 인덱스된 태그에서 startsWith 매칭
        for (const tag of indexedTags) {
            if (matches.length >= maxSuggestions) break
            if (tag._searchTerms.some(term => term.startsWith(lower))) {
                matches.push(tag)
            }
        }

        // 2단계: 부족하면 전체에서 includes 보조 검색
        if (matches.length < maxSuggestions) {
            for (const tag of tagIndex.all) {
                if (matches.length >= maxSuggestions) break
                if (
                    !tag._searchTerms.some(term => term.startsWith(lower))
                    && tag._searchTerms.some(term => term.includes(lower))
                ) {
                    matches.push(tag)
                }
            }
        }

        if (matches.length > 0) {
            setSuggestions(matches)
            setSuggestionMode('tag')
            setSelectedIndex(0)

            const rect = el.getBoundingClientRect()
            const caret = getCaretCoordinates(el, pos)

            setCoords({
                top: Math.min(Math.max(8, rect.top + caret.top + 24), Math.max(8, window.innerHeight - 160)),
                left: Math.min(Math.max(8, rect.left + caret.left), Math.max(8, window.innerWidth - 264))
            })
            setIsVisible(true)
        } else {
            setIsVisible(false)
        }
    }, [maxSuggestions, fragmentFiles])

    const warmTagIndex = useCallback(() => {
        void loadAutocompleteTagIndex().catch(err => {
            console.error('[Autocomplete] Failed to warm tag data:', err)
        })
    }, [])

    const insertSuggestion = (suggestion: SuggestionItem) => {
        if (!textareaRef.current) return
        const el = textareaRef.current
        const val = internalValue  // Use internal value for immediate update
        const pos = el.selectionEnd || 0

        if (suggestionMode === 'wildcard') {
            // 와일드카드 삽입: <name> 형태로
            const wildcardWord = getWildcardWord(val, pos)
            if (wildcardWord === null) return

            // `<` 위치 찾기
            const left = val.slice(0, pos)
            const bracketPos = left.lastIndexOf('<')
            if (bracketPos === -1) return

            const before = val.slice(0, bracketPos)
            const after = val.slice(pos)

            // <name> 형태로 삽입 (닫는 괄호 포함)
            const newValue = before + '<' + suggestion.value + '>' + after
            const newCursorPos = bracketPos + suggestion.value.length + 2 // <name>

            // Update internal state immediately (no flicker)
            setInternalValue(newValue)
            setIsVisible(false)

            // Set cursor position immediately
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
                    textareaRef.current.focus()
                }
            })

            // Debounce external onChange to avoid re-render resetting cursor.
            scheduleExternalChange(newValue, 50)
        } else {
            // 일반 태그 삽입 (:: 문법 지원)
            const left = val.slice(0, pos)
            const wordMatch = left.match(/[^,\n:]*$/)
            if (!wordMatch) return

            const wordStart = wordMatch.index!
            const before = val.slice(0, wordStart)
            const after = val.slice(pos)

            // Add space only if not at start and not after special chars
            const lastChar = before.slice(-1)
            const needsSpace = before.length > 0 && ![' ', '\n', ':'].includes(lastChar)
            const prefix = needsSpace ? ' ' : ''

            // Always use ", " as suffix (user will close :: manually if needed)
            const suffix = ', '

            // Keep after as-is to preserve newlines and formatting
            const newValue = before + prefix + suggestion.value + suffix + after

            // Calculate new cursor position
            const newCursorPos = wordStart + prefix.length + suggestion.value.length + suffix.length

            // Update internal state immediately (no flicker)
            setInternalValue(newValue)
            setIsVisible(false)

            // Set cursor position immediately
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
                    textareaRef.current.focus()
                    scrollToCaret()
                }
            })

            // Debounce external onChange to avoid re-render resetting cursor.
            scheduleExternalChange(newValue, 50)
        }
    }

    // --- Scroll Sync Logic ---
    // Manually scrolls the container to keep the caret in view during typing/navigation
    const scrollToCaret = () => {
        if (!textareaRef.current || !containerRef.current) return
        const el = textareaRef.current
        const container = containerRef.current

        requestAnimationFrame(() => {
            const { top, height } = getCaretCoordinates(el, el.selectionEnd)
            // Padding offset (must match Editor padding prop)
            const PADDING_OFFSET = 12
            const caretTop = top + PADDING_OFFSET
            const caretBottom = caretTop + height + 4 // Small buffer

            const containerTop = container.scrollTop
            const containerBottom = containerTop + container.clientHeight

            // Scroll if out of bounds
            if (caretBottom > containerBottom) {
                container.scrollTop = caretBottom - container.clientHeight
            } else if (caretTop < containerTop) {
                container.scrollTop = caretTop
            }
        })
    }

    // --- Event Handlers ---
    const handleValueChange = (code: string) => {
        // 내부 state 즉시 업데이트 (UI 반응성)
        setInternalValue(code)

        // onChange를 100ms 디바운스 (Zustand 업데이트 지연으로 렉 방지)
        scheduleExternalChange(code, 100)

        if (textareaRef.current) {
            checkAutocomplete(code, textareaRef.current)
            scrollToCaret()
        }
    }

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement | HTMLDivElement>) => {
        // Ensure ref is captured
        if (e.target instanceof HTMLTextAreaElement) {
            textareaRef.current = e.target
        }

        // Flush pending debounced edits before Ctrl/Cmd+Enter reaches global generation.
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'Enter') {
            flushPendingChange()
            if (isVisible) {
                setIsVisible(false)
            }
            return
        }

        if (isVisible) {
            if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelectedIndex(prev => (prev + 1) % suggestions.length)
                return
            } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelectedIndex(prev => (prev - 1 + suggestions.length) % suggestions.length)
                return
            } else if (
                (e.key === 'Enter' || e.key === 'Tab') &&
                !e.ctrlKey &&
                !e.metaKey &&
                !e.altKey &&
                !e.shiftKey
            ) {
                e.preventDefault()
                e.stopPropagation() // Prevent default newline
                if (suggestions[selectedIndex]) {
                    insertSuggestion(suggestions[selectedIndex])
                }
                return
            } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setIsVisible(false)
                return
            }
        }
    }

    // --- Effects ---
    // Prompt slot changes remount this editor. Commit pending text before the
    // old slot disappears so fast tab switches cannot discard the last input.
    useEffect(() => {
        return flushPendingChange
    }, [flushPendingChange])

    // Scroll active suggestion into view
    useEffect(() => {
        if (!isVisible || !listRef.current) return
        const list = listRef.current
        const item = list.children[0]?.children[selectedIndex] as HTMLElement
        if (item) {
            const itemTop = item.offsetTop
            const itemBottom = itemTop + item.offsetHeight
            const listTop = list.scrollTop
            const listBottom = listTop + list.clientHeight
            if (itemTop < listTop) list.scrollTop = itemTop
            else if (itemBottom > listBottom) list.scrollTop = itemBottom - list.clientHeight
        }
    }, [selectedIndex, isVisible])

    // Close on outside events
    useEffect(() => {
        const handleWindowEvents = (e: Event) => {
            if (isVisible && listRef.current && !listRef.current.contains(e.target as Node)) {
                setIsVisible(false)
            }
        }
        if (isVisible) {
            window.addEventListener('scroll', handleWindowEvents, true)
            window.addEventListener('resize', handleWindowEvents)
            window.addEventListener('click', handleWindowEvents)
        }
        return () => {
            window.removeEventListener('scroll', handleWindowEvents, true)
            window.removeEventListener('resize', handleWindowEvents)
            window.removeEventListener('click', handleWindowEvents)
        }
    }, [isVisible])

    // --- Highlighting ---
    const renderHighlights = (text: string) => {
        if (!text) return null

        // 먼저 줄 단위로 분리하여 주석 처리
        const lines = text.split('\n')

        return (
            <Fragment>
                {lines.map((line, lineIndex) => {
                    const isComment = line.trimStart().startsWith('#')
                    const isLastLine = lineIndex === lines.length - 1

                    // 주석 줄인 경우 전체를 회색 배경으로
                    if (isComment) {
                        return (
                            <Fragment key={lineIndex}>
                                <span className="rounded-sm bg-muted text-muted-foreground">{line}</span>
                                {!isLastLine && '\n'}
                            </Fragment>
                        )
                    }

                    // 일반 줄: 기존 구문 하이라이팅 적용
                    // Syntax regex: 
                    // 1. Weights: 1.2::tag:: OR -0.5::tag::
                    // 2. Fragments: <fragment>
                    const regex = /(-?[\d.]+::.*?::)|(<[^>]+>)/g
                    const parts = line.split(regex)

                    return (
                        <Fragment key={lineIndex}>
                            {parts.map((part, i) => {
                                if (part === undefined) return null
                                let styleClass = ""
                                if (/^-?[\d.]+::.*::$/.test(part)) {
                                    styleClass = part.startsWith('-')
                                        ? "rounded-sm bg-info/20"
                                        : "rounded-sm bg-destructive/20"
                                } else if (/^<[^>]+>$/.test(part)) {
                                    styleClass = "rounded-sm bg-success/20"
                                }
                                return <span key={i} className={styleClass}>{part}</span>
                            })}
                            {!isLastLine && '\n'}
                        </Fragment>
                    )
                })}
            </Fragment>
        )
    }

    // --- Styles ---
    // Force sync styles for both Pre (generated by Editor) and Textarea


    return (
        <div
            className={cn(
                "prompt-editor-wrapper group relative flex h-full w-full flex-col overflow-hidden rounded-control border border-input bg-canvas focus-within:ring-2 focus-within:ring-ring",
                className
            )}
        >
            <style>{`
                .prompt-editor-wrapper pre,
                .prompt-editor-wrapper textarea {
                    font-family: "Pretendard", "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif !important;
                    line-height: 1.5 !important;
                    font-size: inherit !important;
                    letter-spacing: normal !important;
                    font-variant-ligatures: none !important;
                    tab-size: 4 !important;
                    white-space: pre-wrap !important;
                    overflow-wrap: break-word !important;
                    word-break: normal !important;
                    box-sizing: border-box !important;
                }
                .prompt-editor-wrapper textarea {
                    overflow: hidden !important;
                    height: 100% !important; /* Prevent internal scroll by matching container height */
                }
                /* The editor makes typed text transparent so the synchronized highlight layer
                   can render it. Placeholders have no highlight counterpart, so restore their
                   fill explicitly to keep empty prompt guidance fully visible in WebView. */
                .prompt-editor-wrapper textarea::placeholder {
                    color: oklch(var(--muted-foreground)) !important;
                    -webkit-text-fill-color: oklch(var(--muted-foreground)) !important;
                    opacity: 1 !important;
                }
            `}</style>

            {/* Scrollable Container */}
            <div
                ref={containerRef}
                className="flex-1 w-full relative overflow-y-auto"
                style={{ scrollBehavior: 'smooth' }} // Optional smooth scroll
            >
                <Editor
                    value={internalValue}
                    onValueChange={handleValueChange}
                    highlight={renderHighlights}
                    padding={12}
                    textareaId={editorId}

                    // Core Editor Style
                    style={{
                        ...TYPOGRAPHY,
                        fontSize: style?.fontSize || 'inherit',
                        minHeight: '100%',
                        height: 'auto',
                        overflow: 'visible',
                    }}

                    // Wrapper Class
                    className="min-h-full w-full"

                    // Textarea Class
                    // Styles are now handled by global CSS injection above
                    textareaClassName="focus:outline-none bg-transparent min-h-full resize-none"

                    // Event wiring
                    onFocus={(e) => {
                        textareaRef.current = e.target as HTMLTextAreaElement
                        warmTagIndex()
                    }}
                    onBlur={flushPendingChange}
                    onClick={(e) => {
                        textareaRef.current = e.target as HTMLTextAreaElement
                        scrollToCaret()
                    }}
                    onKeyUp={scrollToCaret} // Handle arrow keys
                    onKeyDown={handleKeyDown}
                    onContextMenu={(event) => {
                        if (!(event.target instanceof HTMLTextAreaElement)) return
                        textareaRef.current = event.target
                        // The context action works from the exact visible text,
                        // so commit any debounced edit before its owner snapshots it.
                        flushPendingChange()
                        onPromptContextMenu?.({
                            value: event.target.value,
                            selectionStart: event.target.selectionStart,
                            selectionEnd: event.target.selectionEnd,
                        })
                    }}

                    placeholder={placeholder}
                    aria-label={ariaLabel ?? placeholder}
                    readOnly={props.readOnly}
                    disabled={props.disabled}
                    {...props}
                />
            </div>

            {/* Autocomplete Dropdown */}
            {isVisible && suggestions.length > 0 && createPortal(
                <div
                    ref={listRef}
                    className="fixed z-[9999] w-64 overflow-hidden rounded-panel border-0 bg-popover text-popover-foreground shadow-overlay motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95"
                    role="listbox"
                    aria-label="Prompt suggestions"
                    style={{
                        top: coords.top,
                        left: coords.left,
                        maxHeight: `${Math.min(300, Math.max(120, window.innerHeight - coords.top - 8))}px`,
                        overflowY: 'auto'
                    }}
                >
                    <div className="p-1">
                        {suggestions.map((item, index) => (
                            <div
                                key={item.value + index}
                                role="option"
                                aria-selected={index === selectedIndex}
                                className={cn(
                                    "flex min-h-11 cursor-pointer select-none items-center justify-between rounded-control px-3 py-2 text-sm transition-colors",
                                    index === selectedIndex ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                                )}
                                onMouseDown={(e) => {
                                    e.preventDefault()
                                    insertSuggestion(item)
                                }}
                            >
                                <div className="flex flex-col overflow-hidden">
                                    <span className="truncate font-semibold">
                                        {item.type === 'fragment' ? `<${item.label}>` : item.label}
                                    </span>
                                    <div className="flex items-center gap-2 text-[11px] opacity-80">
                                        <span className={cn(
                                            "uppercase tracking-wider font-bold",
                                             item.type === 'fragment' ? "text-success" :
                                                item.type === 'artist' ? "text-warning" :
                                                    item.type === 'character' ? "text-success" :
                                                        item.type === 'copyright' ? "text-destructive" :
                                                            "text-info"
                                        )}>
                                            {item.type}
                                        </span>
                                        <span>
                                            {item.type === 'fragment'
                                                ? `${item.count} lines`
                                                : (item.count ?? 0) >= 1000 ? ((item.count ?? 0) / 1000).toFixed(1) + 'k' : item.count}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>,
                document.body
            )}
        </div>
    )
}
