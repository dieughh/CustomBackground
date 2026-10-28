import { defineAddon } from '@pulsesync/addon-sdk'
import addonConfig from '../addon.config.mjs'
import { loadBackgroundImage } from './background-image'
import './style.css'

declare global {
    interface Window {
        pulsesyncApi?: any
        __bgDebug?: any
        __cs_init?: boolean
        __csVerify?: (key: any) => boolean
        __csGetKey?: () => any
        __currentPulseEnergy?: number
        settings?: any
    }
}

class CustomBackgroundCore {
    private ADAPTIVE_GLOBAL_KEY = 'adaptive_global_enabled'
    private ADAPTIVE_VIBE_KEY = 'adaptive_vibe_enabled'
    public lastCoverUrl: string | null = null
    private hasPlayerCover = false
    private mediaRevisions = new WeakMap<HTMLElement, number>()
    private imageLoads = new WeakMap<HTMLImageElement, Promise<boolean>>()
    private mediaAbort = new AbortController()
    private cssValues = new Map<string, string>()
    public currentSettings: Record<string, any> = {
        globalBlur: 0,
        globalBrightness: 0.4,
        globalPixelate: 0,
        globalOpacity: 100,
        vignetteIntensity: 0,
        vibeBlur: 0,
        vibeBrightness: 0.4,
        vibePixelate: 0,
        vibeOpacity: 100,
        vibeVignetteIntensity: 0,
    }
    private isFrozen = false
    private pausedVideos = new Set<HTMLVideoElement>()
    private readonly onVisibilityChange = () => this.setFrozen(document.hidden)

    private setFrozen(frozen: boolean) {
        if (!this.isStarted || this.isFrozen === frozen) return
        this.isFrozen = frozen
        const containers = document.querySelectorAll<HTMLElement>('#global-background-container, #vibe-background-container')
        containers.forEach(container => container.toggleAttribute('data-cbg-frozen', frozen))
        if (frozen) {
            this.closeDropdown()
            this.menuObserver?.disconnect()
            if (this.menuRefreshTimer !== null) clearTimeout(this.menuRefreshTimer)
            this.menuRefreshTimer = null
            clearTimeout(this.resizeTimer)
            this.stopSmartCoverTracking()
            clearInterval(this.chromaInterval)
            this.chromaInterval = null
            if (this.chromaSyncPulseRAF !== null) cancelAnimationFrame(this.chromaSyncPulseRAF)
            this.chromaSyncPulseRAF = null
            for (const state of Object.values(this.pixelState)) {
                if (state.animFrame !== null) clearTimeout(state.animFrame)
                state.animFrame = null
            }
            containers.forEach(container => container.querySelectorAll('video').forEach(video => {
                if (!video.paused) {
                    this.pausedVideos.add(video)
                    video.pause()
                }
            }))
        } else {
            this.menuObserver?.observe(document.body, { childList: true, subtree: true })
            this.updateSettings({}, true)
            const activeSource = (id: string) => document.querySelector(`#${id} .cbg-layer.active`)?.getAttribute('data-cbg-source') || null
            void this.applyGlobalStyle(activeSource('global-background-container') !== this.currentGlobal.url)
            void this.initVibeMedia(activeSource('vibe-background-container') !== this.currentVibe.url)
            for (const video of this.pausedVideos) {
                if (video.isConnected) void video.play().catch(() => {})
            }
            this.pausedVideos.clear()
            this.applyAllPixelEffects()
            this.startSmartCoverTracking()
            this.startChromaMonitoring()
        }
    }

    private globalFileCache: { url: string; type: string } | null = null
    private vibeFileCache: { url: string; type: string } | null = null
    private currentGlobal = { url: null as string | null, isVideo: false, isGif: false }
    private currentVibe = { url: null as string | null, isVideo: false, isGif: false }
    private resetTimers: { global: any; vibe: any } = { global: null, vibe: null }
    private globalBlobUrls = new Set<string>()
    private vibeBlobUrls = new Set<string>()

    private globalUpdatePending = false
    private vibeUpdatePending = false

    private previewPanel: HTMLElement | null = null
    private previewFrame: number | null = null
    private globalPreviewLayers: HTMLElement[] = []
    private vibePreviewLayers: HTMLElement[] = []

    private pixelState = {
        global: { canvas: null as HTMLCanvasElement | null, animFrame: null as number | null, pixelSize: 0 },
        vibe: { canvas: null as HTMLCanvasElement | null, animFrame: null as number | null, pixelSize: 0 },
    }

    private resizeTimer: any = null
    private readonly onResize = () => {
        clearTimeout(this.resizeTimer)
        this.resizeTimer = setTimeout(() => {
            if (this.isStarted && !this.isFrozen) this.applyAllPixelEffects()
        }, 200)
    }
    private coverInterval: any = null
    private retryTimer: any = null
    private retryAttempts = 0
    private MAX_RETRIES = 5
    private RETRY_DELAYS = [200, 400, 800, 1500, 3000]

    private menuObserver: MutationObserver | null = null
    private menuRefreshTimer: ReturnType<typeof setTimeout> | null = null
    private currentMousedownHandler: ((e: MouseEvent) => void) | null = null

    private chromaSyncPulseRAF: number | null = null
    private chromaInterval: any = null
    private isStarted = false

    private getPixelCanvas(container: HTMLElement, id: string): HTMLCanvasElement {
        let canvas = document.getElementById(id) as HTMLCanvasElement | null
        if (!canvas) {
            canvas = document.createElement('canvas')
            canvas.id = id
            canvas.className = 'cbg-pixel-canvas'
            canvas.style.position = 'absolute'
            canvas.style.inset = '0'
            canvas.style.width = '100%'
            canvas.style.height = '100%'
            canvas.style.zIndex = '1'
            canvas.style.pointerEvents = 'none'
            canvas.style.imageRendering = 'pixelated'
            canvas.style.display = 'none'
            container.appendChild(canvas)
        }
        return canvas
    }

