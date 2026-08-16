
const GITHUB_CONFIG = {
    owner: 'Vyn-OS',
    repo: 'CoreAssets',
    branch: 'main'
};

function isGithubConfigured() {
    return GITHUB_CONFIG.owner && GITHUB_CONFIG.owner !== 'TU_USUARIO_GITHUB'
        && GITHUB_CONFIG.repo && GITHUB_CONFIG.repo !== 'TU_REPO';
}

function getGithubToken() {
    let token = sessionStorage.getItem('gh_pat');
    if (!token) {
        token = window.prompt('Pega tu GitHub Token (permiso de escritura en este repo):');
        if (token) sessionStorage.setItem('gh_pat', token.trim());
    }
    return token ? token.trim() : null;
}

function clearGithubToken() {
    sessionStorage.removeItem('gh_pat');
}

function b64EncodeUnicode(str) {
    return btoa(unescape(encodeURIComponent(str)));
}

async function githubApiRequest(path, options = {}) {
    const token = getGithubToken();
    if (!token) throw new Error('Falta el token de GitHub');
    const res = await fetch(`https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/contents/${path}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            ...(options.headers || {})
        }
    });
    if (res.status === 401 || res.status === 403) {
        clearGithubToken();
        throw new Error('Token inválido o sin permisos. Vuelve a intentar y pega uno válido.');
    }
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Error de GitHub API (${res.status})`);
    }
    return res.json();
}

