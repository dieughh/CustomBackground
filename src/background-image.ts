/** Only Yandex music covers have a known interchangeable CDN host. */
export function backgroundImageCandidates(source: string): string[] {
    try {
        const url = new URL(source)
        if (url.protocol === 'https:' && ['avatars.yandex.net', 'avatars.mds.yandex.net'].includes(url.hostname) && url.pathname.startsWith('/get-music-content/')) {
            const alternate = new URL(url)
            alternate.hostname = url.hostname === 'avatars.yandex.net' ? 'avatars.mds.yandex.net' : 'avatars.yandex.net'
            // Prefer the CDN that also serves the native wave artwork.
            return url.hostname === 'avatars.yandex.net' ? [alternate.href, source] : [source, alternate.href]
        }
    } catch { /* Local and uploaded media retain their original URL. */ }
    return [source]
}

export function loadBackgroundImage(image: HTMLImageElement, source: string, signal: AbortSignal): Promise<boolean> {
    const candidates = backgroundImageCandidates(source)
    return new Promise(resolve => {
        let index = 0
        let timer: ReturnType<typeof setTimeout> | undefined
        let finished = false
        const finish = (ready: boolean) => {
            if (finished) return
            finished = true
            clearTimeout(timer)
            image.removeEventListener('load', loaded)
            image.removeEventListener('error', failed)
            signal.removeEventListener('abort', aborted)
            resolve(ready)
        }
        const loaded = () => finish(image.naturalWidth > 0)
        const aborted = () => { finish(false); image.removeAttribute('src') }
        const attempt = () => {
            clearTimeout(timer)
            if (signal.aborted) { aborted(); return }
            if (index >= candidates.length) { finish(false); return }
            image.src = candidates[index++]
            timer = setTimeout(failed, 8000)
        }
        const failed = () => {
            if (finished) return
            if (!image.isConnected) { finish(false); return }
            attempt()
        }
        image.addEventListener('load', loaded)
        image.addEventListener('error', failed)
        signal.addEventListener('abort', aborted, { once: true })
        attempt()
    })
}
