const WORKER_URL = 'https://coreassets-admin.normal8607.workers.dev';

const ADMIN_PASS_KEY = 'coreassets_admin_pass';

function getSavedAdminPass() {
    try { return localStorage.getItem(ADMIN_PASS_KEY) || ''; }
    catch (e) { return ''; }
}

function saveAdminPass(pass) {
    try { localStorage.setItem(ADMIN_PASS_KEY, pass); }
    catch (e) {  }
}

function forgetAdminPass() {
    try { localStorage.removeItem(ADMIN_PASS_KEY); }
    catch (e) {  }
    showNotify("Saved password forgotten.");
}

function getSessionToken() {
    return sessionStorage.getItem('admin_session');
}

function setSessionToken(token) {
    sessionStorage.setItem('admin_session', token);
}

function clearSessionToken() {
    sessionStorage.removeItem('admin_session');
}

async function workerLogin(password) {
    const res = await fetch(`${WORKER_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Login fallido');
    return data.token;
}

async function workerSave(endpoint, content, message) {
    const token = getSessionToken();
    if (!token) throw new Error('Sesión no iniciada');
    const res = await fetch(`${WORKER_URL}${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ content, message })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
        clearSessionToken();
        throw new Error('Sesión expirada, vuelve a iniciar sesión.');
    }
    if (!res.ok) throw new Error(data.error || `Error del servidor (${res.status})`);
    return data;
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
        fail: m.fail || 'none',
        autor: m.autor || ''
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
        fail: a.fail || 'none',
        autor: a.autor || ''
    };
}

let assets = (typeof assetsCreados !== 'undefined' ? assetsCreados : []).map(fromFileFormat);
let pendingAssets = [];
let assetToDelete = null;
let assetToDeleteSource = 'admin';

function setFileStatus(connected, label) {
    const dot = document.getElementById('fileStatusDot');
    const text = document.getElementById('fileStatusText');
    if (!dot || !text) return;
    dot.classList.remove('bg-slate-600', 'bg-red-500', 'bg-green-500');
    dot.classList.add(connected ? 'bg-green-500' : 'bg-red-500');
    text.innerText = label;
}

function generateAssetsFileContent(assetsArr) {
    const data = assetsArr.map(toFileFormat);
    return "var assetsCreados = " + JSON.stringify(data, null, 4) + ";\n";
}

async function persistAssets() {
    const content = generateAssetsFileContent(assets);

    try {
        await workerSave('/save-assets', content, 'Update assets from admin panel');
        setFileStatus(true, 'Publicado ✔️');
        showNotify("Cambios publicados. La web se actualiza en ~1 min.");
    } catch (e) {
        console.error(e);
        showNotify("Error al publicar: " + e.message, "error");
    }
}

async function refreshPendingFromServer() {
    const token = getSessionToken();
    if (!token) return;
    try {
        const res = await fetch(`${WORKER_URL}/pending-list`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && Array.isArray(data.items)) {
            pendingAssets = data.items.map(fromFileFormat);
        }
    } catch (e) {
        console.error('No se pudo cargar la cola de revisión', e);
    }
}