async function saveFileToGithub(path, content, commitMessage) {
    let sha = null;
    try {
        const current = await githubApiRequest(`${path}?ref=${GITHUB_CONFIG.branch}`);
        sha = current.sha;
    } catch (e) {
    }

    const body = {
        message: commitMessage,
        content: b64EncodeUnicode(content),
        branch: GITHUB_CONFIG.branch
    };
    if (sha) body.sha = sha;

    return githubApiRequest(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

function fromFileFormat(m) {
    return {
        id: m.id,
        title: m.nome,
        desc: m.descricaoLonga || m.descricao || '',
        descShort: m.descricao || (m.descricaoLonga || '').slice(0, 60),
        fileUrl: m.linkDownload,
        fileFormat: m.formato || '',
        fileSize: m.tamanho || '',
        categoria: Array.isArray(m.categoria) ? m.categoria : (m.categoria ? [m.categoria] : []),
        imagenes: m.imagens || [],
        img: (m.imagens && m.imagens[0]) || '',
        status: m.status || 'nenhum',
        fail: m.fail || 'none'
    };
}

function toFileFormat(a) {
    return {
        id: a.id,
        nome: a.title,
        categoria: a.categoria || [],
        descricao: (a.descShort || '').trim() || (a.desc || '').slice(0, 60),
        descricaoLonga: a.desc || '',
        imagens: a.imagenes || [],
        linkDownload: a.fileUrl,
        formato: a.fileFormat || '',
        tamanho: a.fileSize || '',
        status: a.status || 'nenhum',
        fail: a.fail || 'none'
    };
}

let libraryAssets = (typeof bibliotecaMeshes !== 'undefined' ? bibliotecaMeshes : []).map(m => ({ ...fromFileFormat(m), isLibrary: true }));

let assets = (typeof assetsCreados !== 'undefined' ? assetsCreados : []).map(fromFileFormat);
let assetToDelete = null;
let assetToDeleteSource = 'admin';

let assetsFileHandle = null;
let pendingReconnectHandler = null;

function idbOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('assetRobloxDB', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('handles');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('handles', 'readonly');
        const req = tx.objectStore('handles').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function saveConnectedFileName(key, name) {
    try { localStorage.setItem(key, name); } catch (e) {  }
}
function getConnectedFileName(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}

function setFileStatus(connected, label) {
    const dot = document.getElementById('fileStatusDot');
    const text = document.getElementById('fileStatusText');
    const box = document.getElementById('fileStatusBox');
    if (!dot || !text) return;
    dot.classList.toggle('bg-red-500', !connected);
    dot.classList.toggle('bg-green-500', connected);
    text.innerText = label;
    if (box) box.classList.toggle('hidden', connected);
}

async function connectAssetsFile(silent = false) {
    if (!window.showOpenFilePicker) {
        if (!silent) showNotify("Tu navegador no soporta guardado automático (usa Chrome o Edge).", "error");
        return;
    }
    if (pendingReconnectHandler) {
        document.removeEventListener('click', pendingReconnectHandler);
        pendingReconnectHandler = null;
    }
    try {
        const [handle] = await window.showOpenFilePicker({
            types: [{ description: 'Archivo JS', accept: { 'text/javascript': ['.js'] } }],
            excludeAcceptAllOption: false,
            multiple: false
        });
        assetsFileHandle = handle;
        await idbSet('assetsFileHandle', handle);
        saveConnectedFileName('assetsFileName', handle.name);
        setFileStatus(true, `Connected to ${handle.name}`);
        if (!silent) showNotify("Vyn-assets.js conectado ✔️");
    } catch (e) {

    }
}

async function tryReconnectAssetsFile() {
    if (!document.getElementById('fileStatusDot')) return;
    if (!window.showOpenFilePicker) {
        setFileStatus(false, "Browser without auto-save support");
        return;
    }
    try {
        const handle = await idbGet('assetsFileHandle');
        if (!handle) {
            const savedName = getConnectedFileName('assetsFileName');
            setFileStatus(false, savedName ? `Not connected to ${savedName}` : "Not connected to Vyn-assets.js");
            return;
        }

        const perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
            assetsFileHandle = handle;
            saveConnectedFileName('assetsFileName', handle.name);
            setFileStatus(true, `Connected to ${handle.name}`);
            return;
        }

        setFileStatus(false, `Click anywhere to reconnect to ${handle.name}`);
        pendingReconnectHandler = () => { pendingReconnectHandler = null; silentReconnect(handle); };
        document.addEventListener('click', pendingReconnectHandler, { once: true });
    } catch (e) {
        const savedName = getConnectedFileName('assetsFileName');
        setFileStatus(false, savedName ? `Not connected to ${savedName}` : "Not connected to Vyn-assets.js");
    }
}

async function silentReconnect(handle) {
    try {
        const perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
            assetsFileHandle = handle;
            setFileStatus(true, `Connected to ${handle.name}`);
        } else {
            setFileStatus(false, "Reconnect required (click Connect File)");
        }
    } catch (e) {
        setFileStatus(false, "Reconnect required (click Connect File)");
    }
}

function generateAssetsFileContent(assetsArr) {
    const data = assetsArr.map(toFileFormat);
    return "var assetsCreados = " + JSON.stringify(data, null, 4) + ";\n";
}

function downloadAssetsFile(content) {
    const blob = new Blob([content], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Vyn-assets.js';
    a.click();
    URL.revokeObjectURL(url);
}

async function persistAssets() {
    const content = generateAssetsFileContent(assets);

    if (isGithubConfigured()) {
        try {
            await saveFileToGithub('Vyn-assets.js', content, 'Update assets from admin panel');
            setFileStatus(true, 'Publicado en GitHub ✔️');
            showNotify("Cambios publicados en GitHub. La web se actualiza en ~1 min.");
            return;
        } catch (e) {
            console.error(e);
            showNotify("Error al publicar en GitHub: " + e.message, "error");
        }
    }

    if (!assetsFileHandle) {
        try {
            const handle = await idbGet('assetsFileHandle');
            if (handle) assetsFileHandle = handle;
        } catch (e) {  }
    }

    if (!assetsFileHandle) {
        showNotify("Conecta primero Vyn-assets.js con el botón 🔗 Connect File.", "error");
        return;
    }

    try {
        let perm = await assetsFileHandle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') perm = await assetsFileHandle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') throw new Error('permiso denegado');

        const writable = await assetsFileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        setFileStatus(true, `Saved to ${assetsFileHandle.name}`);
    } catch (e) {
        console.error(e);
        downloadAssetsFile(content);
        showNotify("No se pudo guardar automáticamente. Se descargó el archivo, reemplázalo manualmente en tu carpeta.", "error");
    }
}

let libraryFileHandle = null;
let pendingLibraryReconnectHandler = null;

async function connectLibraryFile(silent = false) {
    if (!window.showOpenFilePicker) {
        if (!silent) showNotify("Tu navegador no soporta guardado automático (usa Chrome o Edge).", "error");
        return;
    }
    if (pendingLibraryReconnectHandler) {
        document.removeEventListener('click', pendingLibraryReconnectHandler);
        pendingLibraryReconnectHandler = null;
    }
    try {
        const [handle] = await window.showOpenFilePicker({
            types: [{ description: 'Archivo JS', accept: { 'text/javascript': ['.js'] } }],
            excludeAcceptAllOption: false,
            multiple: false
        });
        libraryFileHandle = handle;
        await idbSet('libraryFileHandle', handle);
        saveConnectedFileName('libraryFileName', handle.name);
        setLibraryFileStatus(true, `Connected to ${handle.name}`);
        if (!silent) showNotify("Vyn-body.js conectado ✔️");
    } catch (e) {

    }
}

function setLibraryFileStatus(connected, label) {
    const dot = document.getElementById('libraryFileStatusDot');
    const text = document.getElementById('libraryFileStatusText');
    const box = document.getElementById('libraryFileStatusBox');
    if (!dot || !text) return;
    dot.classList.toggle('bg-red-500', !connected);
    dot.classList.toggle('bg-green-500', connected);
    text.innerText = label;
    if (box) box.classList.toggle('hidden', connected);
}

async function tryReconnectLibraryFile() {
    if (!document.getElementById('libraryFileStatusDot')) return;
    if (!window.showOpenFilePicker) {
        setLibraryFileStatus(false, "Browser without auto-save support");
        return;
    }
    try {
        const handle = await idbGet('libraryFileHandle');
        if (!handle) {
            const savedName = getConnectedFileName('libraryFileName');
            setLibraryFileStatus(false, savedName ? `Not connected to ${savedName}` : "Not connected to Vyn-body.js");
            return;
        }

        const perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
            libraryFileHandle = handle;
            saveConnectedFileName('libraryFileName', handle.name);
            setLibraryFileStatus(true, `Connected to ${handle.name}`);
            return;
        }

        setLibraryFileStatus(false, `Click anywhere to reconnect to ${handle.name}`);
        pendingLibraryReconnectHandler = () => { pendingLibraryReconnectHandler = null; silentReconnectLibrary(handle); };
        document.addEventListener('click', pendingLibraryReconnectHandler, { once: true });
    } catch (e) {
        const savedName = getConnectedFileName('libraryFileName');
        setLibraryFileStatus(false, savedName ? `Not connected to ${savedName}` : "Not connected to Vyn-body.js");
    }
}

