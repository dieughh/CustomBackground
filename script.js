(() => {
    const ADAPTIVE_GLOBAL_KEY = 'adaptive_global_enabled';
    const ADAPTIVE_VIBE_KEY = 'adaptive_vibe_enabled';
    let lastCoverUrl = null;
    let addonSettings = {};

    // Кэш для blob:URL и управления состоянием
    let globalFileCache = null;
    let vibeFileCache = null;
    const currentGlobal = { url: null };
    const currentVibe = { url: null };
    const resetTimers = { global: null, vibe: null };
    let globalBlobUrls = new Set();
    let vibeBlobUrls = new Set();

    // Флаги для предотвращения дублирования
    let globalUpdatePending = false;
    let vibeUpdatePending = false;

    // ===== IndexedDB =====
    const openDB = (dbName) => {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(dbName);
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
        tx.oncomplete = () => {
            if (dbName === 'GlobalBackgroundDB') {
                globalFileCache = null; // сбросим кэш, чтобы пересоздать URL
                applyGlobalStyle(true);
            } else {
                vibeFileCache = null;
                initVibeMedia(true);
            }
        };
    };

    const loadFile = async (dbName) => {
        try {
            const db = await openDB(dbName);
            return new Promise((resolve) => {
                const tx = db.transaction('media', 'readonly');
                const store = tx.objectStore('media');
                const req = store.get('current_bg');
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
        } catch { return null; }
    };

    const deleteFile = async (dbName) => {
        return new Promise(async (resolve) => {
            try {
                const db = await openDB(dbName);
                const tx = db.transaction('media', 'readwrite');
                const store = tx.objectStore('media');
                store.delete('current_bg');
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch { resolve(); }
        });
    };

    // ===== SETTINGS =====
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
        const vBlur = getSetting('vibeBlur', 0);
        const vBright = getSetting('vibeBrightness', 0.4);
        const vig = getSetting('vignetteIntensity', 0);
        const vVig = getSetting('vibeVignetteIntensity', 0);

        document.documentElement.style.setProperty('--global-blur', `${gBlur}px`);
        document.documentElement.style.setProperty('--global-brightness', gBright);
        document.documentElement.style.setProperty('--vibe-blur', `${vBlur}px`);
        document.documentElement.style.setProperty('--vibe-brightness', vBright);
        document.documentElement.style.setProperty('--vignette-opacity', (vig / 100).toFixed(2));
        document.documentElement.style.setProperty('--vibe-vignette-opacity', (vVig / 100).toFixed(2));

        const glass = getSetting('glass_enabled', true);
        document.documentElement.classList.toggle('glass-disabled', !glass);
    }

    // ===== ADAPTIVE =====
    function setAdaptiveGlobalEnabled(enabled) {
        localStorage.setItem(ADAPTIVE_GLOBAL_KEY, enabled ? '1' : '0');
        updateAdaptiveButtons();
    }

    function isAdaptiveGlobalEnabled() {
        return localStorage.getItem(ADAPTIVE_GLOBAL_KEY) === '1';
    }

    function setAdaptiveVibeEnabled(enabled) {
        localStorage.setItem(ADAPTIVE_VIBE_KEY, enabled ? '1' : '0');
        updateAdaptiveButtons();
    }

    function isAdaptiveVibeEnabled() {
        return localStorage.getItem(ADAPTIVE_VIBE_KEY) === '1';
    }

    function updateAdaptiveButtons() {
        const btnG = document.getElementById('btn-toggle-adaptive-global');
        const btnV = document.getElementById('btn-toggle-adaptive-vibe');
        if (btnG) btnG.classList.toggle('active', isAdaptiveGlobalEnabled());
        if (btnV) btnV.classList.toggle('active', isAdaptiveVibeEnabled());
    }

    // ===== COVER HELPERS =====
    const preloadImage = (url) => new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = url;
    });

    function getHighResCoverUrl(coverUri) {
        if (!coverUri) return null;
        let uri = coverUri;
        if (!uri.startsWith('http')) uri = 'https://' + uri;
        return uri.replace(/\/\d+x\d+(?=[/?&]|$)/, '/1000x1000');
    }

    async function updateAdaptiveCover(coverUri) {
        if (!coverUri) {
            lastCoverUrl = null;
            if (isAdaptiveGlobalEnabled()) applyGlobalStyle(true);
            if (isAdaptiveVibeEnabled()) initVibeMedia(true);
            return;
        }
        const url = getHighResCoverUrl(coverUri);
        if (!url || url === lastCoverUrl) return;
        const ok = await preloadImage(url);
        if (!ok) return;
        lastCoverUrl = url;
        if (isAdaptiveGlobalEnabled()) applyGlobalStyle(true);
        if (isAdaptiveVibeEnabled()) initVibeMedia(true);
    }

    function ensureLayers(container) {
    let layers = container.querySelectorAll('.bg-layer');
    if (layers.length < 2) {
        container.innerHTML = '';
        const l1 = document.createElement('div');
        l1.className = 'bg-layer active';
        const l2 = document.createElement('div');
        l2.className = 'bg-layer';
        container.appendChild(l1);
        container.appendChild(l2);
        layers = [l1, l2];
    }
    if (!container.querySelector('.bg-layer.active')) {
        layers[0].classList.add('active');
        layers[1].classList.remove('active');
    }
    
    // Добавляем слой виньетки, если его нет
    if (!container.querySelector('.vignette-layer')) {
        const vignette = document.createElement('div');
        vignette.className = 'vignette-layer';
        container.appendChild(vignette);
    }
    
    return container;
}

    function createContainer(id, prependTo) {
        let container = document.getElementById(id);
        if (!container && prependTo) {
            container = document.createElement('div');
            container.id = id;
            prependTo.prepend(container);
            ensureLayers(container);
        } else if (container) {
            ensureLayers(container);
        }
        return container;
    }

    function getGlobalContainer() {
        return createContainer('global-background-container', document.body);
    }

    function getVibeContainer() {
    const vibe = document.querySelector('[class*="MainPage_vibe"]') || document.querySelector('[data-test-id="VIBE_BLOCK"]');
    const oldContainer = document.getElementById('vibe-background-container');
    
    if (!vibe) {
        if (oldContainer) oldContainer.remove();
        return null;
    }
    
    vibe.style.setProperty('height', 'calc(100vh - 70px)', 'important');
    vibe.style.setProperty('padding', '0', 'important');
    
    let container = createContainer('vibe-background-container', vibe);
    
    // Если контейнер был пересоздан (старый удалён), сбрасываем сохранённый URL
    if (!oldContainer || oldContainer !== container) {
        currentVibe.url = null;
    }
    
    return container;
}

    function cleanupOldBlobUrls(urlSet, newUrl) {
        for (const url of urlSet) {
            if (url !== newUrl) URL.revokeObjectURL(url);
        }
        urlSet.clear();
        if (newUrl) urlSet.add(newUrl);
    }

    function crossfade(container, url, isVideo) {
        if (!container || !url) return false;
        ensureLayers(container);
        const active = container.querySelector('.bg-layer.active');
        const inactive = container.querySelector('.bg-layer:not(.active)');
        if (!active || !inactive) return false;

        // Очищаем неактивный слой
        inactive.innerHTML = '';
        if (isVideo) {
            const video = document.createElement('video');
            video.src = url;
            video.autoplay = true;
            video.loop = true;
            video.muted = true;
            video.playsInline = true;
            inactive.appendChild(video);
            if (!document.hidden) video.play().catch(() => {});
        } else {
            const div = document.createElement('div');
            div.className = 'bg-image';
            div.style.backgroundImage = `url('${url}')`;
            inactive.appendChild(div);
        }

        // Принудительная перерисовка перед сменой класса (решает проблемы с мгновенным обновлением)
        inactive.offsetHeight; // чтение свойства вызывает reflow

        // Меняем активный слой
        active.classList.remove('active');
        inactive.classList.add('active');

        // Очищаем старый слой после анимации
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
        const active = container.querySelector('.bg-layer.active');
        if (active) active.classList.remove('active');

        clearTimeout(resetTimers[timerKey]);
        resetTimers[timerKey] = setTimeout(() => {
            container.querySelectorAll('.bg-layer').forEach(l => l.innerHTML = '');
            resetTimers[timerKey] = null;
        }, 600);
    }

    // ===== BACKGROUND =====
    async function applyGlobalStyle(force = false) {
    if (globalUpdatePending) return;
    globalUpdatePending = true;

    try {
        const container = getGlobalContainer();
        
        // Если активный слой пуст — принудительно обновим фон
        const activeLayer = container.querySelector('.bg-layer.active');
        if (activeLayer && !activeLayer.hasChildNodes()) {
            force = true;
        }

        let targetUrl = null;
        let isVideo = false;

        if (isAdaptiveGlobalEnabled()) {
            targetUrl = lastCoverUrl;
        } else {
            const file = await loadFile('GlobalBackgroundDB');
            if (file) {
                if (!globalFileCache) {
                    const newUrl = URL.createObjectURL(file);
                    globalFileCache = { url: newUrl, type: file.type };
                    cleanupOldBlobUrls(globalBlobUrls, newUrl);
                }
                targetUrl = globalFileCache.url;
                isVideo = globalFileCache.type.startsWith('video/');
            } else {
                if (globalFileCache) {
                    cleanupOldBlobUrls(globalBlobUrls, null);
                    globalFileCache = null;
                }
            }
        }

        // Если пришёл новый фон во время fade-out — отменяем очистку
        if (targetUrl) {
            clearTimeout(resetTimers.global);
            resetTimers.global = null;
        }

        const shouldUpdate = force || (currentGlobal.url !== targetUrl);
        if (!shouldUpdate) return;

        currentGlobal.url = targetUrl;

        if (!targetUrl) {
            fadeOutClear(container, 'global');
            return;
        }

        crossfade(container, targetUrl, isVideo);
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

        // Если активный слой пуст — принудительно обновим фон
        const activeLayer = container.querySelector('.bg-layer.active');
        if (activeLayer && !activeLayer.hasChildNodes()) {
            force = true;
        }

        let targetUrl = null;
        let isVideo = false;

        if (isAdaptiveVibeEnabled()) {
            targetUrl = lastCoverUrl;
        } else {
            const file = await loadFile('VibeVideoDB');
            if (file) {
                if (!vibeFileCache) {
                    const newUrl = URL.createObjectURL(file);
                    vibeFileCache = { url: newUrl, type: file.type };
                    cleanupOldBlobUrls(vibeBlobUrls, newUrl);
                }
                targetUrl = vibeFileCache.url;
                isVideo = vibeFileCache.type.startsWith('video/');
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

        const shouldUpdate = force || (currentVibe.url !== targetUrl);
        if (!shouldUpdate) return;

        currentVibe.url = targetUrl;

        if (!targetUrl) {
            fadeOutClear(container, 'vibe');
            return;
        }

        crossfade(container, targetUrl, isVideo);
    } finally {
        vibeUpdatePending = false;
    }
}

    // ===== VIDEO PAUSE/PLAY =====
    function updateVideoPlayback() {
        const hidden = document.hidden;
        document.querySelectorAll('#global-background-container video, #vibe-background-container video').forEach(v => {
            if (hidden) v.pause();
            else v.play().catch(() => {});
        });
    }
    document.addEventListener('visibilitychange', updateVideoPlayback);

    // ===== MENU =====
    function injectMenu() {
        const anchorBtn = document.querySelector('.TitleBar_button__9MptL');
        if (!anchorBtn || document.getElementById('bg-menu-root')) return;

        const menuRoot = document.createElement('div');
        menuRoot.id = 'bg-menu-root';
        menuRoot.innerHTML = `<div id="bg-menu-button">Смена фонов</div>`;
        anchorBtn.parentNode.insertBefore(menuRoot, anchorBtn);

        const dropdown = document.createElement('div');
        dropdown.id = 'bg-menu-dropdown';

        const resetSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M23,12A11,11,0,1,1,12,1a10.9,10.9,0,0,1,5.882,1.7l1.411-1.411A1,1,0,0,1,21,2V6a1,1,0,0,1-1,1H16a1,1,0,0,1-.707-1.707L16.42,4.166A8.9,8.9,0,0,0,12,3a9,9,0,1,0,9,9,1,1,0,0,1,2,0Z"/></svg>`;

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
        `;

        document.body.appendChild(dropdown);

        const btn = document.getElementById('bg-menu-button');

        function positionDropdown() {
            const rect = btn.getBoundingClientRect();
            const dd = document.getElementById('bg-menu-dropdown');
            if (!dd) return;
            
            const ddWidth = 180;
            const left = rect.left + (rect.width / 2) - (ddWidth / 2);
            
            dd.style.top = `${rect.bottom + 8}px`;
            dd.style.left = `${Math.max(8, left)}px`;
        }

        btn.onmousedown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            const dd = document.getElementById('bg-menu-dropdown');
            const wasActive = dd.classList.contains('active');
            
            if (!wasActive) {
                positionDropdown();
            }
            
            dd.classList.toggle('active');
        };

        btn.ondblclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        window.addEventListener('resize', () => {
            const dd = document.getElementById('bg-menu-dropdown');
            if (dd && dd.classList.contains('active')) {
                positionDropdown();
            }
        });

        document.addEventListener('mousedown', (e) => {
            const dd = document.getElementById('bg-menu-dropdown');
            if (dd && dd.classList.contains('active')) {
                if (!dd.contains(e.target) && !btn.contains(e.target)) {
                    dd.classList.remove('active');
                }
            }
        }, { capture: true });

        const openPicker = (db) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'video/mp4,video/webm,image/*';
            input.onchange = e => {
                if (e.target.files[0]) {
                    if (db === 'GlobalBackgroundDB') setAdaptiveGlobalEnabled(false);
                    else setAdaptiveVibeEnabled(false);
                    saveFile(db, e.target.files[0]);
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
            applyGlobalStyle(true);
        };
        document.getElementById('btn-reset-vibe').onclick = async () => {
            await deleteFile('VibeVideoDB');
            vibeFileCache = null;
            currentVibe.url = null;
            initVibeMedia(true);
        };

        document.getElementById('btn-toggle-adaptive-global').onclick = async () => {
            const next = !isAdaptiveGlobalEnabled();
            if (next) await deleteFile('GlobalBackgroundDB');
            setAdaptiveGlobalEnabled(next);
            applyGlobalStyle(true);
        };

        document.getElementById('btn-toggle-adaptive-vibe').onclick = async () => {
            const next = !isAdaptiveVibeEnabled();
            if (next) await deleteFile('VibeVideoDB');
            setAdaptiveVibeEnabled(next);
            initVibeMedia(true);
        };

        updateAdaptiveButtons();
    }

    // ===== OBSERVERS =====
    let globalContainerObserver = null;
    let vibeContainerObserver = null;
    let menuObserver = null;

    function initObservers() {
        // Observer для глобального контейнера (всегда есть)
        globalContainerObserver = new MutationObserver(() => {
            applyGlobalStyle();
        });
        globalContainerObserver.observe(document.body, { childList: true, subtree: true });

        // Observer для контейнера "Моей волны"
        vibeContainerObserver = new MutationObserver(() => {
            initVibeMedia();
        });
        vibeContainerObserver.observe(document.body, { childList: true, subtree: true });

        // Observer для меню
        menuObserver = new MutationObserver(() => {
            if (!document.getElementById('bg-menu-root') && document.querySelector('.TitleBar_button__9MptL')) {
                injectMenu();
            }
        });
        menuObserver.observe(document.body, { childList: true, subtree: true });
    }

    function disconnectObservers() {
        if (globalContainerObserver) globalContainerObserver.disconnect();
        if (vibeContainerObserver) vibeContainerObserver.disconnect();
        if (menuObserver) menuObserver.disconnect();
    }

    // ===== PULSE SYNC SETTINGS API =====
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

    // ===== PULSE SYNC TRACK API =====
    function initPulseSyncTracking() {
        if (typeof Theme === 'undefined') return false;
        try {
            const theme = new Theme('custom-background');
            const handleEvent = (eventData) => {
                const track = eventData?.state?.track;
                updateAdaptiveCover(track?.coverUri);
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

    // ===== Fallback DOM tracking =====
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
            }
        }, 1000);
    }

    // ===== INIT =====
    applySettings();
    initObservers();
    
    if (!initPulseSyncTracking()) initPlayerDomTracking();
    initPulseSyncSettings();

    // Очистка при выгрузке аддона
    window.addEventListener('beforeunload', () => {
        disconnectObservers();
        cleanupOldBlobUrls(globalBlobUrls, null);
        cleanupOldBlobUrls(vibeBlobUrls, null);
    });
})();