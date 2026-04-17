(() => {
    const objectUrls = {
        global: null,
        vibe: null
    };

    const SETTINGS_KEY = 'glass_enabled';

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
            if (dbName === 'GlobalBackgroundDB') applyGlobalStyle(true);
            else initVibeMedia(true);
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
        const db = await openDB(dbName);
        const tx = db.transaction('media', 'readwrite');
        const store = tx.objectStore('media');
        store.delete('current_bg');
        tx.oncomplete = () => {
            if (dbName === 'GlobalBackgroundDB') applyGlobalStyle(true);
            else initVibeMedia(true);
        };
    };

    // ===== GLASS =====

    function setGlassEnabled(enabled) {
        localStorage.setItem(SETTINGS_KEY, enabled ? '1' : '0');
        document.documentElement.classList.toggle('glass-disabled', !enabled);
        updateGlassButton();
    }

    function isGlassEnabled() {
        return localStorage.getItem(SETTINGS_KEY) !== '0';
    }

    function updateGlassButton() {
        const btn = document.getElementById('btn-toggle-glass');
        if (!btn) return;
        btn.classList.toggle('active', isGlassEnabled());
    }

    function initGlassState() {
        if (!isGlassEnabled()) {
            document.documentElement.classList.add('glass-disabled');
        }
    }

    // ===== BACKGROUND =====

    async function applyGlobalStyle(forceUpdate = false) {
        let container = document.getElementById('global-background-layer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'global-background-layer';
            document.body.prepend(container);
        }

        if (forceUpdate) delete container.dataset.loaded;
        if (container.dataset.loaded) return;

        const file = await loadFile('GlobalBackgroundDB');

        if (!file) {
            container.innerHTML = '';
            container.dataset.loaded = "true";
            return;
        }

        const url = URL.createObjectURL(file);
        if (objectUrls.global) URL.revokeObjectURL(objectUrls.global);
        objectUrls.global = url;

        container.innerHTML = file.type.startsWith('video/')
            ? `<video id="gb-video" src="${url}" autoplay loop muted playsinline></video>`
            : `<div id="gb-image" style="background-image:url('${url}')"></div>`;

        container.dataset.loaded = "true";
    }

    async function initVibeMedia(forceUpdate = false) {
        const vibe = document.querySelector('[class*="MainPage_vibe"]') || document.querySelector('[data-test-id="VIBE_BLOCK"]');
        if (!vibe) return;

        // ВЕРНУЛ РАЗМЕР
        vibe.style.setProperty('height', 'calc(100vh - 70px)', 'important');
        vibe.style.setProperty('padding', '0', 'important');

        let container = document.getElementById('vibe-media-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'vibe-media-container';
            vibe.prepend(container);
        }

        if (forceUpdate) delete container.dataset.loaded;
        if (container.dataset.loaded) return;

        const file = await loadFile('VibeVideoDB');

        if (!file) {
            container.innerHTML = '';
            container.dataset.loaded = "true";
            return;
        }

        const url = URL.createObjectURL(file);
        if (objectUrls.vibe) URL.revokeObjectURL(objectUrls.vibe);
        objectUrls.vibe = url;

        container.innerHTML = file.type.startsWith('video/')
            ? `<video id="vibe-video" src="${url}" autoplay loop muted playsinline></video>`
            : `<div id="vibe-image-layer" style="background-image:url('${url}')"></div>`;

        container.dataset.loaded = "true";
    }

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

            <div class="bg-menu-item" id="btn-toggle-glass">Жидкое стекло</div>
        `;

        document.body.appendChild(dropdown);

        const btn = document.getElementById('bg-menu-button');

// Используем именно onmousedown — это ключ к решению
btn.onmousedown = (e) => {
    // Эти две строки предотвращают сворачивание окна
    e.preventDefault(); 
    e.stopPropagation();

    const dropdown = document.getElementById('bg-menu-dropdown');
    const rect = btn.getBoundingClientRect();
    
    // Рассчитываем позицию (в старой версии было смещение left - 130)
    dropdown.style.top = `${rect.bottom + 5}px`;
    dropdown.style.left = `${rect.left - 130}px`; 
    
    dropdown.classList.toggle('active');
};

// Чтобы двойной клик тоже не сворачивал окно (на всякий случай)
btn.ondblclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
};
// Закрытие меню при клике в любое место за его пределами
document.addEventListener('mousedown', (e) => {
    const dropdown = document.getElementById('bg-menu-dropdown');
    const btn = document.getElementById('bg-menu-button');

    // Если меню открыто И клик был НЕ по кнопке И клик был НЕ по самому меню
    if (dropdown && dropdown.classList.contains('active')) {
        if (!dropdown.contains(e.target) && !btn.contains(e.target)) {
            dropdown.classList.remove('active');
        }
    }
}, { capture: true }); // capture помогает перехватить клик раньше системных скриптов

        document.getElementById('btn-set-global').onclick = () => openPicker('GlobalBackgroundDB');
        document.getElementById('btn-set-vibe').onclick = () => openPicker('VibeVideoDB');

        document.getElementById('btn-reset-global').onclick = () => deleteFile('GlobalBackgroundDB');
        document.getElementById('btn-reset-vibe').onclick = () => deleteFile('VibeVideoDB');

        document.getElementById('btn-toggle-glass').onclick = () => {
            setGlassEnabled(!isGlassEnabled());
        };

        updateGlassButton();

        const openPicker = (db) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'video/mp4,video/webm,image/*';
            input.onchange = e => saveFile(db, e.target.files[0]);
            input.click();
        };
    }

    initGlassState();

    setInterval(() => {
        applyGlobalStyle();
        initVibeMedia();
        injectMenu();
    }, 500);
})();