async function silentReconnectLibrary(handle) {
    try {
        const perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
            libraryFileHandle = handle;
            setLibraryFileStatus(true, `Connected to ${handle.name}`);
        } else {
            setLibraryFileStatus(false, "Reconnect required (click Connect Library File)");
        }
    } catch (e) {
        setLibraryFileStatus(false, "Reconnect required (click Connect Library File)");
    }
}

function generateLibraryFileContent(itemsArr) {
    const data = itemsArr.map(toFileFormat).map(({ status, fail, ...rest }) => rest);
    return "bibliotecaMeshes.push(\n" + JSON.stringify(data, null, 4).replace(/^\[/, '').replace(/\]$/, '') + "\n);\n";
}

function downloadLibraryFile(content) {
    const blob = new Blob([content], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Vyn-body.js';
    a.click();
    URL.revokeObjectURL(url);
}

async function persistLibraryAssets() {
    const content = generateLibraryFileContent(libraryAssets);

    if (isGithubConfigured()) {
        try {
            await saveFileToGithub('Vyn-body.js', content, 'Update library assets from admin panel');
            setLibraryFileStatus(true, 'Publicado en GitHub ✔️');
            showNotify("Cambios publicados en GitHub. La web se actualiza en ~1 min.");
            return;
        } catch (e) {
            console.error(e);
            showNotify("Error al publicar en GitHub: " + e.message, "error");
        }
    }

    if (!libraryFileHandle) {
        try {
            const handle = await idbGet('libraryFileHandle');
            if (handle) libraryFileHandle = handle;
        } catch (e) {  }
    }

    if (!libraryFileHandle) {
        showNotify("Conecta primero Vyn-body.js con el botón 🔗 Connect Library File.", "error");
        return;
    }

    try {
        let perm = await libraryFileHandle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') perm = await libraryFileHandle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') throw new Error('permiso denegado');

        const writable = await libraryFileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        setLibraryFileStatus(true, `Saved to ${libraryFileHandle.name}`);
    } catch (e) {
        console.error(e);
        downloadLibraryFile(content);
        showNotify("No se pudo guardar automáticamente. Se descargó Vyn-body.js, reemplázalo manualmente en tu carpeta.", "error");
    }
}

const allAssets = [...libraryAssets, ...assets];

const FAVORITES_KEY = 'coreassets_favorites';

function getFavorites() {
    try { return JSON.parse(localStorage.getItem(FAVORITES_KEY)) || []; }
    catch (e) { return []; }
}

function isFavorite(id) {
    return getFavorites().includes(String(id));
}

function toggleFavorite(id) {
    const favs = getFavorites();
    const idx = favs.indexOf(String(id));
    if (idx === -1) {
        favs.push(String(id));
        showNotify("Added to favorites ❤️");
    } else {
        favs.splice(idx, 1);
        showNotify("Removed from favorites");
    }
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs)); } catch (e) {  }

    const nowFav = isFavorite(id);
    document.querySelectorAll(`.fav-btn[data-id="${id}"]`).forEach(heartBtn => {
        const icon = heartBtn.querySelector('.fav-icon');
        if (icon) {
            icon.setAttribute('fill', nowFav ? '#ef4444' : 'none');
            icon.setAttribute('stroke', nowFav ? '#ef4444' : '#ffffff');
        }
    });

    if (filtroActual === "FAVORITES") animarCambioDeGrid();
}

let filtroActual = "ALL";
const LIMITE_CATEGORIAS_VISIBLES = 5;

function renderFilters() {
    const mainFiltersContainer = document.getElementById("main-filters");
    const extraFiltersContainer = document.getElementById("extra-filters");
    if (!mainFiltersContainer) return;

    mainFiltersContainer.innerHTML = "";
    extraFiltersContainer.innerHTML = "";

    let todasCategorias = [];
    allAssets.forEach(item => {
        (item.categoria || []).forEach(cat => todasCategorias.push(String(cat).toUpperCase()));
    });

    const categoriasUnicas = ["ALL", ...new Set(todasCategorias)];
    const visibles = categoriasUnicas.slice(0, LIMITE_CATEGORIAS_VISIBLES);
    const extras = categoriasUnicas.slice(LIMITE_CATEGORIAS_VISIBLES);

    mainFiltersContainer.appendChild(crearBotonFiltro("FAVORITES", "❤️"));
    visibles.forEach(cat => mainFiltersContainer.appendChild(crearBotonFiltro(cat)));

    if (extras.length > 0) {
        const btnToggle = document.createElement("button");
        btnToggle.className = "px-4 py-1.5 rounded-full font-bold text-xs border border-white/10 text-slate-400 hover:text-white hover:border-white/30 transition";
        btnToggle.innerText = "More +";
        btnToggle.onclick = () => {
            const isOpen = extraFiltersContainer.classList.toggle("hidden");
            extraFiltersContainer.classList.toggle("flex", !isOpen);
            btnToggle.innerText = isOpen ? "More +" : "Close ✕";
        };
        mainFiltersContainer.appendChild(btnToggle);
        extras.forEach(cat => extraFiltersContainer.appendChild(crearBotonFiltro(cat)));
    }
}