async function persistPending() {
    const token = getSessionToken();
    if (!token) throw new Error('Sesión no iniciada');
    const res = await fetch(`${WORKER_URL}/pending-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ items: pendingAssets.map(toFileFormat) })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
        clearSessionToken();
        throw new Error('Sesión expirada, vuelve a iniciar sesión.');
    }
    if (!res.ok) throw new Error(data.error || `Error del servidor (${res.status})`);
    return data;
}

const DEVICE_ID_KEY = 'coreassets_device_id';

function getDeviceId() {
    try {
        let id = localStorage.getItem(DEVICE_ID_KEY);
        if (!id) {
            id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
            localStorage.setItem(DEVICE_ID_KEY, id);
        }
        return id;
    } catch (e) { return 'dev-unknown'; }
}

function getAdminUsersList() {
    return (typeof adminUsers !== 'undefined' && Array.isArray(adminUsers)) ? adminUsers : [];
}

function findUserByDeviceId(deviceId) {
    return getAdminUsersList().find(u => u.deviceId === deviceId);
}

function usernameTaken(name) {
    const n = (name || '').trim().toLowerCase();
    if (!n) return true;
    return getAdminUsersList().some(u => (u.usuario || '').trim().toLowerCase() === n);
}

function isProtectedUser(u) {
    return (u.usuario || '').trim().toLowerCase() === 'vyn';
}

function isCurrentUserVyn() {
    const current = findUserByDeviceId(getDeviceId());
    return !!current && isProtectedUser(current);
}

function getCurrentUsername() {
    const current = findUserByDeviceId(getDeviceId());
    return (current && current.usuario) ? current.usuario : 'Admin';
}

function generateUsersFileContent(usersArr) {
    return "var adminUsers = " + JSON.stringify(usersArr, null, 4) + ";\n";
}

async function persistUsers() {
    const content = generateUsersFileContent(adminUsers);
    await workerSave('/save-users', content, 'Update admin users');
}

const allAssets = [...assets];

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
        showNotify("Added to favorites");
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
        success: { color: 'bg-green-600' },
        error: { color: 'bg-red-600' },
        download: { color: 'bg-blue-600' }
    };
    const s = styles[type] || styles.success;
    toast.className = `${s.color} text-white px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-3 toast-in mb-2 font-bold z-50`;
    toast.innerHTML = `<span>${text}</span>`;
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

    if (adminQuickLoginOpen) {
        hideAdminQuickLogin();
        return;
    }

    btn.classList.add('blur-sm', 'opacity-30', 'pointer-events-none');
    box.classList.remove('hidden');
    adminQuickLoginOpen = true;

    input.value = getSavedAdminPass();
    updateAdminQuickLabel();
    input.focus();

    input.addEventListener('input', () => {
        updateAdminQuickLabel();
        tryAutoSubmitQuickLogin();
    });
    input.addEventListener('keypress', function onKey(e) {
        if (e.key === 'Enter') checkAdminQuickLogin(input.value);
    });

    tryAutoSubmitQuickLogin();
}

document.addEventListener('click', (e) => {
    if (!adminQuickLoginOpen) return;
    const adminAccess = document.getElementById('adminAccess');
    if (adminAccess && !adminAccess.contains(e.target)) hideAdminQuickLogin();
});

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

async function checkAdminQuickLogin(value) {
    try {
        const token = await workerLogin(value);
        setSessionToken(token);
        saveAdminPass(value);
        location.href = 'admin.html';
    } catch (e) {
        showNotify("Incorrect password!", "error");
        const input = document.getElementById('adminQuickPass');
        if (input) { input.value = ''; updateAdminQuickLabel(); input.focus(); }
    }
}

let quickLoginAutoSubmitting = false;
function tryAutoSubmitQuickLogin() {
    const input = document.getElementById('adminQuickPass');
    const saved = getSavedAdminPass();
    if (!input || quickLoginAutoSubmitting || !saved) return;
    if (input.value.length === saved.length) {
        quickLoginAutoSubmitting = true;
        checkAdminQuickLogin(input.value).finally(() => {
            quickLoginAutoSubmitting = false;
        });
    }
}

const passInput = document.getElementById('pass');
if(passInput) {
    passInput.value = getSavedAdminPass();
    passInput.addEventListener('keypress', (e) => {
        if(e.key === 'Enter') login();
    });

    let passAutoSubmitting = false;
    function tryAutoSubmitPass() {
        const saved = getSavedAdminPass();
        if (passAutoSubmitting || !saved) return;
        if (passInput.value.length === saved.length) {
            passAutoSubmitting = true;
            login().finally(() => {
                passAutoSubmitting = false;
            });
        }
    }
    passInput.addEventListener('input', tryAutoSubmitPass);
    tryAutoSubmitPass();
}

async function login() {
    const pass = document.getElementById('pass').value;
    try {
        const token = await workerLogin(pass);
        setSessionToken(token);
        saveAdminPass(pass);
        await handlePostLoginUserCheck();
    } catch (e) {
        showNotify("Incorrect password!", "error");
    }
}

function tryAutoLoginAdmin() {
    const loginOverlay = document.getElementById('loginOverlay');
    const adminContent = document.getElementById('adminContent');
    if (!loginOverlay || !adminContent) return;
    if (getSessionToken()) {
        handlePostLoginUserCheck();
    }
}
tryAutoLoginAdmin();

async function handlePostLoginUserCheck() {
    const deviceId = getDeviceId();
    const existing = findUserByDeviceId(deviceId);

    if (existing) {
        if (existing.banned) {
            clearSessionToken();
            document.getElementById('loginOverlay')?.classList.remove('hidden');
            document.getElementById('adminContent')?.classList.add('hidden');
            showNotify("Acceso denegado: este dispositivo fue baneado.", "error");
            return;
        }
        enterAdminPanel();
        return;
    }

    showUsernamePrompt();
}

let adminAccessGranted = false;

async function enterAdminPanel() {
    if (adminAccessGranted) return;
    adminAccessGranted = true;
    document.getElementById('loginOverlay').classList.add('hidden');
    document.getElementById('usernameModal')?.classList.add('hidden');
    document.getElementById('adminContent').classList.remove('hidden');
    updatePendingTabVisibility();
    await refreshPendingFromServer();
    renderManageList();
    showNotify("Access granted!");
}

function showUsernamePrompt() {
    document.getElementById('loginOverlay')?.classList.add('hidden');
    const modal = document.getElementById('usernameModal');
    const input = document.getElementById('newUsernameInput');
    const errorEl = document.getElementById('usernameError');
    if (!modal || !input) return;
    input.value = '';
    errorEl?.classList.add('hidden');
    modal.classList.remove('hidden');
    input.focus();
    input.onkeypress = (e) => { if (e.key === 'Enter') submitNewUsername(); };
}

async function submitNewUsername() {
    const input = document.getElementById('newUsernameInput');
    const errorEl = document.getElementById('usernameError');
    const name = (input?.value || '').trim();
    if (!name) return;

    if (usernameTaken(name)) {
        errorEl?.classList.remove('hidden');
        return;
    }
    errorEl?.classList.add('hidden');

    const newUser = {
        id: Date.now(),
        usuario: name,
        deviceId: getDeviceId(),
        banned: false,
        creado: new Date().toISOString()
    };
    adminUsers.push(newUser);

    try {
        await persistUsers();
    } catch (e) {
        adminUsers.pop();
        showNotify("No se pudo registrar el usuario: " + e.message, "error");
        return;
    }

    enterAdminPanel();
}

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

            const targetArr = source === 'pending' ? pendingAssets : assets;
            const a = targetArr.find(x => x.id == id);
            if (!a) return showNotify("Asset not found.", "error");
            a.title = title; a.desc = desc; a.descShort = descShort; a.fileUrl = fileUrl; a.status = status; a.fail = fail;
            a.fileFormat = fileFormat; a.fileSize = fileSize; a.categoria = categoria;

            if (imagenes.length) {
                a.imagenes = imagenes;
                a.img = imagenes[0];
            }
            showNotify("Asset updated!");
            await (source === 'pending' ? persistPending() : persistAssets());
            switchTab(source === 'pending' ? 'pending' : 'manage');
        } else {

            if (!imagenes.length) return showNotify("Please enter at least one image URL!", "error");
            const nuevo = { id: Date.now(), title, desc, descShort, fileUrl, status, fail, fileFormat, fileSize, categoria, imagenes, img: imagenes[0], autor: getCurrentUsername() };

            if (isCurrentUserVyn()) {
                assets.push(nuevo);
                showNotify("Asset created!");
                await persistAssets();
                switchTab('manage');
            } else {
                await refreshPendingFromServer();
                pendingAssets.push(nuevo);
                showNotify("Enviado a revisión. Se publicará cuando sea aprobado.");
                await persistPending();
                switchTab('pending');
            }
        }

        resetForm();
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
    document.getElementById('sectionUsers')?.classList.toggle('hidden', t !== 'users');
    document.getElementById('sectionPending')?.classList.toggle('hidden', t !== 'pending');

    [['tabCreate', 'create'], ['tabManage', 'manage'], ['tabUsers', 'users'], ['tabPending', 'pending']].forEach(([elId, tabId]) => {
        const btn = document.getElementById(elId);
        if (!btn) return;
        btn.classList.toggle('bg-blue-600', t === tabId);
        btn.classList.toggle('bg-slate-800', t !== tabId);
    });

    if (t === 'manage') renderManageList();
    if (t === 'users') renderUsersList();
    if (t === 'pending') { renderPendingList(); refreshPendingFromServer().then(renderPendingList); }
}

function renderManageList() {
    const l = document.getElementById('existingAssetsList');
    if(!l) return;
    const combined = assets.map(a => ({ ...a, __source: 'admin' }));
    l.innerHTML = combined.length ? "" : "<p class='text-slate-500 text-center py-10'>Empty.</p>";
    combined.forEach(a => {
        const tag = `<span class="bg-blue-600/20 text-blue-400 text-[10px] font-black uppercase px-2 py-1 rounded-lg">${a.autor || 'Admin'}</span>`;
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

function renderPendingList() {
    const l = document.getElementById('pendingList');
    if (!l) return;
    l.innerHTML = pendingAssets.length ? "" : "<p class='text-slate-500 text-center py-10'>No hay assets pendientes de revisión.</p>";
    pendingAssets.forEach(a => {
        const tag = `<span class="bg-yellow-600/20 text-yellow-400 text-[10px] font-black uppercase px-2 py-1 rounded-lg">${a.autor || 'Admin'}</span>`;
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
                    <button onclick="prepareEdit('${a.id}', 'pending')" class="bg-blue-600/10 text-blue-400 px-4 py-2 rounded-xl text-xs font-bold uppercase">Edit</button>
                    <button onclick="approvePending('${a.id}')" class="bg-green-600/10 text-green-500 px-4 py-2 rounded-xl text-xs font-bold uppercase">Aprobar</button>
                    <button onclick="openDeleteModal('${a.id}', 'pending')" class="bg-red-600/10 text-red-500 px-4 py-2 rounded-xl text-xs font-bold uppercase">Rechazar</button>
                </div>
            </div>`;
    });
}