    private drawPixelatedFrame(canvas: HTMLCanvasElement, sourceElement: HTMLVideoElement | HTMLImageElement, pixelSize: number) {
        if (!canvas || !sourceElement || pixelSize <= 0) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const w = canvas.clientWidth
        const h = canvas.clientHeight
        if (w === 0 || h === 0) return

        const smallW = Math.max(1, Math.floor(w / pixelSize))
        const smallH = Math.max(1, Math.floor(h / pixelSize))

        const sourceW = sourceElement instanceof HTMLVideoElement ? sourceElement.videoWidth : sourceElement.naturalWidth
        const sourceH = sourceElement instanceof HTMLVideoElement ? sourceElement.videoHeight : sourceElement.naturalHeight
        if (!sourceW || !sourceH) return
        // Match object-fit: cover, including the centered crop of wide/tall media.
        const scale = Math.max(w / sourceW, h / sourceH)
        const cropW = w / scale
        const cropH = h / scale
        try {
            if (canvas.width !== smallW) canvas.width = smallW
            if (canvas.height !== smallH) canvas.height = smallH
            ctx.imageSmoothingEnabled = false
            ctx.drawImage(sourceElement, (sourceW - cropW) / 2, (sourceH - cropH) / 2, cropW, cropH, 0, 0, smallW, smallH)
        } catch {}
    }

    private stopPixelAnimation(key: 'global' | 'vibe') {
        const state = this.pixelState[key]
        if (state.animFrame) {
            clearTimeout(state.animFrame)
            state.animFrame = null
        }
        if (state.canvas) {
            state.canvas.style.display = 'none'
        }
        document.querySelectorAll(`#${key === 'global' ? 'global' : 'vibe'}-background-container .cbg-pixel-canvas`).forEach(canvas => canvas.remove())
        state.pixelSize = 0
    }

    private startCanvasAnimation(key: 'global' | 'vibe', container: HTMLElement, canvasId: string, pixelSize: number) {
        const state = this.pixelState[key]
        this.stopPixelAnimation(key)
        if (pixelSize <= 0 || !container) return

        document.getElementById(canvasId)?.remove()
        state.pixelSize = pixelSize

        const renderedImages = new WeakSet<HTMLImageElement>()
        const drawLoop = () => {
            state.animFrame = null
            if (!this.isStarted || this.isFrozen || !container.isConnected) return
            let needsFrame = false
            container.querySelectorAll('.cbg-layer').forEach((layer, index) => {
                const media = layer.querySelector('.cbg-media') as HTMLVideoElement | HTMLImageElement | null
                if (!media) return
                if (media instanceof HTMLVideoElement) needsFrame = true
                if (media instanceof HTMLImageElement && renderedImages.has(media)) return
                const canvas = this.getPixelCanvas(layer as HTMLElement, `${canvasId}-${index}`)
                state.canvas = canvas
                canvas.style.display = 'block'
                this.drawPixelatedFrame(canvas, media, pixelSize)
                if (media instanceof HTMLImageElement && media.complete && media.naturalWidth > 0) renderedImages.add(media)
                else if (media instanceof HTMLImageElement && !media.complete) needsFrame = true
            })
            // Static covers are painted once; only video/loading media need polling.
            if (needsFrame) state.animFrame = window.setTimeout(drawLoop, document.hidden ? 1000 : 100)
        }
        drawLoop()
    }

    public applyAllPixelEffects() {
        if (this.isFrozen) return
        const globalContainer = document.getElementById('global-background-container')
        const vibeContainer = document.getElementById('vibe-background-container')
        const globalPixel = Number(this.currentSettings.globalPixelate ?? 0)
        const vibePixel = Number(this.currentSettings.vibePixelate ?? 0)

        if (globalContainer) {
            if (globalPixel > 0) {
                this.startCanvasAnimation('global', globalContainer, 'global-pixel-canvas', globalPixel)
            } else this.stopPixelAnimation('global')
        }

        if (vibeContainer) {
            if (vibePixel > 0) {
                this.startCanvasAnimation('vibe', vibeContainer, 'vibe-pixel-canvas', vibePixel)
            } else this.stopPixelAnimation('vibe')
        }
    }

    private _setMedia(container: HTMLElement, url: string | null | undefined, isVideo: boolean | undefined) {
        container.setAttribute('data-cbg-source', url ?? '')
        container.innerHTML = ''
        if (url) {
            if (isVideo) {
                const video = document.createElement('video')
                video.src = url
                video.autoplay = !this.isFrozen
                video.loop = true
                video.muted = true
                video.playsInline = true
                video.style.width = '100%'
                video.style.height = '100%'
                video.style.objectFit = 'cover'
                video.style.borderRadius = '6px'
                container.appendChild(video)
                if (!this.isFrozen) video.play().catch(() => {})
            } else {
                const img = document.createElement('img')
                img.style.width = '100%'
                img.style.height = '100%'
                img.style.objectFit = 'cover'
                img.style.borderRadius = '6px'
                container.appendChild(img)
                const ready = loadBackgroundImage(img, url, this.mediaAbort.signal)
                this.imageLoads.set(img, ready)
                void ready.then(loaded => { if (!loaded && img.parentElement === container) img.remove() })
            }
        } else {
            container.innerHTML =
                '<div style="font-size:11px;color:#888;display:flex;align-items:center;justify-content:center;height:100%;">не установлен</div>'
        }
    }

    private createPreviewPanel() {
        if (this.previewPanel) return this.previewPanel
        this.previewPanel = document.createElement('div')
        this.previewPanel.id = 'bg-preview-panel'
        document.getElementById('bg-menu-dropdown')!.appendChild(this.previewPanel)
        this.previewPanel.innerHTML = `
            <div class="preview-section" id="preview-global">
                <div class="preview-label">Глобальный фон</div>
                <div class="preview-layer-container">
                    <div class="preview-layer active"></div>
                    <div class="preview-layer"></div>
                </div>
            </div>
            <div class="preview-section" id="preview-vibe">
                <div class="preview-label">Фон Волны</div>
                <div class="preview-layer-container">
                    <div class="preview-layer active"></div>
                    <div class="preview-layer"></div>
                </div>
            </div>
        `
        const globalContainer = this.previewPanel.querySelector('#preview-global .preview-layer-container')!
        this.globalPreviewLayers = Array.from(globalContainer.querySelectorAll('.preview-layer')) as HTMLElement[]
        const vibeContainer = this.previewPanel.querySelector('#preview-vibe .preview-layer-container')!
        this.vibePreviewLayers = Array.from(vibeContainer.querySelectorAll('.preview-layer')) as HTMLElement[]
        return this.previewPanel
    }

