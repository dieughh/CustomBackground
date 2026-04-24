(() => {
    const ADAPTIVE_GLOBAL_KEY = 'adaptive_global_enabled';
    const ADAPTIVE_VIBE_KEY = 'adaptive_vibe_enabled';
    let lastCoverUrl = null;
    let addonSettings = {};

    let globalFileCache = null;
    let vibeFileCache = null;
    const currentGlobal = { url: null, isVideo: false, isGif: false };
    const currentVibe = { url: null, isVideo: false, isGif: false };
    const resetTimers = { global: null, vibe: null };
    let globalBlobUrls = new Set();
    let vibeBlobUrls = new Set();

    let globalUpdatePending = false;
    let vibeUpdatePending = false;

    let previewPanel = null;
    let globalPreviewLayers = [];
    let vibePreviewLayers = [];

    const pixelState = {
        global: { canvas: null, animFrame: null, pixelSize: 0 },
        vibe:   { canvas: null, animFrame: null, pixelSize: 0 }
    };

    let resizeTimer = null;

    // ========== ПИКСЕЛИЗАЦИЯ ==========
    function getPixelCanvas(container, id) {
        let canvas = document.getElementById(id);
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.id = id;
            canvas.style.position = 'absolute';
            canvas.style.inset = '0';
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.zIndex = '1';
            canvas.style.pointerEvents = 'none';
            canvas.style.imageRendering = 'pixelated';
            canvas.style.display = 'none';
            container.appendChild(canvas);
        }
        return canvas;
    }

    function drawPixelatedFrame(canvas, sourceElement, pixelSize) {
        if (!canvas || !sourceElement || pixelSize <= 0) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w === 0 || h === 0) return;

        const smallW = Math.max(1, Math.floor(w / pixelSize));
        const smallH = Math.max(1, Math.floor(h / pixelSize));

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = smallW;
        tempCanvas.height = smallH;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.imageSmoothingEnabled = false;
        tempCtx.drawImage(sourceElement, 0, 0, smallW, smallH);

        canvas.width = w;
        canvas.height = h;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tempCanvas, 0, 0, w, h);
    }

    function stopPixelAnimation(key) {
        const state = pixelState[key];
        if (state.animFrame) {
            cancelAnimationFrame(state.animFrame);
            state.animFrame = null;
        }
        if (state.canvas) {
            state.canvas.style.display = 'none';
        }
        state.pixelSize = 0;
    }

    function startCanvasAnimation(key, container, canvasId, pixelSize) {
        const state = pixelState[key];
        stopPixelAnimation(key);
        if (pixelSize <= 0 || !container) return;

        const canvas = getPixelCanvas(container, canvasId);
        state.canvas = canvas;
        state.pixelSize = pixelSize;

        function drawLoop() {
            const activeMedia = container.querySelector('.cbg-layer.active .cbg-media');
            if (activeMedia) {
                if (activeMedia.tagName === 'VIDEO' && activeMedia.paused) {
                    state.animFrame = requestAnimationFrame(drawLoop);
                    return;
                }
                drawPixelatedFrame(canvas, activeMedia, pixelSize);
                canvas.style.display = 'block';
            } else {
                canvas.style.display = 'none';
            }
            state.animFrame = requestAnimationFrame(drawLoop);
        }
        state.animFrame = requestAnimationFrame(drawLoop);
    }

    function applyAllPixelEffects() {
        const globalContainer = document.getElementById('global-background-container');
        const vibeContainer = document.getElementById('vibe-background-container');
        const globalPixel = getSetting('globalPixelate', 0);
        const vibePixel = getSetting('vibePixelate', 0);

        if (globalContainer) {
            stopPixelAnimation('global');
            if (currentGlobal.isGif) {
                // GIF — без пикселизации
            } else if (globalPixel > 0) {
                if (currentGlobal.isVideo) {
                    startCanvasAnimation('global', globalContainer, 'global-pixel-canvas', globalPixel);
                } else {
                    startCanvasAnimation('global', globalContainer, 'global-pixel-canvas', globalPixel);
                }
            }
        }

        if (vibeContainer) {
            stopPixelAnimation('vibe');
            if (currentVibe.isGif) {
                // GIF — без пикселизации
            } else if (vibePixel > 0) {
                if (currentVibe.isVideo) {
                    startCanvasAnimation('vibe', vibeContainer, 'vibe-pixel-canvas', vibePixel);
                } else {
                    startCanvasAnimation('vibe', vibeContainer, 'vibe-pixel-canvas', vibePixel);
                }
            }
        }
    }

    // ========== ПАНЕЛЬ ПРЕДПРОСМОТРА (исправлено для видео) ==========
    function createPreviewPanel() {
        if (previewPanel) return previewPanel;
        previewPanel = document.createElement('div');
        previewPanel.id = 'bg-preview-panel';
        document.body.appendChild(previewPanel);
        previewPanel.innerHTML = `
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
        `;
        const globalContainer = previewPanel.querySelector('#preview-global .preview-layer-container');
        globalPreviewLayers = Array.from(globalContainer.querySelectorAll('.preview-layer'));
        const vibeContainer = previewPanel.querySelector('#preview-vibe .preview-layer-container');
        vibePreviewLayers = Array.from(vibeContainer.querySelectorAll('.preview-layer'));
        return previewPanel;
    }

    function crossfadePreview(layers, mediaInfo) {
        const active = layers.find(l => l.classList.contains('active'));
        const inactive = layers.find(l => !l.classList.contains('active'));
        if (!active || !inactive) return;

        inactive.innerHTML = '';
        const url = mediaInfo?.url;
        const isVideo = mediaInfo?.isVideo;

        if (url) {
            if (isVideo) {
                const video = document.createElement('video');
                video.src = url;
                video.autoplay = true;
                video.loop = true;
                video.muted = true;
                video.playsInline = true;
                video.style.width = '100%';
                video.style.height = '100%';
                video.style.objectFit = 'cover';
                video.style.borderRadius = '6px';
                inactive.appendChild(video);
                video.play().catch(() => {});
            } else {
                const img = document.createElement('img');
                img.src = url;
                img.style.width = '100%';
                img.style.height = '100%';
                img.style.objectFit = 'cover';
                img.style.borderRadius = '6px';
                img.onerror = () => { inactive.innerHTML = ''; };
                inactive.appendChild(img);
            }
        } else {
            inactive.innerHTML = '<div style="font-size:11px;color:#888;display:flex;align-items:center;justify-content:center;height:100%;">не установлен</div>';
        }

        active.classList.remove('active');
        inactive.classList.add('active');

        setTimeout(() => {
            if (!active.classList.contains('active')) {
                active.innerHTML = '';
            }
        }, 400);
    }

    function updatePreviewPanel() {
        if (!previewPanel) return;
        crossfadePreview(globalPreviewLayers, { url: currentGlobal.url, isVideo: currentGlobal.isVideo });
        crossfadePreview(vibePreviewLayers, { url: currentVibe.url, isVideo: currentVibe.isVideo });
    }

    function positionPreviewPanel(anchorEl) {
        if (!previewPanel || !anchorEl) return;
        const rect = anchorEl.getBoundingClientRect();
        const panelWidth = previewPanel.offsetWidth || 160;
        const gap = 12;
        if (rect.right + gap + panelWidth <= window.innerWidth) {
            previewPanel.style.left = (rect.right + gap) + 'px';
            previewPanel.style.right = 'auto';
        } else {
            previewPanel.style.right = (window.innerWidth - rect.left + gap) + 'px';
            previewPanel.style.left = 'auto';
        }
        previewPanel.style.top = rect.top + 'px';
    }

    function showPreviewPanel(anchorEl) {
        if (!previewPanel) return;
        updatePreviewPanel();
        positionPreviewPanel(anchorEl);
        previewPanel.classList.add('active');
    }

    function hidePreviewPanel() {
        if (previewPanel) previewPanel.classList.remove('active');
    }

    // ========== IndexedDB ==========
    const openDB = (dbName) => {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(dbName, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    };

    const saveFile = async (dbName, file) => {
        if (!file) return;
        const db = await openDB(dbName);
        const tx = db.transaction('media', 'readwrite');
        const store = tx.objectStore('media');
        store.put(file, 'current_bg');
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        if (dbName === 'GlobalBackgroundDB') {
            globalFileCache = null;
            await applyGlobalStyle(true);
        } else {
            vibeFileCache = null;
            await initVibeMedia(true);
        }
    };

    const loadFile = async (dbName) => {
        try {
            const db = await openDB(dbName);
            return new Promise((resolve, reject) => {
                const tx = db.transaction('media', 'readonly');
                const store = tx.objectStore('media');
                const req = store.get('current_bg');
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
        } catch (e) { 
            console.error(`[CustomBackground] Failed to load from ${dbName}:`, e);
            return null; 
        }
    };

    const deleteFile = async (dbName) => {
        return new Promise(async (resolve, reject) => {
            try {
                const db = await openDB(dbName);
                const tx = db.transaction('media', 'readwrite');
                const store = tx.objectStore('media');
                store.delete('current_bg');
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            } catch (e) { 
                console.error(`[CustomBackground] Failed to delete from ${dbName}:`, e);
                reject(e); 
            }
        });
    };

    // ========== SETTINGS ==========
    function getSetting(id, defaultValue = false) {
        const s = addonSettings[id];
        if (!s) return defaultValue;
        const v = s.value;
        if (v === undefined || v === null) return defaultValue;
        if (typeof defaultValue === 'number') {
            const num = Number(v);
            return isNaN(num) ? defaultValue : num;
        }
        if (typeof v === 'boolean') return v;
        if (v === 'true' || v === 1 || v === '1') return true;
        if (v === 'false' || v === 0 || v === '0') return false;
        return v;
    }

    function applySettings() {
        const gBlur = getSetting('globalBlur', 0);
        const gBright = getSetting('globalBrightness', 0.4);
        const gOpacity = getSetting('globalOpacity', 100);
        const vBlur = getSetting('vibeBlur', 0);
        const vBright = getSetting('vibeBrightness', 0.4);
        const vOpacity = getSetting('vibeOpacity', 100);
        const vig = getSetting('vignetteIntensity', 0);
        const vVig = getSetting('vibeVignetteIntensity', 0);

        document.documentElement.style.setProperty('--global-blur', `${gBlur}px`);
        document.documentElement.style.setProperty('--global-brightness', gBright);
        document.documentElement.style.setProperty('--global-opacity', gOpacity / 100);
        document.documentElement.style.setProperty('--vibe-blur', `${vBlur}px`);
        document.documentElement.style.setProperty('--vibe-brightness', vBright);
        document.documentElement.style.setProperty('--vibe-opacity', vOpacity / 100);
        document.documentElement.style.setProperty('--vignette-opacity', (vig / 100).toFixed(2));
        document.documentElement.style.setProperty('--vibe-vignette-opacity', (vVig / 100).toFixed(2));

        const glass = getSetting('glass_enabled', true);
        document.documentElement.classList.toggle('glass-disabled', !glass);

        getGlobalContainer();
        getVibeContainer();

        applyAllPixelEffects();
    }

    // ========== ADAPTIVE ==========
    function setAdaptiveGlobalEnabled(enabled) {
        localStorage.setItem(ADAPTIVE_GLOBAL_KEY, enabled ? '1' : '0');
        updateAdaptiveButtons();
    }
    function isAdaptiveGlobalEnabled() { return localStorage.getItem(ADAPTIVE_GLOBAL_KEY) === '1'; }
    function setAdaptiveVibeEnabled(enabled) {
        localStorage.setItem(ADAPTIVE_VIBE_KEY, enabled ? '1' : '0');
        updateAdaptiveButtons();
    }
    function isAdaptiveVibeEnabled() { return localStorage.getItem(ADAPTIVE_VIBE_KEY) === '1'; }
    function updateAdaptiveButtons() {
        const btnG = document.getElementById('btn-toggle-adaptive-global');
        const btnV = document.getElementById('btn-toggle-adaptive-vibe');
        if (btnG) btnG.classList.toggle('active', isAdaptiveGlobalEnabled());
        if (btnV) btnV.classList.toggle('active', isAdaptiveVibeEnabled());
    }

    // ========== COVER HELPERS ==========
    const preloadImage = (url) => new Promise((resolve) => {
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => resolve(true); img.onerror = () => resolve(false);
        img.src = url;
    });
    function getHighResCoverUrl(coverUri) {
        if (!coverUri) return null;
        let uri = coverUri; if (!uri.startsWith('http')) uri = 'https://' + uri;
        return uri.replace(/\/\d+x\d+(?=[/?&]|$)/, '/1000x1000');
    }
    async function updateAdaptiveCover(coverUri) {
        if (!coverUri) {
            lastCoverUrl = null;
            if (isAdaptiveGlobalEnabled()) await applyGlobalStyle(true);
            if (isAdaptiveVibeEnabled()) await initVibeMedia(true);
            updatePreviewPanel();
            return;
        }
        const url = getHighResCoverUrl(coverUri);
        if (!url || url === lastCoverUrl) return;
        const ok = await preloadImage(url); if (!ok) return;
        lastCoverUrl = url;
        if (isAdaptiveGlobalEnabled()) await applyGlobalStyle(true);
        if (isAdaptiveVibeEnabled()) await initVibeMedia(true);
        updatePreviewPanel();
    }

    // ========== LAYER MANAGEMENT ==========
    function ensureLayers(container) {
        let layers = container.querySelectorAll('.cbg-layer');
        if (layers.length < 2) {
            container.innerHTML = '';
            const l1 = document.createElement('div'); l1.className = 'cbg-layer active';
            const l2 = document.createElement('div'); l2.className = 'cbg-layer';
            container.appendChild(l1); container.appendChild(l2);
            layers = [l1, l2];
        }
        if (!container.querySelector('.cbg-layer.active')) {
            layers[0].classList.add('active'); layers[1].classList.remove('active');
        }
        if (!container.querySelector('.cbg-vignette')) {
            const vignette = document.createElement('div');
            vignette.className = 'cbg-vignette';
            container.appendChild(vignette);
        }
        return container;
    }

    function createContainer(id, prependTo) {
        let container = document.getElementById(id);
        if (!container && prependTo) {
            container = document.createElement('div'); container.id = id;
            prependTo.prepend(container); ensureLayers(container);
        } else if (container) {
            ensureLayers(container);
        }
        return container;
    }

    function getGlobalContainer() { return createContainer('global-background-container', document.body); }

    function getVibeContainer() {
        const vibe = document.querySelector('[class*="MainPage_vibe"]') || document.querySelector('[data-test-id="VIBE_BLOCK"]');
        const oldContainer = document.getElementById('vibe-background-container');
        
        if (!vibe) { 
            if (oldContainer) oldContainer.remove(); 
            return null; 
        }
        
        vibe.style.setProperty('height', 'calc(100vh - 70px)', 'important');
        vibe.style.setProperty('min-height', 'calc(100vh - 70px)', 'important');
        vibe.style.setProperty('padding', '0', 'important');
        
        let container = createContainer('vibe-background-container', vibe);
        
        return container;
    }

    function cleanupOldBlobUrls(urlSet, newUrl) {
        for (const url of urlSet) { if (url !== newUrl) URL.revokeObjectURL(url); }
        urlSet.clear(); if (newUrl) urlSet.add(newUrl);
    }

    function crossfade(container, url, isVideo) {
        if (!container || !url) return false;
        ensureLayers(container);
        const active = container.querySelector('.cbg-layer.active');
        const inactive = container.querySelector('.cbg-layer:not(.active)');
        if (!active || !inactive) return false;

        inactive.innerHTML = '';
        if (isVideo) {
            const video = document.createElement('video');
            video.src = url; 
            video.autoplay = true; 
            video.loop = true; 
            video.muted = true; 
            video.playsInline = true;
            video.className = 'cbg-media';
            inactive.appendChild(video);
            if (!document.hidden) video.play().catch(() => {});
        } else {
            const img = document.createElement('img');
            img.src = url;
            img.className = 'cbg-media';
            inactive.appendChild(img);
        }

        void inactive.offsetWidth;

        active.classList.remove('active');
        inactive.classList.add('active');

        setTimeout(() => { 
            if (!active.classList.contains('active')) {
                active.innerHTML = ''; 
            }
        }, 700);

        return true;
    }

    function fadeOutClear(container, timerKey) {
        if (!container) return;
        ensureLayers(container);
        const active = container.querySelector('.cbg-layer.active');
        if (active) active.classList.remove('active');
        clearTimeout(resetTimers[timerKey]);
        resetTimers[timerKey] = setTimeout(() => {
            container.querySelectorAll('.cbg-layer').forEach(l => l.innerHTML = '');
            resetTimers[timerKey] = null;
        }, 600);
    }

    // ========== BACKGROUND ==========
    async function applyGlobalStyle(force = false) {
        if (globalUpdatePending) return;
        globalUpdatePending = true;
        try {
            const container = getGlobalContainer();
            if (!container) return;
            
            let targetUrl = null; 
            let isVideo = false;
            let isGif = false;
            
            if (isAdaptiveGlobalEnabled()) {
                targetUrl = lastCoverUrl;
                if (targetUrl) isGif = targetUrl.toLowerCase().endsWith('.gif');
            } else {
                const file = await loadFile('GlobalBackgroundDB');
                if (file) {
                    if (!globalFileCache) {
                        const newUrl = URL.createObjectURL(file);
                        globalFileCache = { url: newUrl, type: file.type };
                        cleanupOldBlobUrls(globalBlobUrls, newUrl);
                    }
                    targetUrl = globalFileCache.url; 
                    const type = globalFileCache.type;
                    isVideo = type.startsWith('video/');
                    isGif = type === 'image/gif' || targetUrl.toLowerCase().endsWith('.gif');
                } else {
                    if (globalFileCache) { 
                        cleanupOldBlobUrls(globalBlobUrls, null); 
                        globalFileCache = null; 
                    }
                }
            }
            
            if (targetUrl) { 
                clearTimeout(resetTimers.global); 
                resetTimers.global = null; 
            }
            
            const isFirstLoad = !currentGlobal.url && targetUrl;
            const shouldUpdate = force || isFirstLoad || (currentGlobal.url !== targetUrl);
            
            if (!shouldUpdate) return;
            
            currentGlobal.url = targetUrl;
            currentGlobal.isVideo = isVideo;
            currentGlobal.isGif = isGif;
            
            if (!targetUrl) { 
                fadeOutClear(container, 'global'); 
                updatePreviewPanel();
                applyAllPixelEffects(); 
                return; 
            }
            
            crossfade(container, targetUrl, isVideo);
            updatePreviewPanel();
            applyAllPixelEffects();
        } finally { 
            globalUpdatePending = false; 
        }
    }

    async function initVibeMedia(force = false) {
        if (vibeUpdatePending) return;
        vibeUpdatePending = true;
        try {
            const container = getVibeContainer();
            if (!container) return;
            
            let targetUrl = null; 
            let isVideo = false;
            let isGif = false;
            
            if (isAdaptiveVibeEnabled()) {
                targetUrl = lastCoverUrl;
                if (targetUrl) isGif = targetUrl.toLowerCase().endsWith('.gif');
            } else {
                const file = await loadFile('VibeVideoDB');
                if (file) {
                    if (!vibeFileCache) {
                        const newUrl = URL.createObjectURL(file);
                        vibeFileCache = { url: newUrl, type: file.type };
                        cleanupOldBlobUrls(vibeBlobUrls, newUrl);
                    }
                    targetUrl = vibeFileCache.url; 
                    const type = vibeFileCache.type;
                    isVideo = type.startsWith('video/');
                    isGif = type === 'image/gif' || targetUrl.toLowerCase().endsWith('.gif');
                } else {
                    if (vibeFileCache) { 
                        cleanupOldBlobUrls(vibeBlobUrls, null); 
                        vibeFileCache = null; 
                    }
                }
            }
            
            if (targetUrl) { 
                clearTimeout(resetTimers.vibe); 
                resetTimers.vibe = null; 
            }
            
            const isFirstLoad = !currentVibe.url && targetUrl;
            const shouldUpdate = force || isFirstLoad || (currentVibe.url !== targetUrl);
            
            if (!shouldUpdate) return;
            
            currentVibe.url = targetUrl;
            currentVibe.isVideo = isVideo;
            currentVibe.isGif = isGif;
            
            if (!targetUrl) { 
                fadeOutClear(container, 'vibe'); 
                updatePreviewPanel();
                applyAllPixelEffects(); 
                return; 
            }
            
            crossfade(container, targetUrl, isVideo);
            updatePreviewPanel();
            applyAllPixelEffects();
        } finally { 
            vibeUpdatePending = false; 
        }
    }

    // ========== VIDEO PAUSE/PLAY ==========
    function updateVideoPlayback() {
        const hidden = document.hidden;
        document.querySelectorAll('#global-background-container video, #vibe-background-container video').forEach(v => {
            if (hidden) v.pause(); else v.play().catch(() => {});
        });
    }
    document.addEventListener('visibilitychange', updateVideoPlayback);

    // ========== MENU (без изменений) ==========
    function injectMenu() {
        const anchorBtn = document.querySelector('.TitleBar_button__9MptL');
        if (!anchorBtn || document.getElementById('bg-menu-button')) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'TitleBar_button__9MptL';
        btn.id = 'bg-menu-button';
        btn.setAttribute('aria-label', 'Смена фонов');
        btn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="TitleBar_icon__8Wji9" style="pointer-events: none;">
                <path d="M4 4h16v16H4z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/>
                <path d="M21 15l-5-5L5 21" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M15.5 8.5L19 4" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        `;
        anchorBtn.parentNode.insertBefore(btn, anchorBtn);

        const dropdown = document.createElement('div');
        dropdown.id = 'bg-menu-dropdown';
        const resetSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M23,12A11,11,0,1,1,12,1a10.9,10.9,0,0,1,5.882,1.7l1.411-1.411A1,1,0,0,1,21,2V6a1,1,0,0,1-1,1H16a1,1,0,0,1-.707-1.707L16.42,4.166A8.9,8.9,0,0,0,12,3a9,9,0,1,0,9,9,1,1,0,0,1,2,0Z"/></svg>`;
        dropdown.innerHTML = `
            <div class="bg-menu-row"><div class="bg-menu-item" id="btn-set-global">Глобальный фон</div><div class="bg-menu-reset" id="btn-reset-global">${resetSvg}</div></div>
            <div class="bg-menu-row"><div class="bg-menu-item" id="btn-set-vibe">Фон Волны</div><div class="bg-menu-reset" id="btn-reset-vibe">${resetSvg}</div></div>
            <div class="bg-menu-item" id="btn-toggle-adaptive-global">Адаптивный фон</div>
            <div class="bg-menu-item" id="btn-toggle-adaptive-vibe">Адаптивная волна</div>
        `;
        document.body.appendChild(dropdown);

        createPreviewPanel();

        let pendingRaf = null;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const dd = document.getElementById('bg-menu-dropdown');
            const isActive = dd.classList.contains('active');
            
            if (pendingRaf) {
                cancelAnimationFrame(pendingRaf);
                pendingRaf = null;
            }
            
            if (isActive) {
                dd.classList.remove('active');
                hidePreviewPanel();
            } else {
                positionDropdown();
                dd.classList.add('active');
                pendingRaf = requestAnimationFrame(() => {
                    pendingRaf = null;
                    showPreviewPanel(dd);
                });
            }
        });

        function positionDropdown() {
            const rect = btn.getBoundingClientRect();
            const dd = document.getElementById('bg-menu-dropdown');
            if (!dd) return;
            const ddWidth = 180;
            const left = rect.left + (rect.width / 2) - (ddWidth / 2);
            dd.style.top = `${rect.bottom + 8}px`;
            dd.style.left = `${Math.max(8, left)}px`;
        }

        document.addEventListener('mousedown', (e) => {
            const dd = document.getElementById('bg-menu-dropdown');
            if (dd && dd.classList.contains('active') && !dd.contains(e.target) && e.target !== btn) {
                dd.classList.remove('active');
                hidePreviewPanel();
                if (pendingRaf) {
                    cancelAnimationFrame(pendingRaf);
                    pendingRaf = null;
                }
            }
        }, true);

        window.addEventListener('resize', () => {
            const dd = document.getElementById('bg-menu-dropdown');
            if (dd && dd.classList.contains('active') && previewPanel?.classList.contains('active')) {
                positionDropdown();
                positionPreviewPanel(dd);
            }
        });

        const openPicker = (db) => {
            const input = document.createElement('input');
            input.type = 'file'; 
            input.accept = 'video/mp4,video/webm,image/*';
            input.onchange = e => {
                if (e.target.files[0]) {
                    if (db === 'GlobalBackgroundDB') setAdaptiveGlobalEnabled(false);
                    else setAdaptiveVibeEnabled(false);
                    saveFile(db, e.target.files[0]);
                    setTimeout(() => updatePreviewPanel(), 500);
                }
            };
            input.click();
        };

        document.getElementById('btn-set-global').onclick = () => openPicker('GlobalBackgroundDB');
        document.getElementById('btn-set-vibe').onclick = () => openPicker('VibeVideoDB');

        document.getElementById('btn-reset-global').onclick = async () => {
            await deleteFile('GlobalBackgroundDB');
            globalFileCache = null; 
            currentGlobal.url = null;
            currentGlobal.isVideo = false;
            currentGlobal.isGif = false;
            await applyGlobalStyle(true); 
            updatePreviewPanel(); 
            applyAllPixelEffects();
        };
        
        document.getElementById('btn-reset-vibe').onclick = async () => {
            await deleteFile('VibeVideoDB');
            vibeFileCache = null; 
            currentVibe.url = null;
            currentVibe.isVideo = false;
            currentVibe.isGif = false;
            await initVibeMedia(true); 
            updatePreviewPanel(); 
            applyAllPixelEffects();
        };

        document.getElementById('btn-toggle-adaptive-global').onclick = async () => {
            const next = !isAdaptiveGlobalEnabled();
            if (next) { 
                await deleteFile('GlobalBackgroundDB'); 
                globalFileCache = null; 
            }
            setAdaptiveGlobalEnabled(next);
            await applyGlobalStyle(true);
            if (!next) { 
                currentGlobal.url = null; 
                currentGlobal.isVideo = false;
                currentGlobal.isGif = false;
            }
            updatePreviewPanel();
            applyAllPixelEffects();
        };

        document.getElementById('btn-toggle-adaptive-vibe').onclick = async () => {
            const next = !isAdaptiveVibeEnabled();
            if (next) { 
                await deleteFile('VibeVideoDB'); 
                vibeFileCache = null; 
            }
            setAdaptiveVibeEnabled(next);
            await initVibeMedia(true);
            if (!next) { 
                currentVibe.url = null; 
                currentVibe.isVideo = false;
                currentVibe.isGif = false;
            }
            updatePreviewPanel();
            applyAllPixelEffects();
        };

        updateAdaptiveButtons();
    }

    // ========== OBSERVERS ==========
    let menuObserver;
    let vibeObserver;
    
    function initObservers() {
        menuObserver = new MutationObserver(() => {
            if (!document.getElementById('bg-menu-button') && document.querySelector('.TitleBar_button__9MptL')) {
                injectMenu();
            }
        });
        menuObserver.observe(document.body, { childList: true, subtree: true });
        
        vibeObserver = new MutationObserver(() => {
            const vibe = document.querySelector('[class*="MainPage_vibe"]') || document.querySelector('[data-test-id="VIBE_BLOCK"]');
            if (vibe && !document.getElementById('vibe-background-container')) {
                initVibeMedia(true);
            }
        });
        vibeObserver.observe(document.body, { childList: true, subtree: true });
    }
    
    function disconnectObservers() {
        if (menuObserver) menuObserver.disconnect();
        if (vibeObserver) vibeObserver.disconnect();
    }

    // ========== PULSE SYNC ==========
    function initPulseSyncSettings() {
        if (!window.pulsesyncApi) { 
            setTimeout(initPulseSyncSettings, 500); 
            return; 
        }
        const addonName = 'Custom Background';
        let api = null;
        try { 
            api = window.pulsesyncApi.getSettings?.(addonName); 
        } catch (e) { 
            console.warn('[CustomBackground] getSettings error:', e); 
        }
        if (!api || !api.onChange) { 
            setTimeout(initPulseSyncSettings, 1000); 
            return; 
        }
        const handle = (s) => { 
            addonSettings = s || {}; 
            applySettings(); 
        };
        handle(api.getCurrent?.() || {}); 
        api.onChange((s) => handle(s));
        console.log('[CustomBackground] PulseSync settings API подключен');
    }

    function initPulseSyncTracking() {
        if (typeof Theme === 'undefined') return false;
        try {
            const theme = new Theme('custom-background');
            const handleEvent = async (eventData) => {
                const track = eventData?.state?.track;
                await updateAdaptiveCover(track?.coverUri);
            };
            theme.player.on('trackChange', handleEvent);
            theme.player.on('pageChange', handleEvent);
            try { 
                const cur = theme.player.getCurrentTrack?.(); 
                if (cur?.coverUri) updateAdaptiveCover(cur.coverUri); 
            } catch (e) {}
            return true;
        } catch (e) { 
            console.error('[CustomBackground] PulseSync API error:', e); 
            return false; 
        }
    }

    function initPlayerDomTracking() {
        let prevUrl = null;
        setInterval(() => {
            if (!isAdaptiveGlobalEnabled() && !isAdaptiveVibeEnabled()) return;
            const playerBar = document.querySelector('[class*="PlayerBarDesktop"]') 
                || document.querySelector('[data-test-id="PLAYER_BAR"]')
                || document.querySelector('.player-controls__track')
                || document.querySelector('[class*="player_bar"]');
            if (!playerBar) return;
            const img = playerBar.querySelector('img[src*="avatars.yandex.net"]');
            if (!img || !img.src) return;
            const highRes = img.src.replace(/&amp;/g, '&').replace(/\/\d+x\d+(?=[/?&]|$)/, '/1000x1000');
            if (highRes !== prevUrl) {
                prevUrl = highRes; 
                lastCoverUrl = highRes;
                if (isAdaptiveGlobalEnabled()) applyGlobalStyle(true);
                if (isAdaptiveVibeEnabled()) initVibeMedia(true);
                updatePreviewPanel();
            }
        }, 1000);
    }

    // ========== INIT ==========
    async function init() {
        applySettings(); 
        initObservers();
        
        await applyGlobalStyle(true);
        await initVibeMedia(true);
        
        if (!initPulseSyncTracking()) initPlayerDomTracking();
        initPulseSyncSettings();
    }

    init();

    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            applyAllPixelEffects();
        }, 200);
    });

    window.addEventListener('beforeunload', () => {
        disconnectObservers();
        stopPixelAnimation('global');
        stopPixelAnimation('vibe');
        cleanupOldBlobUrls(globalBlobUrls, null);
        cleanupOldBlobUrls(vibeBlobUrls, null);
    });
})();