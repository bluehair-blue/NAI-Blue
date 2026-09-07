/** Formats a planned key only; this does not assert that the bucket or URL is publicly accessible. */
export function plannedR2PublicUrl(publicMode: string, publicBaseUrl: string | null, key: string): string | null {
    if (publicMode === 'private' || !publicBaseUrl) return null
    try {
        const base = new URL(publicBaseUrl)
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return null
        return `${base.href.replace(/\/+$/u, '')}/${key.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
    } catch {
        return null
    }
}