    private crossfadePreview(layers: HTMLElement[], mediaInfo: { url: string | null; isVideo: boolean }) {
        const active = layers.find((l) => l.classList.contains('active'))
        const inactive = layers.find((l) => !l.classList.contains('active'))
        if (!active || !inactive) return
        if (active.querySelector('img, video')?.getAttribute('src') === mediaInfo.url) return

        this._setMedia(inactive, mediaInfo?.url, mediaInfo?.isVideo)
        active.classList.remove('active')
        inactive.classList.add('active')

        setTimeout(() => {
            if (!active.classList.contains('active')) {
                active.innerHTML = ''
            }
        }, 400)
    }

    public updatePreviewPanel() {
        if (!this.previewPanel || !document.getElementById('bg-menu-dropdown')?.hasAttribute('data-cbg-open')) return
        this.crossfadePreview(this.globalPreviewLayers, { url: this.currentGlobal.url, isVideo: this.currentGlobal.isVideo })
        this.crossfadePreview(this.vibePreviewLayers, { url: this.currentVibe.url, isVideo: this.currentVibe.isVideo })
    }

    public positionPreviewPanel(anchorEl: HTMLElement) {
        if (!this.previewPanel || !anchorEl) return
        const rect = anchorEl.getBoundingClientRect()
        const panelWidth = this.previewPanel.offsetWidth || 160
        const gap = 12
        if (rect.right + gap + panelWidth <= window.innerWidth) {
            this.previewPanel.style.left = rect.width + gap + 'px'
            this.previewPanel.style.right = 'auto'
        } else {
            this.previewPanel.style.right = rect.width + gap + 'px'
            this.previewPanel.style.left = 'auto'
        }
        this.previewPanel.style.top = '0'
    }

    public showPreviewPanel(anchorEl: HTMLElement) {
        if (!anchorEl.isConnected || !anchorEl.hasAttribute('data-cbg-open')) return
        if (!this.previewPanel) this.createPreviewPanel()
        this.updatePreviewPanel()
        this.positionPreviewPanel(anchorEl)
    }

    public hidePreviewPanel() {
        if (this.previewFrame !== null) cancelAnimationFrame(this.previewFrame)
        this.previewFrame = null
        // Hidden previews must not keep duplicate videos decoding in the background.
        for (const layer of [...this.globalPreviewLayers, ...this.vibePreviewLayers]) layer.innerHTML = ''
    }

    private closeDropdown() {
        this.hidePreviewPanel()
        document.getElementById('bg-menu-dropdown')?.removeAttribute('data-cbg-open')
        document.getElementById('bg-menu-button')?.setAttribute('aria-expanded', 'false')
    }