async function approvePending(id) {
    if (!isCurrentUserVyn()) return;
    const idx = pendingAssets.findIndex(x => x.id == id);
    if (idx === -1) return;
    const [aprobado] = pendingAssets.splice(idx, 1);
    assets.push(aprobado);

    try {
        await persistAssets();
        await persistPending();
        showNotify("Asset aprobado y publicado!");
    } catch (e) {
        pendingAssets.splice(idx, 0, aprobado);
        assets.pop();
        showNotify("No se pudo aprobar: " + e.message, "error");
    }
    renderPendingList();
}

function updatePendingTabVisibility() {
    const tabBtn = document.getElementById('tabPending');
    if (!tabBtn) return;
    tabBtn.classList.toggle('hidden', !isCurrentUserVyn());
}

function prepareEdit(id, source = 'admin') {
    const a = (source === 'pending' ? pendingAssets : assets).find(x => x.id == id);
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
    document.getElementById('panelTitle').innerText = "Editing: " + a.title;
    switchTab('create');
}

function renderUsersList() {
    const l = document.getElementById('usersList');
    if (!l) return;
    const users = getAdminUsersList();
    const puedeEliminar = isCurrentUserVyn();
    l.innerHTML = users.length ? "" : "<p class='text-slate-500 text-center py-10'>No hay usuarios registrados.</p>";
    users.forEach(u => {
        const protegido = isProtectedUser(u);
        const estadoTag = u.banned
            ? `<span class="bg-red-600/20 text-red-500 text-[10px] font-black uppercase px-2 py-1 rounded-lg">Baneado</span>`
            : `<span class="bg-green-600/20 text-green-500 text-[10px] font-black uppercase px-2 py-1 rounded-lg">Activo</span>`;
        l.innerHTML += `
            <div class="flex items-center justify-between bg-slate-900 p-4 rounded-2xl border border-white/5">
                <div class="flex items-center gap-3">
                    <span class="font-bold text-sm">${u.usuario}</span>
                    ${protegido ? `<span class="bg-blue-600/20 text-blue-400 text-[10px] font-black uppercase px-2 py-1 rounded-lg">Creador</span>` : estadoTag}
                </div>
                <div class="flex gap-2">
                    ${(!protegido && !u.banned && puedeEliminar) ? `<button onclick="openDeleteUserModal(${u.id})" class="bg-red-600/10 text-red-500 px-4 py-2 rounded-xl text-xs font-bold uppercase">Eliminar</button>` : ''}
                </div>
            </div>`;
    });
}

