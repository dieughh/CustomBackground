(() => {

    const openDB = (dbName) => {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName);

        req.onupgradeneeded = () => {
            const db = req.result;

            if (!db.objectStoreNames.contains('media')) {
                db.createObjectStore('media');
            }
        };

        req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('media')) {
                const newVersion = db.version + 1;
                db.close();

                const retryReq = indexedDB.open(dbName, newVersion);

                retryReq.onupgradeneeded = () => {
                    const newDb = retryReq.result;
                    if (!newDb.objectStoreNames.contains('media')) {
                        newDb.createObjectStore('media');
                    }
                };

                retryReq.onsuccess = () => resolve(retryReq.result);
                retryReq.onerror = () => reject(retryReq.error);
            } else {
                resolve(db);
            }
        };

        req.onerror = () => reject(req.error);
    });
};

    const saveFile = async (dbName, file) => {
        if (!file) return;

        const db = await openDB(dbName);
        const tx = db.transaction('media', 'readwrite');
        const store = tx.objectStore('media');

        store.put(file, 'current_bg');

        tx.oncomplete = () => location.reload();
    };

    const loadFile = async (dbName) => {
        try {
            const db = await openDB(dbName);

            if (!db.objectStoreNames.contains('media')) return null;

            return new Promise((resolve) => {
                const tx = db.transaction('media', 'readonly');
                const store = tx.objectStore('media');

                const req = store.get('current_bg');

                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
        } catch {
            return null;
        }
    };

    async function applyGlobalStyle() {
        const file = await loadFile('GlobalBackgroundDB');
        if (!file) return;

        let container = document.getElementById('global-background-layer');

        if (!container) {
            container = document.createElement('div');
            container.id = 'global-background-layer';
            document.body.prepend(container);
        }

        if (!container.dataset.loaded) {
            const url = URL.createObjectURL(file);

            container.innerHTML = file.type.startsWith('video/')
                ? `<video id="gb-video" src="${url}" autoplay loop muted playsinline></video>`
                : `<div id="gb-image" style="background-image: url('${url}')"></div>`;

            container.dataset.loaded = "true";
        }
    }

    async function initVibeMedia() {
        const vibe = document.querySelector('[class*="MainPage_vibe"]') ||
                     document.querySelector('[data-test-id="VIBE_BLOCK"]');

        if (!vibe) return;

        vibe.style.setProperty('height', 'calc(100vh - 70px)', 'important');
        vibe.style.setProperty('padding', '0', 'important');

        let container = document.getElementById('vibe-media-container');

        if (!container) {
            container = document.createElement('div');
            container.id = 'vibe-media-container';
            vibe.prepend(container);
        }

        const file = await loadFile('VibeVideoDB');

        if (file && !container.dataset.loaded) {
            const url = URL.createObjectURL(file);

            container.innerHTML = file.type.startsWith('video/')
                ? `<video id="vibe-video" src="${url}" autoplay loop muted playsinline></video>`
                : `<div id="vibe-image-layer" style="background-image: url('${url}')"></div>`;

            container.dataset.loaded = "true";
        }
    }

    function injectMenu() {
        const anchorBtn = document.querySelector('.TitleBar_button__9MptL');

        if (!anchorBtn || document.getElementById('bg-menu-root')) return;

        const menuRoot = document.createElement('div');
        menuRoot.id = 'bg-menu-root';
        menuRoot.innerHTML = `<div id="bg-menu-button">Смена фонов</div>`;

        anchorBtn.parentNode.insertBefore(menuRoot, anchorBtn);

        let dropdown = document.getElementById('bg-menu-dropdown');

        if (!dropdown) {
            dropdown = document.createElement('div');
            dropdown.id = 'bg-menu-dropdown';
            dropdown.innerHTML = `
                <div class="bg-menu-item" id="btn-set-global">Глобальный фон</div>
                <div class="bg-menu-item" id="btn-set-vibe">Фон Волны</div>
            `;
            document.body.appendChild(dropdown);
        }

        const btn = document.getElementById('bg-menu-button');

        btn.onmousedown = (e) => {
            e.preventDefault();
            e.stopPropagation();

            const rect = btn.getBoundingClientRect();

            dropdown.style.top = `${rect.bottom + 5}px`;
            dropdown.style.left = `${rect.left - 130}px`;

            dropdown.classList.toggle('active');
        };

        const openPicker = (db) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'video/mp4,video/webm,image/*';

            input.onchange = e => saveFile(db, e.target.files[0]);
            input.click();
        };

        document.getElementById('btn-set-global').onclick = () => openPicker('GlobalBackgroundDB');
        document.getElementById('btn-set-vibe').onclick = () => openPicker('VibeVideoDB');

        document.addEventListener('mousedown', (e) => {
            if (!dropdown.contains(e.target) && e.target !== btn) {
                dropdown.classList.remove('active');
            }
        });
    }

    setInterval(() => {
        applyGlobalStyle();
        initVibeMedia();
        injectMenu();
    }, 500);

})();