function crearBotonFiltro(categoriaNombre, etiqueta = null) {
    const btn = document.createElement("button");
    const isActive = filtroActual === categoriaNombre;
    btn.className = `px-4 py-1.5 rounded-full font-bold text-xs border transition ${isActive ? 'border-cyan-400 text-cyan-400 bg-cyan-400/10' : 'border-white/10 text-slate-400 hover:text-white hover:border-white/30'}`;
    btn.innerText = etiqueta || (categoriaNombre.charAt(0) + categoriaNombre.slice(1).toLowerCase());
    btn.setAttribute("data-filter", categoriaNombre);
    btn.addEventListener("click", () => {
        if (filtroActual === categoriaNombre) return;
        filtroActual = categoriaNombre;
        renderFilters();
        animarCambioDeGrid();
    });
    return btn;
}

function animarCambioDeGrid() {
    const grid = document.getElementById('assetGrid');
    if (!grid) { renderAssetGrid(); return; }
    grid.classList.add('grid-fade-out');
    setTimeout(() => {
        renderAssetGrid();
        grid.classList.remove('grid-fade-out');
    }, 200);
}

function renderMedia(url, sizeClasses, extraClasses = '', interactive = false) {
    if (!url) return `<div class="${sizeClasses} ${extraClasses} bg-slate-800"></div>`;

    const streamableMatch = url.match(/streamable\.com\/([a-zA-Z0-9]+)/i);
    if (streamableMatch) {
        const params = interactive ? 'autoplay=1&muted=1&loop=1' : 'autoplay=1&muted=1&loop=1&nocontrols=1';
        const pointerStyle = interactive ? '' : 'pointer-events:none;';
        return `<div class="${sizeClasses} ${extraClasses} relative overflow-hidden bg-black">
            <iframe src="https://streamable.com/e/${streamableMatch[1]}?${params}" class="absolute inset-0 w-full h-full" style="${pointerStyle}" frameborder="0" allow="autoplay; fullscreen" allowfullscreen></iframe>
        </div>`;
    }

    if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(url)) {
        return `<video class="${sizeClasses} ${extraClasses} object-cover" src="${url}" autoplay muted loop playsinline ${interactive ? 'controls' : ''}></video>`;
    }

    return `<div class="${sizeClasses} ${extraClasses} bg-cover bg-center" style="background-image: url('${url}')"></div>`;
}