let userToDelete = null;
function openDeleteUserModal(id) {
    userToDelete = id;
    document.getElementById('deleteUserModal')?.classList.remove('hidden');
}
function closeDeleteUserModal() {
    document.getElementById('deleteUserModal')?.classList.add('hidden');
}
document.getElementById('confirmDeleteUserBtn')?.addEventListener('click', async () => {
    if (!isCurrentUserVyn()) { closeDeleteUserModal(); return; }
    const u = getAdminUsersList().find(x => x.id == userToDelete);
    if (!u || isProtectedUser(u)) { closeDeleteUserModal(); return; }

    u.banned = true;
    try {
        await persistUsers();
    } catch (e) {
        u.banned = false;
        showNotify("No se pudo eliminar: " + e.message, "error");
        closeDeleteUserModal();
        return;
    }

    closeDeleteUserModal();
    renderUsersList();
    showNotify("Usuario eliminado permanentemente.");

    if (u.deviceId === getDeviceId()) {
        clearSessionToken();
        location.href = 'index.html';
    }
});

function openDeleteModal(id, source = 'admin') {
    assetToDelete = id;
    assetToDeleteSource = source;
    const title = document.querySelector('#deleteModal h3');
    if (title) title.innerText = source === 'pending' ? 'Rechazar este asset?' : 'Delete permanently?';
    document.getElementById('deleteModal').classList.remove('hidden');
}
function closeDeleteModal() {
    document.getElementById('deleteModal').classList.add('hidden');
}
document.getElementById('confirmDeleteBtn')?.addEventListener('click', async () => {
    if (assetToDeleteSource === 'pending') {
        pendingAssets = pendingAssets.filter(x => x.id != assetToDelete);
        await persistPending();
        renderPendingList();
        closeDeleteModal();
        showNotify("Asset rechazado.");
    } else {
        assets = assets.filter(x => x.id != assetToDelete);
        await persistAssets();
        renderManageList();
        closeDeleteModal();
        showNotify("Asset removed!");
    }
});