    private openDB(dbName: string): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(dbName, 1)
            req.onupgradeneeded = () => {
                const db = req.result
                if (!db.objectStoreNames.contains('media')) db.createObjectStore('media')
            }
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
        })
    }

    private async saveFile(dbName: string, file: File) {
        if (!file) return
        const db = await this.openDB(dbName)
        const tx = db.transaction('media', 'readwrite')
        db.close()
        const store = tx.objectStore('media')
        store.put(file, 'current_bg')
        await new Promise<void>((resolve) => {
            tx.oncomplete = () => resolve()
        })
        if (dbName === 'GlobalBackgroundDB') {
            this.globalFileCache = null
            await this.applyGlobalStyle(true)
        } else {
            this.vibeFileCache = null
            await this.initVibeMedia(true)
        }
    }

    private async loadFile(dbName: string): Promise<File | Blob | null> {
        try {
            const db = await this.openDB(dbName)
            return new Promise((resolve) => {
                const tx = db.transaction('media', 'readonly')
                db.close()
                const store = tx.objectStore('media')
                const req = store.get('current_bg')
                req.onsuccess = () => resolve(req.result || null)
                req.onerror = () => resolve(null)
            })
        } catch {
            return null
        }
    }

    private async deleteFile(dbName: string): Promise<void> {
        return new Promise(async (resolve) => {
            try {
                const db = await this.openDB(dbName)
                const tx = db.transaction('media', 'readwrite')
                db.close()
                const store = tx.objectStore('media')
                store.delete('current_bg')
                tx.oncomplete = () => resolve()
                tx.onerror = () => resolve()
            } catch {
                resolve()
            }
        })
    }

    // Мгновенное применение настроек через CSS-переменные (без пересоздания элементов и моргания)
    public updateSettings(newSettings: Record<string, any>, fastOnly = false) {
        if (!newSettings) return
        const parsed: Record<string, any> = {}
        for (const [k, v] of Object.entries(newSettings)) {
            parsed[k] = (v as any)?.value ?? v
        }
        const pixelsChanged = ['globalPixelate', 'vibePixelate'].some(key =>
            key in parsed && Number(parsed[key]) !== Number(this.currentSettings[key]),
        )
        this.currentSettings = { ...this.currentSettings, ...parsed }
        if (this.isFrozen) return

        const gBlur = Number(this.currentSettings.globalBlur ?? 0)
        const gBright = Number(this.currentSettings.globalBrightness ?? 0.4)
        const gOpacity = Number(this.currentSettings.globalOpacity ?? 100)
        const vBlur = Number(this.currentSettings.vibeBlur ?? 0)
        const vBright = Number(this.currentSettings.vibeBrightness ?? 0.4)
        const vOpacity = Number(this.currentSettings.vibeOpacity ?? 100)
        const vig = Number(this.currentSettings.vignetteIntensity ?? 0)
        const vVig = Number(this.currentSettings.vibeVignetteIntensity ?? 0)

        const css: Record<string, string> = {
            '--global-blur': `${gBlur}px`,
            '--global-brightness': String(gBright),
            '--global-opacity': String(gOpacity / 100),
            '--vibe-blur': `${vBlur}px`,
            '--vibe-brightness': String(vBright),
            '--vibe-opacity': String(vOpacity / 100),
            '--vignette-opacity': (vig / 100).toFixed(2),
            '--vibe-vignette-opacity': (vVig / 100).toFixed(2),
        }
        for (const [name, value] of Object.entries(css)) {
            if (this.cssValues.get(name) === value) continue
            document.documentElement.style.setProperty(name, value)
            this.cssValues.set(name, value)
        }

        if (!fastOnly || pixelsChanged) {
            this.applyAllPixelEffects()
        }
    }

    private setAdaptiveGlobalEnabled(enabled: boolean) {
        localStorage.setItem(this.ADAPTIVE_GLOBAL_KEY, enabled ? '1' : '0')
        this.updateAdaptiveButtons()
    }
    private isAdaptiveGlobalEnabled(): boolean {
        return localStorage.getItem(this.ADAPTIVE_GLOBAL_KEY) === '1'
    }
    private setAdaptiveVibeEnabled(enabled: boolean) {
        localStorage.setItem(this.ADAPTIVE_VIBE_KEY, enabled ? '1' : '0')
        this.updateAdaptiveButtons()
    }
    private isAdaptiveVibeEnabled(): boolean {
        return localStorage.getItem(this.ADAPTIVE_VIBE_KEY) === '1'
    }
    private updateAdaptiveButtons() {
        const btnG = document.getElementById('btn-toggle-adaptive-global')
        const btnV = document.getElementById('btn-toggle-adaptive-vibe')
        if (btnG) btnG.classList.toggle('active', this.isAdaptiveGlobalEnabled())
        if (btnV) btnV.classList.toggle('active', this.isAdaptiveVibeEnabled())
    }

    public getHighResCoverUrl(url: string | null): string | null {
        if (!url) return null
        const normalized = url.startsWith('http') ? url : `https://${url}`
        return normalized.replace(/%%/g, '1000x1000').replace(/\/\d+x\d+(?=[/?&]|$)/, '/1000x1000')
    }

    private getBestSrcFromSrcSet(img: HTMLImageElement): string {
        const srcset = img.getAttribute('srcset')
        if (!srcset) return img.src
        const sources = srcset.split(',').map((s) => s.trim().split(/\s+/))
        for (const [url, desc] of sources) {
            if (desc === '2x' || desc === '800w') return url
        }
        return sources[sources.length - 1][0]
    }

    public handleCoverUrlChange(newUrl: string | null, fromPlayer = false) {
        if (fromPlayer) this.hasPlayerCover = true
        if (!newUrl) return
        const highRes = this.getHighResCoverUrl(newUrl)
        if (!highRes || highRes === this.lastCoverUrl) return
        this.lastCoverUrl = highRes
        clearTimeout(this.retryTimer)
        this.retryTimer = null
        if (this.isFrozen) return
        if (this.isAdaptiveGlobalEnabled()) this.applyGlobalStyle(true)
        if (this.isAdaptiveVibeEnabled()) this.initVibeMedia(true)
        this.updatePreviewPanel()
    }

    private isArtistImage(img: HTMLImageElement): boolean {
        const cls = img.className || ''
        return /ArtistCover|artist|avatar/i.test(cls)
    }

    public getBestCoverFromDOM(): string | null {
        try {
            const state = window.pulsesyncApi?.getState?.()
            if (state) {
                const mp =
                    state.currentMediaPlayer?.observableValue ||
                    state.currentMediaPlayer?.value ||
                    state.currentMediaPlayer
                if (mp) {
                    const pair = mp.currentContextEntityPair
                    const entity = pair?.entity
                    const meta = entity?.entityData?.meta || entity?.meta
                    if (meta) {
                        const coverUri = meta.coverUri || meta.ogImage || meta.albums?.[0]?.coverUri
                        if (coverUri && typeof coverUri === 'string') {
                            const url = coverUri.startsWith('http') ? coverUri : 'https://' + coverUri
                            return url.replace(/%%/g, '1000x1000')
                        }
                    }
                    const directCover = entity?.coverUri || entity?.ogImage
                    if (directCover) {
                        const url = directCover.startsWith('http') ? directCover : 'https://' + directCover
                        return url.replace(/%%/g, '1000x1000')
                    }
                }
            }
        } catch {}

        const swappedCover = document.querySelector('img[data-cs-alt-home-image-swapped="1"]') as HTMLImageElement | null
        if (swappedCover) {
            const url = this.getBestSrcFromSrcSet(swappedCover)
            if (url) return url
        }

        const playerBar =
            document.querySelector('[data-test-id="PLAYER_BAR"]') ||
            document.querySelector('[class*="PlayerBarDesktop"]') ||
            document.querySelector('[class*="player_bar"]')
        if (playerBar) {
            const playerImg = playerBar.querySelector('img[src*="avatars.yandex.net"]') as HTMLImageElement | null
            if (playerImg) {
                const url = this.getBestSrcFromSrcSet(playerImg)
                if (url) return url
            }
        }

        const albumCoverImg = document.querySelector('[class*="AlbumCover_cover"]') as HTMLImageElement | null
        if (albumCoverImg) {
            const url = this.getBestSrcFromSrcSet(albumCoverImg)
            if (url) return url
        }

        const fullscreenModal = document.querySelector('[data-test-id="FULLSCREEN_PLAYER_MODAL"]')
        if (fullscreenModal) {
            const fullImg = fullscreenModal.querySelector('img[data-test-id="ENTITY_COVER_IMAGE"]') as HTMLImageElement | null
            if (fullImg && fullImg.src.includes('avatars.yandex.net')) return fullImg.src
        }

        const allImgs = document.querySelectorAll('img[src*="avatars.yandex.net"]')
        let bestImg: HTMLImageElement | null = null
        let bestArea = 0
        let isBestAlbumCover = false

        for (const el of Array.from(allImgs)) {
            const img = el as HTMLImageElement
            if (img === swappedCover) continue
            if (this.isArtistImage(img)) continue
            const w = img.naturalWidth || img.clientWidth || 0
            const h = img.naturalHeight || img.clientHeight || 0
            if (w < 100 || h < 100) continue
            const area = w * h
            const hasAlbumClass = /AlbumCover/i.test(img.className)
            if (isBestAlbumCover && !hasAlbumClass) continue
            if (area > bestArea || (hasAlbumClass && !isBestAlbumCover)) {
                bestArea = area
                bestImg = img
                isBestAlbumCover = hasAlbumClass
            }
        }

        if (bestImg) return this.getBestSrcFromSrcSet(bestImg)
        return null
    }

    public scheduleCoverCheck(delayMs = 1000) {
        if (this.hasPlayerCover) return
        if (!this.isStarted || this.isFrozen || this.retryTimer) return
        this.retryAttempts = 0
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null
            this.runRetry()
        }, delayMs)
    }

    private runRetry() {
        if (!this.isStarted || this.isFrozen || this.hasPlayerCover) return
        const url = this.getBestCoverFromDOM()
        if (url) {
            const highRes = this.getHighResCoverUrl(url)
            if (highRes !== this.lastCoverUrl) {
                this.handleCoverUrlChange(url)
                return
            }
        }
        if (this.retryAttempts < this.MAX_RETRIES) {
            const delay = this.RETRY_DELAYS[this.retryAttempts] || 3000
            this.retryTimer = setTimeout(() => {
                this.retryTimer = null
                this.retryAttempts++
                this.runRetry()
            }, delay)
        }
    }

    private startSmartCoverTracking() {
        this.stopSmartCoverTracking()
        if (this.isFrozen) return
        this.scheduleCoverCheck()
        // Track changes already arrive through useCurrentTrack. Poll only as a
        // fallback for cover replacements; animated DOM mutations are too frequent.
        this.coverInterval = setInterval(() => {
            if (!this.isFrozen) this.scheduleCoverCheck()
        }, 5000)
    }

    private stopSmartCoverTracking() {
        clearInterval(this.coverInterval)
        this.coverInterval = null
        clearTimeout(this.retryTimer)
        this.retryTimer = null
    }

    private initCoverTracking() {
        this.startSmartCoverTracking()
    }

    private cleanupCoverTracking() {
        this.stopSmartCoverTracking()
    }

    private ensureLayers(container: HTMLElement) {
        const layers = container.querySelectorAll('.cbg-layer')
        if (layers.length < 2) {
            container.innerHTML = ''
            const l1 = document.createElement('div')
            l1.className = 'cbg-layer active'
            const l2 = document.createElement('div')
            l2.className = 'cbg-layer'
            container.appendChild(l1)
            container.appendChild(l2)
        }
        if (!container.querySelector('.cbg-layer.active')) {
            const [first, second] = Array.from(container.querySelectorAll('.cbg-layer'))
            first?.classList.add('active')
            second?.classList.remove('active')
        }
        if (!container.querySelector('.cbg-vignette')) {
            const vignette = document.createElement('div')
            vignette.className = 'cbg-vignette'
            container.appendChild(vignette)
        }
        return container
    }

    private createContainer(id: string, prependTo: Element | null): HTMLElement | null {
        let container = document.getElementById(id)
        if (!container && prependTo) {
            container = document.createElement('div')
            container.id = id
            prependTo.prepend(container)
            this.ensureLayers(container)
        } else if (container) {
            this.ensureLayers(container)
        }
        return container
    }

    public getGlobalContainer() {
        return this.createContainer('global-background-container', document.body)
    }

    public getVibeContainer() {
        const oldContainer = document.getElementById('vibe-background-container')
        // Всегда используем современный режим развертывания под новую волну
        const vibe = (document.querySelector('[class*="VibePage_root"]') ||
            document.querySelector('[data-test-id="MAIN_PAGE"]')) as HTMLElement | null
        if (!vibe) {
            oldContainer?.remove()
            return null
        }
        vibe.style.position = 'relative'
        return this.createContainer('vibe-background-container', vibe)
    }

    private cleanupOldBlobUrls(urlSet: Set<string>, newUrl: string | null) {
        for (const url of urlSet) {
            if (url !== newUrl) URL.revokeObjectURL(url)
        }
        urlSet.clear()
        if (newUrl) urlSet.add(newUrl)
    }

    public useDomCoverFallback() {
        this.hasPlayerCover = false
        this.scheduleCoverCheck(0)
    }

    private async crossfade(container: HTMLElement, url: string, isVideo: boolean) {
        if (!container || !url) return false
        const revision = (this.mediaRevisions.get(container) ?? 0) + 1
        this.mediaRevisions.set(container, revision)
        this.ensureLayers(container)
        const active = container.querySelector('.cbg-layer.active') as HTMLElement | null
        const inactive = container.querySelector('.cbg-layer:not(.active)') as HTMLElement | null
        if (!active || !inactive) return false
        this._setMedia(inactive, url, isVideo)
        const media = inactive.querySelector('video') || inactive.querySelector('img')
        if (media) media.className = 'cbg-media'
        if (!media) return false
        const ready = await (media instanceof HTMLImageElement ? this.imageLoads.get(media) ?? Promise.resolve(false) : new Promise<boolean>(resolve => {
            if (media instanceof HTMLImageElement && media.complete) {
                resolve(media.naturalWidth > 0)
                return
            }
            if (media instanceof HTMLVideoElement && media.readyState >= 2) {
                resolve(true)
                return
            }
            media.addEventListener(isVideo ? 'loadeddata' : 'load', () => resolve(true), { once: true })
            media.addEventListener('error', () => resolve(false), { once: true })
        }))
        if (!ready || this.isFrozen || !container.isConnected || this.mediaRevisions.get(container) !== revision) return false
        void inactive.offsetWidth
        active.classList.remove('active')
        inactive.classList.add('active')
        setTimeout(() => {
            if (this.mediaRevisions.get(container) !== revision) return
            if (!active.classList.contains('active')) active.innerHTML = ''
        }, 700)
        return true
    }

    private fadeOutClear(container: HTMLElement, timerKey: 'global' | 'vibe') {
        if (!container) return
        this.mediaRevisions.set(container, (this.mediaRevisions.get(container) ?? 0) + 1)
        this.ensureLayers(container)
        const active = container.querySelector('.cbg-layer.active')
        if (active) active.classList.remove('active')
        clearTimeout(this.resetTimers[timerKey])
        this.resetTimers[timerKey] = setTimeout(() => {
            container.querySelectorAll('.cbg-layer').forEach((l) => (l.innerHTML = ''))
            this.resetTimers[timerKey] = null
        }, 600)
    }

    public async applyGlobalStyle(force = false) {
        if (this.isFrozen) return
        if (this.globalUpdatePending) return
        this.globalUpdatePending = true
        try {
            const container = this.getGlobalContainer()
            if (!container) return
            let targetUrl: string | null = null
            let isVideo = false
            let isGif = false

            if (this.isAdaptiveGlobalEnabled()) {
                targetUrl = this.lastCoverUrl
                if (targetUrl) isGif = targetUrl.toLowerCase().endsWith('.gif')
            } else {
                const file = await this.loadFile('GlobalBackgroundDB')
                if (file) {
                    if (!this.globalFileCache) {
                        const newUrl = URL.createObjectURL(file)
                        this.globalFileCache = { url: newUrl, type: file.type }
                        this.cleanupOldBlobUrls(this.globalBlobUrls, newUrl)
                    }
                    targetUrl = this.globalFileCache.url
                    const type = this.globalFileCache.type
                    isVideo = type.startsWith('video/')
                    isGif = type === 'image/gif' || targetUrl.toLowerCase().endsWith('.gif')
                } else if (this.globalFileCache) {
                    this.cleanupOldBlobUrls(this.globalBlobUrls, null)
                    this.globalFileCache = null
                }
            }

            if (targetUrl) {
                clearTimeout(this.resetTimers.global)
                this.resetTimers.global = null
            }
            const shouldUpdate = force || this.currentGlobal.url !== targetUrl
            if (!shouldUpdate) return
            this.currentGlobal.url = targetUrl
            this.currentGlobal.isVideo = isVideo
            this.currentGlobal.isGif = isGif

            if (!targetUrl) {
                this.fadeOutClear(container, 'global')
                this.updatePreviewPanel()
                this.applyAllPixelEffects()
                return
            }
            this.crossfade(container, targetUrl, isVideo)
            this.updatePreviewPanel()
            this.applyAllPixelEffects()
        } finally {
            this.globalUpdatePending = false
        }
    }

    public async initVibeMedia(force = false) {
        if (this.isFrozen) return
        if (this.vibeUpdatePending) return
        this.vibeUpdatePending = true
        try {
            const container = this.getVibeContainer()
            if (!container) return
            let targetUrl: string | null = null
            let isVideo = false
            let isGif = false

            if (this.isAdaptiveVibeEnabled()) {
                targetUrl = this.lastCoverUrl
                if (targetUrl) isGif = targetUrl.toLowerCase().endsWith('.gif')
            } else {
                const file = await this.loadFile('VibeVideoDB')
                if (file) {
                    if (!this.vibeFileCache) {
                        const newUrl = URL.createObjectURL(file)
                        this.vibeFileCache = { url: newUrl, type: file.type }
                        this.cleanupOldBlobUrls(this.vibeBlobUrls, newUrl)
                    }
                    targetUrl = this.vibeFileCache.url
                    const type = this.vibeFileCache.type
                    isVideo = type.startsWith('video/')
                    isGif = type === 'image/gif' || targetUrl.toLowerCase().endsWith('.gif')
                } else if (this.vibeFileCache) {
                    this.cleanupOldBlobUrls(this.vibeBlobUrls, null)
                    this.vibeFileCache = null
                }
            }

            if (targetUrl) {
                clearTimeout(this.resetTimers.vibe)
                this.resetTimers.vibe = null
            }
            const shouldUpdate = force || this.currentVibe.url !== targetUrl
            if (!shouldUpdate) return
            this.currentVibe.url = targetUrl
            this.currentVibe.isVideo = isVideo
            this.currentVibe.isGif = isGif

            if (!targetUrl) {
                this.fadeOutClear(container, 'vibe')
                this.updatePreviewPanel()
                this.applyAllPixelEffects()
                return
            }
            this.crossfade(container, targetUrl, isVideo)
            this.updatePreviewPanel()
            this.applyAllPixelEffects()
        } finally {
            this.vibeUpdatePending = false
        }
    }

    public toggleDropdownFromElement(anchorBtn: HTMLElement) {
        const dd = document.getElementById('bg-menu-dropdown')
        if (!dd) return
        const isActive = dd.hasAttribute('data-cbg-open')
        if (isActive) {
            this.closeDropdown()
        } else {
            const rect = anchorBtn.getBoundingClientRect()
            const ddWidth = 180
            const left = rect.left + rect.width / 2 - ddWidth / 2
            dd.style.top = `${Math.max(8, rect.bottom + 8 > window.innerHeight - 220 ? rect.top - 200 : rect.bottom + 8)}px`
            dd.style.left = `${Math.max(8, left)}px`
            dd.setAttribute('data-cbg-open', '')
            anchorBtn.setAttribute('aria-expanded', 'true')
            this.previewFrame = requestAnimationFrame(() => {
                this.previewFrame = null
                this.showPreviewPanel(dd)
            })
        }
    }

    public ensureDropdownDOM() {
        if (document.getElementById('bg-menu-dropdown')) return
        const dropdown = document.createElement('div')
        dropdown.id = 'bg-menu-dropdown'
        const resetSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M23,12A11,11,0,1,1,12,1a10.9,10.9,0,0,1,5.882,1.7l1.411-1.411A1,1,0,0,1,21,2V6a1,1,0,0,1-1,1H16a1,1,0,0,1-.707-1.707L16.42,4.166A8.9,8.9,0,0,0,12,3a9,9,0,1,0,9,9,1,1,0,0,1,2,0Z"/></svg>`
        dropdown.innerHTML = `
            <div class="bg-menu-row">
                <div class="bg-menu-item" id="btn-set-global">Глобальный фон</div>
                <div class="bg-menu-reset" id="btn-reset-global">${resetSvg}</div>
            </div>
            <div class="bg-menu-row">
                <div class="bg-menu-item" id="btn-set-vibe">Фон Волны</div>
                <div class="bg-menu-reset" id="btn-reset-vibe">${resetSvg}</div>
            </div>
            <div class="bg-menu-item" id="btn-toggle-adaptive-global">Адаптивный фон</div>
            <div class="bg-menu-item" id="btn-toggle-adaptive-vibe">Адаптивная волна</div>
        `
        document.body.appendChild(dropdown)
        this.createPreviewPanel()

        const openPicker = (db: string) => {
            const input = document.createElement('input')
            input.type = 'file'
            input.accept = 'video/mp4,video/webm,image/*'
            input.onchange = (e: any) => {
                const file = e.target?.files?.[0]
                if (file) {
                    if (db === 'GlobalBackgroundDB') this.setAdaptiveGlobalEnabled(false)
                    else this.setAdaptiveVibeEnabled(false)
                    this.saveFile(db, file)
                    setTimeout(() => this.updatePreviewPanel(), 500)
                }
            }
            input.click()
        }

        document.getElementById('btn-set-global')!.onclick = () => openPicker('GlobalBackgroundDB')
        document.getElementById('btn-set-vibe')!.onclick = () => openPicker('VibeVideoDB')
        document.getElementById('btn-reset-global')!.onclick = async () => {
            await this.deleteFile('GlobalBackgroundDB')
            this.globalFileCache = null
            this.currentGlobal = { url: null, isVideo: false, isGif: false }
            await this.applyGlobalStyle(true)
            this.updatePreviewPanel()
            this.applyAllPixelEffects()
        }
        document.getElementById('btn-reset-vibe')!.onclick = async () => {
            await this.deleteFile('VibeVideoDB')
            this.vibeFileCache = null
            this.currentVibe = { url: null, isVideo: false, isGif: false }
            await this.initVibeMedia(true)
            this.updatePreviewPanel()
            this.applyAllPixelEffects()
        }
        document.getElementById('btn-toggle-adaptive-global')!.onclick = async () => {
            const next = !this.isAdaptiveGlobalEnabled()
            if (next) {
                await this.deleteFile('GlobalBackgroundDB')
                this.globalFileCache = null
            }
            this.setAdaptiveGlobalEnabled(next)
            await this.applyGlobalStyle(true)
            if (!next) this.currentGlobal = { url: null, isVideo: false, isGif: false }
            this.updatePreviewPanel()
            this.applyAllPixelEffects()
        }
        document.getElementById('btn-toggle-adaptive-vibe')!.onclick = async () => {
            const next = !this.isAdaptiveVibeEnabled()
            if (next) {
                await this.deleteFile('VibeVideoDB')
                this.vibeFileCache = null
            }
            this.setAdaptiveVibeEnabled(next)
            await this.initVibeMedia(true)
            if (!next) this.currentVibe = { url: null, isVideo: false, isGif: false }
            this.updatePreviewPanel()
            this.applyAllPixelEffects()
        }

        this.currentMousedownHandler = (e: MouseEvent) => {
            // Other addons can dispatch synthetic clicks while updating native menus.
            // Only an actual user click outside should dismiss our menu.
            if (!e.isTrusted) return
            const dd = document.getElementById('bg-menu-dropdown')
            const titleBtn = document.getElementById('bg-menu-button')
            if (
                dd &&
                dd.hasAttribute('data-cbg-open') &&
                !dd.contains(e.target as Node) &&
                (!titleBtn || !titleBtn.contains(e.target as Node))
            ) {
                this.closeDropdown()
            }
        }
        document.addEventListener('mousedown', this.currentMousedownHandler, true)
        this.updateAdaptiveButtons()
    }

    private injectTitleBarButton() {
        const anchorBtn = document.querySelector('.TitleBar_button__9MptL')
        if (!anchorBtn || document.getElementById('bg-menu-button')) return

        this.ensureDropdownDOM()

        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'TitleBar_button__9MptL'
        btn.id = 'bg-menu-button'
        btn.setAttribute('aria-label', 'Смена фонов')
        btn.setAttribute('aria-expanded', 'false')
        btn.setAttribute('aria-controls', 'bg-menu-dropdown')
        btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="TitleBar_icon__8Wji9" style="pointer-events: none;"><path d="M4 4h16v16H4z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="M21 15l-5-5L5 21" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 8.5L19 4" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`
        anchorBtn.parentNode?.insertBefore(btn, anchorBtn)

        btn.addEventListener('click', (e) => {
            e.stopPropagation()
            this.toggleDropdownFromElement(btn)
        })
    }

    private isChromaSyncActive(): boolean {
        return !!(window.__cs_init === true && window.__csVerify && window.__csVerify(window.__csGetKey?.()))
    }

    private getCurrentPulseConfig() {
        if (!this.isChromaSyncActive()) {
            return { amplitude: 0.9, smoothing: 0.9, baseScale: 1.0, enabled: false }
        }
        try {
            let chromaSettings = window.settings
            if (!chromaSettings || typeof chromaSettings.beatAmplitude?.value !== 'number') {
                chromaSettings =
                    window.pulsesyncApi?.getSettings?.('ChromaSync')?.getCurrent?.() ||
                    window.pulsesyncApi?._addonSettings?.['ChromaSync']
            }
            if (chromaSettings && typeof chromaSettings.beatAmplitude?.value === 'number') {
                const amplitudePercent = chromaSettings.beatAmplitude.value
                const smoothingPercent = chromaSettings.beatSmoothing?.value ?? 10
                const baseScale = chromaSettings.beatBaseScale?.value ?? 1.0
                const enabled = chromaSettings.enableBeatPulseEffect?.value !== false
                return {
                    amplitude: (amplitudePercent / 100) * 0.9,
                    smoothing: 1 - smoothingPercent / 100,
                    baseScale,
                    enabled,
                }
            }
        } catch {}
        return { amplitude: 0.9, smoothing: 0.9, baseScale: 1.0, enabled: false }
    }

    private startChromaSyncPulse() {
        if (this.isFrozen || this.chromaSyncPulseRAF) return
        let currentEnergy = 0
        let currentScale = 1.0
        const step = () => {
            const cfg = this.getCurrentPulseConfig()
            if (!cfg.enabled || !this.isChromaSyncActive()) {
                this.stopChromaSyncPulse()
                return
            }
            const rawEnergy = typeof window.__currentPulseEnergy === 'number' ? window.__currentPulseEnergy : 0
            currentEnergy += (rawEnergy - currentEnergy) * 0.3
            const targetScale = cfg.baseScale + currentEnergy * cfg.amplitude
            currentScale += (targetScale - currentScale) * cfg.smoothing
            const gc = document.getElementById('global-background-container')
            if (gc && (this.currentGlobal.url || this.isAdaptiveGlobalEnabled())) {
                gc.style.transform = `scale(${currentScale})`
            }
            const vc = document.getElementById('vibe-background-container')
            if (vc && (this.currentVibe.url || this.isAdaptiveVibeEnabled())) {
                vc.style.transform = `scale(${currentScale})`
            }
            this.chromaSyncPulseRAF = requestAnimationFrame(step)
        }
        this.chromaSyncPulseRAF = requestAnimationFrame(step)
    }

    private stopChromaSyncPulse() {
        if (this.chromaSyncPulseRAF) {
            cancelAnimationFrame(this.chromaSyncPulseRAF)
            this.chromaSyncPulseRAF = null
        }
        const gc = document.getElementById('global-background-container')
        if (gc) gc.style.transform = ''
        const vc = document.getElementById('vibe-background-container')
        if (vc) vc.style.transform = ''
    }

    public async start() {
        if (this.isStarted) return
        if (this.mediaAbort.signal.aborted) this.mediaAbort = new AbortController()
        this.isStarted = true

        this.ensureDropdownDOM()
        this.injectTitleBarButton()

        this.menuObserver = new MutationObserver(() => {
            if (this.menuRefreshTimer !== null) return
            this.menuRefreshTimer = setTimeout(() => {
                this.menuRefreshTimer = null
                if (!this.isStarted || this.isFrozen) return
                if (!document.getElementById('bg-menu-button')) this.injectTitleBarButton()
                if (!document.getElementById('vibe-background-container')) this.initVibeMedia(true)
            }, 500)
        })
        this.menuObserver.observe(document.body, { childList: true, subtree: true })

        // Layout transparency is handled by style.css, without observing classes
        // changed every animation frame by other addons.

        await this.applyGlobalStyle(true)
        await this.initVibeMedia(true)
        this.initCoverTracking()

        this.startChromaMonitoring()
        window.addEventListener('resize', this.onResize)
        document.addEventListener('visibilitychange', this.onVisibilityChange)
        this.onVisibilityChange()

        window.__bgDebug = {
            getLastCoverUrl: () => this.lastCoverUrl,
            getBestCover: () => this.getBestCoverFromDOM(),
            forceCheck: () => this.scheduleCoverCheck(),
        }
    }

    private startChromaMonitoring() {
        if (this.isFrozen || this.chromaInterval !== null) return
        this.chromaInterval = setInterval(() => {
            const cfg = this.getCurrentPulseConfig()
            if (cfg.enabled && this.isChromaSyncActive() && !this.chromaSyncPulseRAF) {
                this.startChromaSyncPulse()
            } else if ((!cfg.enabled || !this.isChromaSyncActive()) && this.chromaSyncPulseRAF) {
                this.stopChromaSyncPulse()
            }
        }, 2000)

    }

    public stop() {
        this.mediaAbort.abort()
        this.isStarted = false
        this.isFrozen = false
        this.pausedVideos.clear()
        document.removeEventListener('visibilitychange', this.onVisibilityChange)
        this.hasPlayerCover = false
        this.closeDropdown()
        if (this.currentMousedownHandler) {
            document.removeEventListener('mousedown', this.currentMousedownHandler, true)
            this.currentMousedownHandler = null
        }
        this.menuObserver?.disconnect()
        if (this.menuRefreshTimer !== null) clearTimeout(this.menuRefreshTimer)
        this.menuRefreshTimer = null
        window.removeEventListener('resize', this.onResize)
        clearTimeout(this.resizeTimer)
        clearTimeout(this.resetTimers.global)
        clearTimeout(this.resetTimers.vibe)
        this.cleanupCoverTracking()
        this.stopChromaSyncPulse()
        clearInterval(this.chromaInterval)
        this.chromaInterval = null
        this.stopPixelAnimation('global')
        this.stopPixelAnimation('vibe')
        this.cleanupOldBlobUrls(this.globalBlobUrls, null)
        this.cleanupOldBlobUrls(this.vibeBlobUrls, null)
        this.globalFileCache = null
        this.vibeFileCache = null
        this.cssValues.clear()
        document.getElementById('bg-menu-button')?.remove()
        document.getElementById('bg-menu-dropdown')?.remove()
        document.getElementById('bg-preview-panel')?.remove()
        this.previewPanel = null
        this.globalPreviewLayers = []
        this.vibePreviewLayers = []
        document.getElementById('global-background-container')?.remove()
        document.getElementById('vibe-background-container')?.remove()
    }
}

const core = new CustomBackgroundCore()

export default defineAddon({
    id: addonConfig.id,
    name: addonConfig.name,
    async start(api) {
        try {
            const initial = api.settings.getCurrent()
            core.updateSettings(initial, true)
            api.settings.onChange((newVal) => {
                core.updateSettings(newVal, true) // мгновенное обновление стилей без перезагрузки медиа
            })
        } catch (e) {
            console.error('[CustomBackground] Ошибка настроек:', e)
        }
        await core.start()
        // Receive track changes directly, independently of the player button slot
        // and React rendering. DOM polling is only a fallback for missing covers.
        let trackRevision = 0
        const updateCover = (track: any) => {
            const cover = track?.coverUri || track?.ogImage || track?.albums?.[0]?.coverUri
            if (typeof cover === 'string' && cover) core.handleCoverUrlChange(cover, true)
            else core.useDomCoverFallback()
        }
        api.player.onTrackChange(track => {
            trackRevision++
            updateCover(track)
        })
        const revision = trackRevision
        const snapshot = await api.player.getSnapshot()
        if (!api.signal.aborted && revision === trackRevision) updateCover(snapshot.track)
    },
    async stop() {
        core.stop()
    },
})
