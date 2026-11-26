const BOOT_TIMEOUT_MS = 8000

function setSplashStage(message: string) {
    const subtitle = document.querySelector<HTMLElement>('#splash-screen .splash-subtitle')
    if (subtitle) {
        subtitle.textContent = message
    }
}

function showBootError(message: string) {
    setSplashStage('Startup failed')

    const splash = document.getElementById('splash-screen')
    if (!splash) return

    const existing = document.getElementById('boot-error')
    if (existing) {
        existing.textContent = message
        return
    }

    const errorDiv = document.createElement('div')
    errorDiv.id = 'boot-error'
    errorDiv.style.cssText = [
        'color: oklch(var(--destructive-text))',
        'margin-top: 20px',
        'padding: 10px',
        'max-width: 720px',
        'text-align: center',
        'font: 12px/1.4 monospace',
        'white-space: pre-wrap',
    ].join(';')
    errorDiv.textContent = message
    splash.appendChild(errorDiv)
}

function formatError(value: unknown): string {
    if (value instanceof Error) {
        return `${value.name}: ${value.message}\n${value.stack ?? ''}`.trim()
    }
    return String(value)
}

window.addEventListener('error', event => {
    const target = event.target
    if (target instanceof HTMLElement) {
        const source = target.getAttribute('src') || target.getAttribute('href') || target.tagName
        showBootError(`Resource load failed: ${source}`)
        return
    }

    showBootError(formatError(event.error || event.message))
}, true)

window.addEventListener('unhandledrejection', event => {
    showBootError(formatError(event.reason))
})

setSplashStage('Boot script ready')

const bootTimeout = window.setTimeout(() => {
    showBootError('Main module did not finish loading within 8 seconds.')
}, BOOT_TIMEOUT_MS)

import('./main.tsx')
    .then(() => {
        window.clearTimeout(bootTimeout)
    })
    .catch(error => {
        window.clearTimeout(bootTimeout)
        showBootError(formatError(error))
    })