function showNotify(text, type = 'success') {
    const container = document.getElementById('notification-container');
    if(!container) return;
    const toast = document.createElement('div');
    const styles = {
        success: { color: 'bg-green-600', icon: '✅' },
        error: { color: 'bg-red-600', icon: '❌' },
        download: { color: 'bg-blue-600', icon: '<span class="download-icon-pulse">⬇️</span>' }
    };
    const s = styles[type] || styles.success;
    toast.className = `${s.color} text-white px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-3 toast-in mb-2 font-bold z-50`;
    toast.innerHTML = `<span>${s.icon}</span><span>${text}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.remove('toast-in');
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

let adminQuickLoginOpen = false;

function showAdminQuickLogin() {
    const btn = document.getElementById('adminBtn');
    const box = document.getElementById('adminLoginBox');
    const input = document.getElementById('adminQuickPass');
    if (!btn || !box || !input) return;

    btn.classList.add('blur-sm', 'opacity-30', 'pointer-events-none');
    box.classList.remove('hidden');

    if (adminQuickLoginOpen) return;
    adminQuickLoginOpen = true;

    input.value = '';
    updateAdminQuickLabel();
    input.focus();

    input.addEventListener('input', updateAdminQuickLabel);
    input.addEventListener('keypress', function onKey(e) {
        if (e.key === 'Enter') checkAdminQuickLogin(input.value);
    });
}

function maybeHideAdminQuickLogin() {
    const input = document.getElementById('adminQuickPass');
    if (!input) return;
    setTimeout(() => {
        if (!input.value) hideAdminQuickLogin();
    }, 150);
}

function hideAdminQuickLogin() {
    const btn = document.getElementById('adminBtn');
    const box = document.getElementById('adminLoginBox');
    const input = document.getElementById('adminQuickPass');
    if (!btn || !box) return;
    if (input) input.blur();
    btn.classList.remove('blur-sm', 'opacity-30', 'pointer-events-none');
    box.classList.add('hidden');
    adminQuickLoginOpen = false;
}

function updateAdminQuickLabel() {
    const input = document.getElementById('adminQuickPass');
    const label = document.getElementById('adminQuickPassLabel');
    if (!input || !label) return;
    label.classList.toggle('opacity-0', input.value.length > 0);
}

function checkAdminQuickLogin(value) {
    if (value === 'mdrg') {
        sessionStorage.setItem('adminAutoLogin', '1');
        location.href = 'admin.html';
    } else {
        showNotify("Incorrect password!", "error");
        const input = document.getElementById('adminQuickPass');
        if (input) { input.value = ''; updateAdminQuickLabel(); input.focus(); }
    }
}

const passInput = document.getElementById('pass');
if(passInput) {
    passInput.addEventListener('keypress', (e) => {
        if(e.key === 'Enter') login();
    });
}

function login() {
    if (document.getElementById('pass').value === 'MDRG') {
        document.getElementById('loginOverlay').classList.add('hidden');
        document.getElementById('adminContent').classList.remove('hidden');
        renderManageList();
        showNotify("Access granted!");
    } else {
        showNotify("Incorrect password!", "error");
    }
}

function tryAutoLoginAdmin() {
    const loginOverlay = document.getElementById('loginOverlay');
    const adminContent = document.getElementById('adminContent');
    if (!loginOverlay || !adminContent) return;
    if (sessionStorage.getItem('adminAutoLogin') === '1') {
        sessionStorage.removeItem('adminAutoLogin');
        loginOverlay.classList.add('hidden');
        adminContent.classList.remove('hidden');
        renderManageList();
        showNotify("Access granted!");
    }
}
tryAutoLoginAdmin();

function addImageField(value = '') {
    const list = document.getElementById('assetImgList');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'flex gap-2';
    row.innerHTML = `
        <input type="text" value="${value ? value.replace(/"/g, '&quot;') : ''}" placeholder="https://i.postimg.cc/..." class="asset-img-field flex-1 bg-black/50 p-4 rounded-xl border border-white/5 outline-none focus:border-blue-500">
        <button type="button" onclick="this.parentElement.remove()" class="bg-red-600/10 text-red-500 hover:bg-red-600 hover:text-white transition px-4 rounded-xl font-bold">✕</button>
    `;
    list.appendChild(row);
}

function collectImageFields() {
    return Array.from(document.querySelectorAll('#assetImgList .asset-img-field'))
        .map(i => i.value.trim())
        .filter(Boolean);
}

function setImageFields(urls) {
    const list = document.getElementById('assetImgList');
    if (!list) return;
    list.innerHTML = '';
    (urls && urls.length ? urls : ['']).forEach(u => addImageField(u));
}

async function saveAsset() {
    const id = document.getElementById('editId').value;
    const source = document.getElementById('editSource').value || 'admin';
    const title = document.getElementById('assetTitle').value;
    const desc = document.getElementById('assetDesc').value;
    const descShort = document.getElementById('assetDescShort').value;
    const fileUrl = document.getElementById('assetFileUrl').value;
    const fileFormat = document.getElementById('assetFileFormat').value;
    const fileSize = document.getElementById('assetFileSize').value;
    const categoriaRaw = document.getElementById('assetCategory').value;
    const categoria = categoriaRaw.split(',').map(c => c.trim()).filter(Boolean);
    const status = document.getElementById('assetStatus').value;
    const fail = document.getElementById('assetFail').value;
    const imagenes = collectImageFields();

    if (!title || !fileUrl) return showNotify("Title and Link are required!", "error");

    try {
        if (id) {

            const list = source === 'library' ? libraryAssets : assets;
            let a = list.find(x => x.id == id);
            if (!a) return showNotify("Asset not found.", "error");
            a.title = title; a.desc = desc; a.descShort = descShort; a.fileUrl = fileUrl; a.status = status; a.fail = fail;
            a.fileFormat = fileFormat; a.fileSize = fileSize; a.categoria = categoria;

            if (imagenes.length) {
                a.imagenes = imagenes;
                a.img = imagenes[0];
            }
            showNotify((source === 'library' ? "Library asset" : "Asset") + " updated!");

            if (source === 'library') {
                await persistLibraryAssets();
            } else {
                await persistAssets();
            }
        } else {

            if (!imagenes.length) return showNotify("Please enter at least one image URL!", "error");
            assets.push({ id: Date.now(), title, desc, descShort, fileUrl, status, fail, fileFormat, fileSize, categoria, imagenes, img: imagenes[0] });
            showNotify("Asset created!");
            await persistAssets();
        }

        resetForm();
        renderManageList();
        switchTab('manage');
    } catch (e) {
        console.error(e);
        showNotify("Error saving the asset.", "error");
    }
}

function renderAssetGrid() {
    const grid = document.getElementById('assetGrid');
    if (!grid) return;

    const itemsFiltrados = allAssets.filter(a => {
        if (filtroActual === "ALL") return true;
        if (filtroActual === "FAVORITES") return isFavorite(a.id);
        return (a.categoria || []).some(cat => String(cat).toUpperCase() === filtroActual);
    });

    if (filtroActual === "FAVORITES" && itemsFiltrados.length === 0) {
        grid.innerHTML = `<p class="col-span-full text-center text-slate-500 py-16">No favorites yet — tap the 🤍 on any asset to save it here.</p>`;
        return;
    }

    const ORDEN_CATEGORIAS = ["BODY", "GAMES", "ANIMATIONS", "ASSETS"];
    function prioridadCategoria(item) {
        const cats = (item.categoria || []).map(c => String(c).toUpperCase());
        let mejorPrioridad = ORDEN_CATEGORIAS.length;
        cats.forEach(cat => {
            const idx = ORDEN_CATEGORIAS.indexOf(cat);
            if (idx !== -1 && idx < mejorPrioridad) mejorPrioridad = idx;
        });
        return mejorPrioridad;
    }
    itemsFiltrados.sort((a, b) => prioridadCategoria(a) - prioridadCategoria(b));

    if (itemsFiltrados.length === 0) {
        grid.innerHTML = `<p class="col-span-full text-center text-slate-500 py-16">No items found in this category.</p>`;
        return;
    }

    grid.innerHTML = "";
    itemsFiltrados.forEach((a, i) => {

        const statusLabels = { 'nenhum': '', 'novo': 'New', 'limitado': 'Limited', 'recomendado': 'Recommended' };
        const label = statusLabels[a.status] || a.status;

        const badge = a.status && a.status !== 'nenhum' ? `<span class="absolute top-4 left-4 px-3 py-1 rounded-full text-[10px] font-black uppercase badge-${a.status} z-10">${label}</span>` : '';

        const fileMeta = (a.fileFormat || a.fileSize) ? `
                        <div class="flex gap-2 mt-3">
                            ${a.fileFormat ? `<span class="bg-white/5 text-slate-300 text-[10px] font-bold uppercase px-2 py-1 rounded-lg">${a.fileFormat}</span>` : ''}
                            ${a.fileSize ? `<span class="bg-white/5 text-slate-300 text-[10px] font-bold uppercase px-2 py-1 rounded-lg">${a.fileSize}</span>` : ''}
                        </div>` : '';

        const delayMs = Math.min(i, 10) * 40;

        grid.innerHTML += `
            <div class="asset-card relative bg-slate-900 border border-white/5 rounded-3xl overflow-hidden group hover:border-blue-500 transition-all duration-300 animate__animated animate__fadeInUp" style="animation-delay:${delayMs}ms; animation-duration:0.4s;">
                ${badge}
                <button onclick="event.stopPropagation(); handleDownload('${a.id}')" class="shortcut-btn absolute top-4 right-4 bg-blue-600 p-3 rounded-xl z-20 opacity-0 translate-y-[-10px] transition-all hover:bg-blue-500 shadow-xl">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                </button>
                <button onclick="event.stopPropagation(); toggleFavorite('${a.id}')" data-id="${a.id}" data-context="grid" class="fav-btn shortcut-btn absolute top-16 right-4 w-9 h-9 flex items-center justify-center bg-slate-950/80 rounded-xl z-20 opacity-0 translate-y-[-10px] transition-all hover:bg-slate-900 shadow-xl">
                    <svg class="fav-icon" width="16" height="16" viewBox="0 0 24 24" fill="${isFavorite(a.id) ? '#ef4444' : 'none'}" stroke="${isFavorite(a.id) ? '#ef4444' : '#ffffff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6.7-4.35-9.3-8.28C1.1 10.3 1.7 6.9 4.6 5.4c2.4-1.24 5-.3 6.4 1.7 1.4-2 4-2.94 6.4-1.7 2.9 1.5 3.5 4.9 1.9 7.32C18.7 16.65 12 21 12 21z"/></svg>
                </button>
                <div onclick="openAssetDetail('${a.id}')" class="cursor-pointer">
                    ${renderMedia(a.img, 'h-52 w-full', 'transition-transform duration-500 group-hover:scale-110')}
                    <div class="p-6">
                        <h3 class="text-xl font-bold mb-2 transition-colors">${a.title}</h3>
                        <p class="text-slate-500 text-sm line-clamp-2">${a.descShort || a.desc || 'Click to see details.'}</p>
                        ${fileMeta}
                    </div>
                </div>
            </div>`;
    });
}

if (document.getElementById('assetGrid')) {
    renderFilters();
    renderAssetGrid();
}

if (document.getElementById('assetImgList')) {
    setImageFields([]);
}

function buildAssetDetailHTML(a) {
    const statusLabels = { 'nenhum': 'Standard', 'novo': 'New', 'limitado': 'Limited', 'recomendado': 'Recommended' };
    const label = statusLabels[a.status] || a.status;
    const imagenes = (a.imagenes && a.imagenes.length) ? a.imagenes : (a.img ? [a.img] : []);
    window.__detailImages = imagenes;
    window.__detailIndex = 0;

    const navButtons = imagenes.length > 1 ? `
                <button onclick="changeDetailSlide(-1)" class="slide-nav prev absolute left-3 top-1/2 -translate-y-1/2 bg-black/60 hover:bg-blue-600 text-white p-3 rounded-xl z-10">‹</button>
                <button onclick="changeDetailSlide(1)" class="slide-nav next absolute right-3 top-1/2 -translate-y-1/2 bg-black/60 hover:bg-blue-600 text-white p-3 rounded-xl z-10">›</button>
                <div class="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5 z-10">
                    ${imagenes.map((_, i) => `<span class="detail-dot w-2 h-2 rounded-full ${i === 0 ? 'bg-blue-500' : 'bg-white/30'}"></span>`).join('')}
                </div>` : '';

    return `
        <div class="bg-slate-900 rounded-3xl overflow-hidden border border-white/5 shadow-2xl">
            <div class="relative">
                <div id="detailMedia">${renderMedia(imagenes[0] || '', 'w-full h-[450px]', '', true)}</div>
                ${navButtons}
            </div>
            <div class="p-10 text-left">
                ${(a.categoria && a.categoria.length) ? `<span class="inline-block mb-4 px-3 py-1 rounded-full text-[10px] font-black uppercase bg-cyan-400/10 text-cyan-400 border border-cyan-400/20">${a.categoria.join(' / ')}</span>` : ''}
                <div class="flex justify-between items-center mb-6 gap-3">
                    <h1 class="text-4xl font-black">${a.title}</h1>
                    <div class="flex items-center gap-2 shrink-0">
                        <button onclick="toggleFavorite('${a.id}')" data-id="${a.id}" data-context="modal" class="fav-btn bg-black/20 border border-white/5 hover:bg-slate-800 w-11 h-11 flex items-center justify-center rounded-xl transition">
                            <svg class="fav-icon" width="18" height="18" viewBox="0 0 24 24" fill="${isFavorite(a.id) ? '#ef4444' : 'none'}" stroke="${isFavorite(a.id) ? '#ef4444' : '#ffffff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6.7-4.35-9.3-8.28C1.1 10.3 1.7 6.9 4.6 5.4c2.4-1.24 5-.3 6.4 1.7 1.4-2 4-2.94 6.4-1.7 2.9 1.5 3.5 4.9 1.9 7.32C18.7 16.65 12 21 12 21z"/></svg>
                        </button>
                        <span class="px-4 py-2 rounded-full text-[10px] font-black uppercase bg-blue-600/20 text-blue-400 border border-blue-500/20">${label}</span>
                    </div>
                </div>
                ${(a.fileFormat || a.fileSize) ? `
                <div class="flex gap-3 mb-8">
                    ${a.fileFormat ? `<div class="bg-black/20 border border-white/5 rounded-xl px-4 py-3"><p class="text-slate-500 text-[10px] uppercase font-bold">Format</p><p class="font-bold">${a.fileFormat}</p></div>` : ''}
                    ${a.fileSize ? `<div class="bg-black/20 border border-white/5 rounded-xl px-4 py-3"><p class="text-slate-500 text-[10px] uppercase font-bold">Size</p><p class="font-bold">${a.fileSize}</p></div>` : ''}
                </div>` : ''}
                <div class="bg-black/20 p-6 rounded-2xl border border-white/5 mb-8">
                    <h3 class="text-blue-500 font-bold mb-2 uppercase text-xs">Description</h3>
                    <p class="text-slate-300 leading-relaxed whitespace-pre-line">${a.desc || 'No technical description available.'}</p>
                </div>
                <button onclick="handleDownload('${a.id}')" class="w-full bg-blue-600 py-6 rounded-2xl font-black text-2xl hover:bg-blue-500 transition shadow-xl shadow-blue-900/30">
                    DOWNLOAD
                </button>
            </div>
        </div>`;
}

function openAssetDetail(id, replaceHistory = false) {
    const overlay = document.getElementById('assetModalOverlay');
    const content = document.getElementById('assetModalContent');
    const wrapper = document.getElementById('pageWrapper');
    if (!overlay || !content) return;

    const a = allAssets.find(x => x.id == id);
    if (!a) return;

    content.innerHTML = buildAssetDetailHTML(a);

    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    const url = new URL(window.location);
    url.searchParams.set('asset', id);
    if (replaceHistory) history.replaceState({ asset: id }, '', url);
    else history.pushState({ asset: id }, '', url);

    requestAnimationFrame(() => {
        if (wrapper) wrapper.classList.add('page-blurred');
        document.getElementById('assetModalBackdrop').classList.remove('opacity-0');
        content.classList.remove('opacity-0', 'translate-y-6', 'scale-[0.97]');
    });
}

function closeAssetDetail(skipHistory = false) {
    const overlay = document.getElementById('assetModalOverlay');
    const content = document.getElementById('assetModalContent');
    const wrapper = document.getElementById('pageWrapper');
    if (!overlay || overlay.classList.contains('hidden')) return;

    if (wrapper) wrapper.classList.remove('page-blurred');
    document.getElementById('assetModalBackdrop').classList.add('opacity-0');
    content.classList.add('opacity-0', 'translate-y-6', 'scale-[0.97]');

    setTimeout(() => {
        overlay.classList.add('hidden');
        content.innerHTML = '';
        document.body.style.overflow = '';
    }, 350);

    if (!skipHistory) {
        const url = new URL(window.location);
        url.searchParams.delete('asset');
        history.pushState({}, '', url);
    }
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAssetDetail();
});

window.addEventListener('popstate', () => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('asset');
    if (id) openAssetDetail(id, true);
    else closeAssetDetail(true);
});

if (document.getElementById('assetModalOverlay')) {
    const initialParams = new URLSearchParams(window.location.search);
    const initialAssetId = initialParams.get('asset');
    if (initialAssetId) openAssetDetail(initialAssetId, true);
}

function changeDetailSlide(dir) {
    const imgs = window.__detailImages || [];
    if (imgs.length < 2) return;
    window.__detailIndex = (window.__detailIndex + dir + imgs.length) % imgs.length;
    const media = document.getElementById('detailMedia');
    if (media) {
        media.innerHTML = renderMedia(imgs[window.__detailIndex], 'w-full h-[450px]', 'fade-anim', true);
    }
    document.querySelectorAll('.detail-dot').forEach((dot, i) => {
        dot.classList.toggle('bg-blue-500', i === window.__detailIndex);
        dot.classList.toggle('bg-white/30', i !== window.__detailIndex);
    });
}

function resetForm() {
    document.getElementById('editId').value = "";
    document.getElementById('editSource').value = "";
    document.getElementById('assetTitle').value = "";
    document.getElementById('assetDesc').value = "";
    document.getElementById('assetDescShort').value = "";
    document.getElementById('assetFileUrl').value = "";
    document.getElementById('assetFileFormat').value = "";
    document.getElementById('assetFileSize').value = "";
    document.getElementById('assetCategory').value = "";
    setImageFields([]);
    document.getElementById('panelTitle').innerText = "Editor Mode";
}

function handleDownload(id) {
    const a = allAssets.find(x => x.id == id);
    if (a.fail === 'none') {
        window.open(a.fileUrl, '_blank');
    } else {
        const e = { '404': "ERROR 404", 'virus': "RISK: Virus detected!", 'limit': "LIMIT EXCEEDED" };
        showNotify(e[a.fail], "error");
    }
}

function switchTab(t) {
    document.getElementById('sectionForm').classList.toggle('hidden', t !== 'create');
    document.getElementById('sectionManage').classList.toggle('hidden', t !== 'manage');
    if(t === 'manage') renderManageList();
}

function renderManageList() {
    const l = document.getElementById('existingAssetsList');
    if(!l) return;
    const combined = [
        ...libraryAssets.map(a => ({ ...a, __source: 'library' })),
        ...assets.map(a => ({ ...a, __source: 'admin' }))
    ];
    l.innerHTML = combined.length ? "" : "<p class='text-slate-500 text-center py-10'>Empty.</p>";
    combined.forEach(a => {
        const tag = a.__source === 'library'
            ? `<span class="bg-purple-600/20 text-purple-400 text-[10px] font-black uppercase px-2 py-1 rounded-lg">Library</span>`
            : `<span class="bg-blue-600/20 text-blue-400 text-[10px] font-black uppercase px-2 py-1 rounded-lg">Admin</span>`;
        l.innerHTML += `
            <div class="flex items-center justify-between bg-slate-900 p-4 rounded-2xl border border-white/5">
                <div class="flex items-center gap-4">
                    <img src="${a.img}" class="w-12 h-12 rounded-lg object-cover border border-white/10">
                    <div class="flex items-center gap-2">
                        <span class="font-bold text-sm">${a.title}</span>
                        ${tag}
                    </div>
                </div>
                <div class="flex gap-2">
                    <button onclick="prepareEdit('${a.id}', '${a.__source}')" class="bg-blue-600/10 text-blue-400 px-4 py-2 rounded-xl text-xs font-bold uppercase">Edit</button>
                    <button onclick="openDeleteModal('${a.id}', '${a.__source}')" class="bg-red-600/10 text-red-500 px-4 py-2 rounded-xl text-xs font-bold uppercase">Delete</button>
                </div>
            </div>`;
    });
}

function prepareEdit(id, source = 'admin') {
    const list = source === 'library' ? libraryAssets : assets;
    const a = list.find(x => x.id == id);
    if (!a) return;
    document.getElementById('editId').value = a.id;
    document.getElementById('editSource').value = source;
    document.getElementById('assetTitle').value = a.title;
    document.getElementById('assetDesc').value = a.desc || "";
    document.getElementById('assetDescShort').value = a.descShort || "";
    document.getElementById('assetFileUrl').value = a.fileUrl;
    document.getElementById('assetFileFormat').value = a.fileFormat || "";
    document.getElementById('assetFileSize').value = a.fileSize || "";
    document.getElementById('assetCategory').value = (a.categoria || []).join(', ');
    document.getElementById('assetStatus').value = a.status || 'nenhum';
    document.getElementById('assetFail').value = a.fail || 'none';
    setImageFields(a.imagenes && a.imagenes.length ? a.imagenes : (a.img ? [a.img] : []));
    document.getElementById('panelTitle').innerText = "Editing (" + (source === 'library' ? 'Library' : 'Admin') + "): " + a.title;
    switchTab('create');
}

function openDeleteModal(id, source = 'admin') {
    assetToDelete = id;
    assetToDeleteSource = source;
    document.getElementById('deleteModal').classList.remove('hidden');
}
function closeDeleteModal() {
    document.getElementById('deleteModal').classList.add('hidden');
}
document.getElementById('confirmDeleteBtn')?.addEventListener('click', async () => {
    if (assetToDeleteSource === 'library') {
        libraryAssets = libraryAssets.filter(x => x.id != assetToDelete);
        await persistLibraryAssets();
    } else {
        assets = assets.filter(x => x.id != assetToDelete);
        await persistAssets();
    }
    renderManageList();
    closeDeleteModal();
    showNotify("Asset removed!");
});

tryReconnectAssetsFile();
tryReconnectLibraryFile();

