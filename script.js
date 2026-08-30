const WORKER_URL = 'https://coreassets-admin.normal8607.workers.dev';

// --- Security: escape any untrusted string before it goes into innerHTML.
// Used for asset titles/descriptions (can come from public pending submissions)
// and for comments/usernames (always public input). Never skip this for
// anything that did not originate from a trusted hardcoded template.
function escapeHTML(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// --- Performance: generic debounce helper, used to avoid firing a network
// request or a re-render on every single keystroke/click.
function debounce(fn, wait = 250) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
    };
}

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
        body: JSON.stringify({ password, deviceId: getDeviceId() })
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
    await workerSave('/save-assets', content, 'Update assets from admin panel');
    setFileStatus(true, 'Publicado ✔️');
}

// pendingQueue keeps the raw server records ({ id, asset, submittedBy, submittedAt })
// so we always know who submitted each item — needed to block self-approval.
let pendingQueue = [];

async function workerCall(endpoint, body) {
    const token = getSessionToken();
    if (!token) throw new Error('Sesión no iniciada');
    const res = await fetch(`${WORKER_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body || {})
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
        clearSessionToken();
        throw new Error('Sesión expirada, vuelve a iniciar sesión.');
    }
    if (!res.ok) throw new Error(data.error || `Error del servidor (${res.status})`);
    return data;
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
            pendingQueue = data.items;
            // The queue entry's own id (x.id, minted by the Worker at
            // submission time) is what /pending-approve, /pending-reject and
            // /pending-update expect. It is NOT the same as the wrapped
            // asset's own id (x.asset.id, minted client-side when the form
            // was first filled). Keep both: queueId for talking to the
            // Worker, id for everything else (editing fields, images...).
            pendingAssets = data.items.map(x => {
                const a = fromFileFormat(x.asset);
                a.queueId = x.id;
                return a;
            });
        }
    } catch (e) {
        console.error('No se pudo cargar la cola de revisión', e);
    }
}

// Sends one new asset to the review queue. The server records our deviceId
// as the submitter so it can block us from approving it later.
async function submitPending(assetInFileFormat) {
    return workerCall('/pending-submit', { asset: assetInFileFormat, deviceId: getDeviceId() });
}

// Edits an asset that is still sitting in the pending queue (not yet published).
async function updatePendingAsset(id, assetInFileFormat) {
    return workerCall('/pending-update', { id, asset: assetInFileFormat, deviceId: getDeviceId() });
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

// assetId -> { comments, rating, downloads }. Declared here (before the
// first renderAssetGrid() runs at the bottom of this file) on purpose: a
// `const` referenced before its own declaration line has executed throws
// (temporal dead zone), and since that first render happens synchronously
// on page load, that used to kill the rest of the script silently — which
// is why filters, comments and downloads all looked broken at once.
const __extrasCache = {};


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

function renderMedia(url, sizeClasses, extraClasses = '', interactive = false, lazy = false) {
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

    // Perf: grid cards defer loading their background image until they are
    // about to enter the viewport (see initLazyMedia), instead of every
    // card's image downloading immediately on page load.
    if (lazy) {
        return `<div class="${sizeClasses} ${extraClasses} bg-cover bg-center lazy-media bg-slate-800" data-bg-url="${url.replace(/"/g, '&quot;')}"></div>`;
    }

    return `<div class="${sizeClasses} ${extraClasses} bg-cover bg-center" style="background-image: url('${url}')"></div>`;
}

// --- Performance: single shared IntersectionObserver reused for every grid
// render, instead of downloading every card's cover image up front.
let __lazyMediaObserver = null;
function initLazyMedia() {
    if (!('IntersectionObserver' in window)) {
        document.querySelectorAll('.lazy-media[data-bg-url]').forEach(el => {
            el.style.backgroundImage = `url('${el.getAttribute('data-bg-url')}')`;
            el.removeAttribute('data-bg-url');
        });
        return;
    }
    if (!__lazyMediaObserver) {
        __lazyMediaObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const el = entry.target;
                const url = el.getAttribute('data-bg-url');
                if (url) {
                    el.style.backgroundImage = `url('${url}')`;
                    el.removeAttribute('data-bg-url');
                }
                __lazyMediaObserver.unobserve(el);
            });
        }, { rootMargin: '200px 0px' });
    }
    document.querySelectorAll('.lazy-media[data-bg-url]').forEach(el => __lazyMediaObserver.observe(el));
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

// --- Security: soft client-side brake on repeated failed login attempts.
// This is only a UX deterrent against casual brute-forcing — the real
// protection has to live on the Worker, which is the only side that can't
// be bypassed by editing this file.
const LOGIN_ATTEMPTS_KEY = 'coreassets_login_attempts';
function registerFailedLoginAttempt() {
    let data;
    try { data = JSON.parse(sessionStorage.getItem(LOGIN_ATTEMPTS_KEY)) || { count: 0, until: 0 }; }
    catch (e) { data = { count: 0, until: 0 }; }
    data.count += 1;
    if (data.count >= 5) data.until = Date.now() + 30000;
    try { sessionStorage.setItem(LOGIN_ATTEMPTS_KEY, JSON.stringify(data)); } catch (e) { }
    return data;
}
function getLoginLockout() {
    try {
        const data = JSON.parse(sessionStorage.getItem(LOGIN_ATTEMPTS_KEY)) || { count: 0, until: 0 };
        return data.until > Date.now() ? data.until : 0;
    } catch (e) { return 0; }
}
function clearLoginAttempts() {
    try { sessionStorage.removeItem(LOGIN_ATTEMPTS_KEY); } catch (e) { }
}

async function checkAdminQuickLogin(value) {
    const lockedUntil = getLoginLockout();
    if (lockedUntil) {
        showNotify(`Demasiados intentos. Espera ${Math.ceil((lockedUntil - Date.now()) / 1000)}s.`, "error");
        return;
    }
    try {
        const token = await workerLogin(value);
        clearLoginAttempts();
        setSessionToken(token);
        saveAdminPass(value);
        location.href = 'admin.html';
    } catch (e) {
        registerFailedLoginAttempt();
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
    const lockedUntil = getLoginLockout();
    if (lockedUntil) {
        showNotify(`Demasiados intentos. Espera ${Math.ceil((lockedUntil - Date.now()) / 1000)}s.`, "error");
        return;
    }
    const pass = document.getElementById('pass').value;
    try {
        const token = await workerLogin(pass);
        clearLoginAttempts();
        setSessionToken(token);
        saveAdminPass(pass);
        await handlePostLoginUserCheck();
    } catch (e) {
        registerFailedLoginAttempt();
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
    updateAdminStats();
    showNotify("Access granted!");
}

// --- Admin stat strip: quick read of the panel's own state, no extra
// network calls beyond what refreshPendingFromServer() already fetched.
function updateAdminStats() {
    const totalEl = document.getElementById('statTotalAssets');
    const pendingEl = document.getElementById('statTotalPending');
    const usersEl = document.getElementById('statTotalUsers');
    const roleEl = document.getElementById('statCurrentRole');
    if (!totalEl) return;
    totalEl.innerText = String(allAssets.length);
    pendingEl.innerText = String((pendingAssets || []).length);
    usersEl.innerText = String((adminUsers || []).length);
    roleEl.innerText = isCurrentUserVyn() ? 'Vyn' : 'Mod';
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

            if (source === 'pending') {
                const a = pendingAssets.find(x => x.queueId == id);
                if (!a) return showNotify("Asset not found.", "error");
                a.title = title; a.desc = desc; a.descShort = descShort; a.fileUrl = fileUrl; a.status = status; a.fail = fail;
                a.fileFormat = fileFormat; a.fileSize = fileSize; a.categoria = categoria;
                if (imagenes.length) { a.imagenes = imagenes; a.img = imagenes[0]; }

                await updatePendingAsset(id, toFileFormat(a));
                showNotify("Cambios guardados en revisión.");
                switchTab('pending');
            } else {
                const a = assets.find(x => x.id == id);
                if (!a) return showNotify("Asset not found.", "error");
                const backup = { ...a };
                a.title = title; a.desc = desc; a.descShort = descShort; a.fileUrl = fileUrl; a.status = status; a.fail = fail;
                a.fileFormat = fileFormat; a.fileSize = fileSize; a.categoria = categoria;
                if (imagenes.length) { a.imagenes = imagenes; a.img = imagenes[0]; }

                try {
                    await persistAssets();
                } catch (e) {
                    // Worker rejected it (e.g. not the owner) — undo the local
                    // mutation so the panel doesn't show an edit that never saved.
                    Object.assign(a, backup);
                    renderManageList();
                    throw e;
                }
                showNotify("Asset updated!");
                switchTab('manage');
            }
        } else {

            if (!imagenes.length) return showNotify("Please enter at least one image URL!", "error");
            const nuevo = { id: Date.now(), title, desc, descShort, fileUrl, status, fail, fileFormat, fileSize, categoria, imagenes, img: imagenes[0], autor: getCurrentUsername() };

            if (isCurrentUserVyn()) {
                assets.push(nuevo);
                try {
                    await persistAssets();
                } catch (e) {
                    assets = assets.filter(x => x.id !== nuevo.id);
                    renderManageList();
                    throw e;
                }
                showNotify("Asset created!");
                switchTab('manage');
            } else {
                await submitPending(toFileFormat(nuevo));
                showNotify("Enviado a revisión. Se publicará cuando sea aprobado.");
                await refreshPendingFromServer();
                switchTab('pending');
            }
        }

        resetForm();
    } catch (e) {
        console.error(e);
        showNotify("Error saving the asset: " + e.message, "error");
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

    // Perf: build every card into an array and join+set innerHTML once,
    // instead of the old grid.innerHTML += ... per card (which forces a
    // reflow/reparse on every single iteration).
    const cardsHTML = itemsFiltrados.map((a, i) => {

        const statusLabels = { 'nenhum': '', 'novo': 'New', 'limitado': 'Limited', 'recomendado': 'Recommended' };
        const label = statusLabels[a.status] || a.status;

        const badge = a.status && a.status !== 'nenhum' ? `<span class="absolute top-4 left-4 px-3 py-1 rounded-full text-[10px] font-black uppercase badge-${a.status} z-10">${escapeHTML(label)}</span>` : '';

        const fileMeta = (a.fileFormat || a.fileSize) ? `
                        <div class="flex gap-2 mt-3 font-mono">
                            ${a.fileFormat ? `<span class="bg-white/5 text-slate-300 text-[10px] font-bold uppercase px-2 py-1 rounded-lg">${escapeHTML(a.fileFormat)}</span>` : ''}
                            ${a.fileSize ? `<span class="bg-white/5 text-slate-300 text-[10px] font-bold uppercase px-2 py-1 rounded-lg">${escapeHTML(a.fileSize)}</span>` : ''}
                        </div>` : '';

        const delayMs = Math.min(i, 10) * 40;

        return `
            <div class="asset-card relative bg-slate-900 border border-white/5 rounded-3xl overflow-hidden group hover:border-blue-500 transition-all duration-300 animate__animated animate__fadeInUp" style="animation-delay:${delayMs}ms; animation-duration:0.4s;">
                ${badge}
                <button onclick="event.stopPropagation(); handleDownload('${a.id}')" class="shortcut-btn absolute top-4 right-4 bg-blue-600 p-3 rounded-xl z-20 opacity-0 translate-y-[-10px] transition-all hover:bg-blue-500 shadow-xl">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                </button>
                <button onclick="event.stopPropagation(); toggleFavorite('${a.id}')" data-id="${a.id}" data-context="grid" class="fav-btn shortcut-btn absolute top-16 right-4 w-9 h-9 flex items-center justify-center bg-slate-950/80 rounded-xl z-20 opacity-0 translate-y-[-10px] transition-all hover:bg-slate-900 shadow-xl">
                    <svg class="fav-icon" width="16" height="16" viewBox="0 0 24 24" fill="${isFavorite(a.id) ? '#ef4444' : 'none'}" stroke="${isFavorite(a.id) ? '#ef4444' : '#ffffff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6.7-4.35-9.3-8.28C1.1 10.3 1.7 6.9 4.6 5.4c2.4-1.24 5-.3 6.4 1.7 1.4-2 4-2.94 6.4-1.7 2.9 1.5 3.5 4.9 1.9 7.32C18.7 16.65 12 21 12 21z"/></svg>
                </button>
                <div onclick="openAssetDetail('${a.id}')" class="cursor-pointer">
                    ${renderMedia(a.img, 'h-52 w-full', 'transition-transform duration-500 group-hover:scale-110', false, true)}
                    <div class="p-6">
                        <h3 class="font-display text-xl font-bold mb-2 transition-colors">${escapeHTML(a.title)}</h3>
                        <p class="text-slate-500 text-sm line-clamp-2">${escapeHTML(a.descShort || a.desc || 'Click to see details.')}</p>
                        <div class="flex items-center gap-2 mt-3 text-[11px] text-slate-500 font-mono">
                            <span class="asset-rating-summary" data-asset-id="${a.id}">☆☆☆☆☆</span>
                            <span class="asset-download-count" data-asset-id="${a.id}"></span>
                        </div>
                        ${fileMeta}
                    </div>
                </div>
            </div>`;
    });
    grid.innerHTML = cardsHTML.join('');
    initLazyMedia();
    itemsFiltrados.forEach(a => refreshCardStats(a.id));
}

// --- Hero stat strip (index.html only). Purely derived from the in-memory
// asset list, no extra network calls.
function updateHeroStats() {
    const countEl = document.getElementById('statAssetCount');
    const catEl = document.getElementById('statCategoryCount');
    if (!countEl || !catEl) return;
    const cats = new Set();
    allAssets.forEach(a => (a.categoria || []).forEach(c => cats.add(String(c).toUpperCase())));
    countEl.innerText = String(allAssets.length);
    catEl.innerText = String(cats.size);
}

if (document.getElementById('assetGrid')) {
    renderFilters();
    renderAssetGrid();
    updateHeroStats();
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
                ${(a.categoria && a.categoria.length) ? `<span class="inline-block mb-4 px-3 py-1 rounded-full text-[10px] font-black uppercase bg-cyan-400/10 text-cyan-400 border border-cyan-400/20">${escapeHTML(a.categoria.join(' / '))}</span>` : ''}
                <div class="flex justify-between items-center mb-6 gap-3">
                    <h1 class="font-display text-4xl font-bold">${escapeHTML(a.title)}</h1>
                    <div class="flex items-center gap-2 shrink-0">
                        <button onclick="toggleFavorite('${a.id}')" data-id="${a.id}" data-context="modal" class="fav-btn bg-black/20 border border-white/5 hover:bg-slate-800 w-11 h-11 flex items-center justify-center rounded-xl transition">
                            <svg class="fav-icon" width="18" height="18" viewBox="0 0 24 24" fill="${isFavorite(a.id) ? '#ef4444' : 'none'}" stroke="${isFavorite(a.id) ? '#ef4444' : '#ffffff'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6.7-4.35-9.3-8.28C1.1 10.3 1.7 6.9 4.6 5.4c2.4-1.24 5-.3 6.4 1.7 1.4-2 4-2.94 6.4-1.7 2.9 1.5 3.5 4.9 1.9 7.32C18.7 16.65 12 21 12 21z"/></svg>
                        </button>
                        <span class="font-mono px-4 py-2 rounded-full text-[10px] font-black uppercase bg-blue-600/20 text-blue-400 border border-blue-500/20">${escapeHTML(label)}</span>
                    </div>
                </div>

                <div id="ratingWidget-${a.id}" class="flex items-center gap-3 mb-6">
                    <span class="text-slate-500 text-xs">Cargando valoración…</span>
                </div>

                ${(a.fileFormat || a.fileSize) ? `
                <div class="flex gap-3 mb-8 font-mono">
                    ${a.fileFormat ? `<div class="bg-black/20 border border-white/5 rounded-xl px-4 py-3"><p class="text-slate-500 text-[10px] uppercase font-bold">Format</p><p class="font-bold">${escapeHTML(a.fileFormat)}</p></div>` : ''}
                    ${a.fileSize ? `<div class="bg-black/20 border border-white/5 rounded-xl px-4 py-3"><p class="text-slate-500 text-[10px] uppercase font-bold">Size</p><p class="font-bold">${escapeHTML(a.fileSize)}</p></div>` : ''}
                    <div class="bg-black/20 border border-white/5 rounded-xl px-4 py-3"><p class="text-slate-500 text-[10px] uppercase font-bold">Descargas</p><p id="downloadCount-${a.id}" class="font-bold">—</p></div>
                </div>` : ''}
                <div class="bg-black/20 p-6 rounded-2xl border border-white/5 mb-8">
                    <h3 class="font-display text-blue-500 font-bold mb-2 uppercase text-xs tracking-wide">Description</h3>
                    <p class="text-slate-300 leading-relaxed whitespace-pre-line">${escapeHTML(a.desc || 'No technical description available.')}</p>
                </div>
                <button onclick="handleDownload('${a.id}')" class="w-full bg-blue-600 py-6 rounded-2xl font-black text-2xl hover:bg-blue-500 transition shadow-xl shadow-blue-900/30">
                    DOWNLOAD
                </button>

                <div class="mt-10 pt-8 border-t border-white/5">
                    <h3 class="font-display text-blue-500 font-bold mb-4 uppercase text-xs tracking-wide">Comentarios</h3>
                    <div class="flex gap-3 mb-5">
                        <input type="text" id="commentInput-${a.id}" maxlength="500" placeholder="Escribe un comentario..." class="flex-1 bg-black/40 p-4 rounded-xl border border-white/5 outline-none focus:border-blue-500 text-sm">
                        <button id="commentBtn-${a.id}" onclick="submitComment('${a.id}')" class="bg-blue-600 hover:bg-blue-500 px-5 rounded-xl font-bold text-sm transition">Enviar</button>
                    </div>
                    <div id="commentsList-${a.id}" class="space-y-3">
                        <p class="text-slate-500 text-sm">Cargando comentarios…</p>
                    </div>
                </div>
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
    loadAssetExtras(a.id);

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
        trackDownload(id); // fire-and-forget, never blocks the actual download
    } else {
        const e = { '404': "ERROR 404", 'virus': "RISK: Virus detected!", 'limit': "LIMIT EXCEEDED" };
        showNotify(e[a.fail], "error");
    }
}

// ============================================================
// Comments, ratings & download counters
// Backed by new public Worker endpoints (see worker.js).
// These are unauthenticated on purpose (any visitor can comment/rate),
// so every value coming back from the server is treated as untrusted and
// escaped before it ever touches innerHTML.
// ============================================================

async function loadAssetExtras(id) {
    try {
        const [commentsRes, ratingRes, downloadsRes] = await Promise.all([
            fetch(`${WORKER_URL}/comments/${id}`).then(r => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] })),
            fetch(`${WORKER_URL}/rating/${id}`).then(r => r.ok ? r.json() : { average: 0, count: 0 }).catch(() => ({ average: 0, count: 0 })),
            fetch(`${WORKER_URL}/downloads/${id}`).then(r => r.ok ? r.json() : { count: 0 }).catch(() => ({ count: 0 }))
        ]);
        __extrasCache[id] = { comments: commentsRes.items || [], rating: ratingRes, downloads: downloadsRes.count || 0 };
    } catch (e) {
        __extrasCache[id] = __extrasCache[id] || { comments: [], rating: { average: 0, count: 0 }, downloads: 0 };
    }
    renderRatingWidget(id);
    renderComments(id);
    const dlEl = document.getElementById(`downloadCount-${id}`);
    if (dlEl) dlEl.innerText = String(__extrasCache[id].downloads);
    refreshCardStats(id);
}

function refreshCardStats(id) {
    const data = __extrasCache[id];
    if (!data) return;
    document.querySelectorAll(`.asset-rating-summary[data-asset-id="${id}"]`).forEach(el => {
        el.innerHTML = starsHTML(data.rating.average) + (data.rating.count ? ` <span class="text-slate-600">(${data.rating.count})</span>` : '');
    });
    document.querySelectorAll(`.asset-download-count[data-asset-id="${id}"]`).forEach(el => {
        el.innerText = data.downloads ? `· ${data.downloads} descargas` : '';
    });
}

function starsHTML(average) {
    const rounded = Math.round(average || 0);
    let out = '';
    for (let i = 1; i <= 5; i++) out += i <= rounded ? '★' : '☆';
    return `<span class="text-yellow-500">${out}</span>`;
}

function renderRatingWidget(id) {
    const el = document.getElementById(`ratingWidget-${id}`);
    if (!el) return;
    const data = __extrasCache[id] || { rating: { average: 0, count: 0 } };
    const avg = data.rating.average || 0;
    const count = data.rating.count || 0;
    const myKey = `coreassets_myrating_${id}`;
    let myRating = 0;
    try { myRating = parseInt(localStorage.getItem(myKey) || '0', 10) || 0; } catch (e) { }

    const starButtons = [1, 2, 3, 4, 5].map(n => `
        <button type="button" onclick="submitRating('${id}', ${n})" class="rate-star text-2xl leading-none ${n <= myRating ? 'text-yellow-500' : 'text-slate-600'} hover:text-yellow-400 transition" data-n="${n}">★</button>
    `).join('');

    el.innerHTML = `
        <div class="flex items-center gap-1">${starButtons}</div>
        <span class="text-slate-400 text-xs">${avg.toFixed(1)} / 5 ${count ? `(${count} voto${count === 1 ? '' : 's'})` : '(sin valoraciones aún)'}</span>
    `;
}

let __ratingInFlight = {};
async function submitRating(id, stars) {
    if (__ratingInFlight[id]) return; // prevents double-submit from a rapid double click
    __ratingInFlight[id] = true;
    try {
        const res = await fetch(`${WORKER_URL}/rating/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: getDeviceId(), stars })
        });
        if (!res.ok) throw new Error('No se pudo enviar la valoración');
        const data = await res.json();
        __extrasCache[id] = __extrasCache[id] || { comments: [], downloads: 0 };
        __extrasCache[id].rating = data;
        try { localStorage.setItem(`coreassets_myrating_${id}`, String(stars)); } catch (e) { }
        renderRatingWidget(id);
        refreshCardStats(id);
        showNotify("¡Gracias por tu valoración!");
    } catch (e) {
        showNotify(e.message || "No se pudo enviar la valoración", "error");
    } finally {
        __ratingInFlight[id] = false;
    }
}

function renderComments(id) {
    const list = document.getElementById(`commentsList-${id}`);
    if (!list) return;
    const comments = (__extrasCache[id] && __extrasCache[id].comments) || [];
    if (!comments.length) {
        list.innerHTML = `<p class="text-slate-500 text-sm">Sé el primero en comentar.</p>`;
        return;
    }
    // Every field here comes from other users, so it is always escaped.
    list.innerHTML = comments.map(c => `
        <div class="bg-black/20 border border-white/5 rounded-xl p-4">
            <div class="flex justify-between items-center mb-1">
                <span class="font-bold text-sm text-blue-400">${escapeHTML(c.username || 'Anónimo')}</span>
                <span class="text-slate-600 text-[10px]">${escapeHTML(formatCommentDate(c.createdAt))}</span>
            </div>
            <p class="text-slate-300 text-sm whitespace-pre-line">${escapeHTML(c.text)}</p>
        </div>
    `).join('');
}

function formatCommentDate(iso) {
    try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleDateString();
    } catch (e) { return ''; }
}

let __commentSubmitting = {};
async function submitComment(id) {
    const input = document.getElementById(`commentInput-${id}`);
    const btn = document.getElementById(`commentBtn-${id}`);
    if (!input) return;
    const text = input.value.trim();
    if (!text) { showNotify("Escribe algo antes de enviar.", "error"); return; }
    if (text.length > 500) { showNotify("Máximo 500 caracteres.", "error"); return; }
    if (__commentSubmitting[id]) return; // basic client-side rate limit against spam-clicking
    __commentSubmitting[id] = true;
    if (btn) { btn.disabled = true; btn.classList.add('opacity-50'); }

    try {
        const res = await fetch(`${WORKER_URL}/comments/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: getDeviceId(), username: safeUsername(), text })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'No se pudo publicar el comentario');
        }
        const data = await res.json();
        __extrasCache[id] = __extrasCache[id] || { rating: { average: 0, count: 0 }, downloads: 0 };
        __extrasCache[id].comments = data.items || [];
        input.value = '';
        renderComments(id);
        showNotify("Comentario publicado.");
    } catch (e) {
        showNotify(e.message || "No se pudo publicar el comentario", "error");
    } finally {
        __commentSubmitting[id] = false;
        if (btn) { btn.disabled = false; btn.classList.remove('opacity-50'); }
    }
}

// Public visitors are not necessarily logged into the admin user system,
// so fall back to a friendly generic name when there's no registered device.
function safeUsername() {
    try {
        const u = findUserByDeviceId(getDeviceId());
        return (u && u.usuario) ? u.usuario : 'Visitante';
    } catch (e) { return 'Visitante'; }
}

async function trackDownload(id) {
    try {
        const res = await fetch(`${WORKER_URL}/download/${id}`, { method: 'POST' });
        if (!res.ok) return;
        const data = await res.json();
        __extrasCache[id] = __extrasCache[id] || { comments: [], rating: { average: 0, count: 0 } };
        __extrasCache[id].downloads = data.count || 0;
        const dlEl = document.getElementById(`downloadCount-${id}`);
        if (dlEl) dlEl.innerText = String(__extrasCache[id].downloads);
        refreshCardStats(id);
    } catch (e) { /* counting a download must never break the actual download */ }
}

function switchTab(t) {
    document.getElementById('sectionForm').classList.toggle('hidden', t !== 'create');
    document.getElementById('sectionManage').classList.toggle('hidden', t !== 'manage');
    document.getElementById('sectionUsers')?.classList.toggle('hidden', t !== 'users');
    document.getElementById('sectionPending')?.classList.toggle('hidden', t !== 'pending');
    document.getElementById('sectionComments')?.classList.toggle('hidden', t !== 'comments');

    [['tabCreate', 'create'], ['tabManage', 'manage'], ['tabUsers', 'users'], ['tabPending', 'pending'], ['tabComments', 'comments']].forEach(([elId, tabId]) => {
        const btn = document.getElementById(elId);
        if (!btn) return;
        btn.classList.toggle('bg-blue-600', t === tabId);
        btn.classList.toggle('bg-slate-800', t !== tabId);
    });

    if (t === 'manage') renderManageList();
    if (t === 'users') renderUsersList();
    if (t === 'pending') { renderPendingList(); refreshPendingFromServer().then(() => { renderPendingList(); updateAdminStats(); }); }
    if (t === 'comments') renderCommentsModeration();
    updateAdminStats();
}

// --- Admin comment moderation: pulls every asset's comments from the
// Worker (admin-authenticated) so abusive/spam comments can be removed.
async function renderCommentsModeration() {
    const list = document.getElementById('commentsModerationList');
    if (!list) return;
    list.innerHTML = `<p class="text-slate-500 text-center py-10">Cargando comentarios…</p>`;
    try {
        const token = getSessionToken();
        const res = await fetch(`${WORKER_URL}/comments-all`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) throw new Error('No se pudieron cargar los comentarios');
        const data = await res.json();
        const items = data.items || [];
        if (!items.length) { list.innerHTML = `<p class="text-slate-500 text-center py-10">No hay comentarios todavía.</p>`; return; }

        const vyn = isCurrentUserVyn();
        list.innerHTML = items.map(c => {
            const asset = allAssets.find(x => x.id == c.assetId);
            const assetTitle = asset ? asset.title : `Asset #${c.assetId}`;
            const deleteBtn = vyn
                ? `<button onclick="deleteCommentAdmin('${c.assetId}', '${c.id}')" class="bg-red-600/10 text-red-500 px-4 py-2 rounded-xl text-xs font-bold uppercase shrink-0">Delete</button>`
                : '';
            return `
            <div class="flex items-center justify-between bg-slate-900 p-4 rounded-2xl border border-white/5">
                <div>
                    <p class="text-slate-500 text-[10px] uppercase font-bold mb-1">${escapeHTML(assetTitle)}</p>
                    <p class="font-bold text-sm text-blue-400">${escapeHTML(c.username || 'Anónimo')}</p>
                    <p class="text-slate-300 text-sm">${escapeHTML(c.text)}</p>
                </div>
                ${deleteBtn}
            </div>`;
        }).join('');
    } catch (e) {
        list.innerHTML = `<p class="text-red-500 text-center py-10">${escapeHTML(e.message)}</p>`;
    }
}

async function deleteCommentAdmin(assetId, commentId) {
    try {
        await workerCall('/comments-delete', { assetId, commentId });
        showNotify("Comentario eliminado.");
        renderCommentsModeration();
        if (__extrasCache[assetId]) {
            __extrasCache[assetId].comments = (__extrasCache[assetId].comments || []).filter(c => c.id != commentId);
            renderComments(assetId);
        }
    } catch (e) {
        showNotify("No se pudo eliminar: " + e.message, "error");
    }
}

function renderManageList() {
    const l = document.getElementById('existingAssetsList');
    if(!l) return;
    const combined = assets.map(a => ({ ...a, __source: 'admin' }));
    l.innerHTML = combined.length ? "" : "<p class='text-slate-500 text-center py-10'>Empty.</p>";
    const myUsername = getCurrentUsername().trim().toLowerCase();
    const vyn = isCurrentUserVyn();
    combined.forEach(a => {
        const tag = `<span class="bg-blue-600/20 text-blue-400 text-[10px] font-black uppercase px-2 py-1 rounded-lg">${escapeHTML(a.autor || 'Admin')}</span>`;
        // UX-only gate: hides/disables the button for non-owners so the panel
        // doesn't invite an action that will just get rejected. The real
        // enforcement lives server-side in /save-assets on the Worker, since
        // this check alone can be bypassed from the browser.
        const isOwner = vyn || (a.autor || '').trim().toLowerCase() === myUsername;
        const editBtn = isOwner
            ? `<button onclick="prepareEdit('${a.id}', '${a.__source}')" class="bg-blue-600/10 text-blue-400 px-4 py-2 rounded-xl text-xs font-bold uppercase">Edit</button>`
            : `<button disabled title="Solo el dueño de este asset (o Vyn) puede editarlo" class="bg-slate-800 text-slate-600 px-4 py-2 rounded-xl text-xs font-bold uppercase cursor-not-allowed">Edit</button>`;
        const deleteBtn = isOwner
            ? `<button onclick="openDeleteModal('${a.id}', '${a.__source}')" class="bg-red-600/10 text-red-500 px-4 py-2 rounded-xl text-xs font-bold uppercase">Delete</button>`
            : `<button disabled title="Solo el dueño de este asset (o Vyn) puede eliminarlo" class="bg-slate-800 text-slate-600 px-4 py-2 rounded-xl text-xs font-bold uppercase cursor-not-allowed">Delete</button>`;
        l.innerHTML += `
            <div class="flex items-center justify-between bg-slate-900 p-4 rounded-2xl border border-white/5">
                <div class="flex items-center gap-4">
                    <img src="${escapeHTML(a.img)}" class="w-12 h-12 rounded-lg object-cover border border-white/10">
                    <div class="flex items-center gap-2">
                        <span class="font-bold text-sm">${escapeHTML(a.title)}</span>
                        ${tag}
                    </div>
                </div>
                <div class="flex gap-2">
                    ${editBtn}
                    ${deleteBtn}
                </div>
            </div>`;
    });
}

function renderPendingList() {
    const l = document.getElementById('pendingList');
    if (!l) return;
    l.innerHTML = pendingAssets.length ? "" : "<p class='text-slate-500 text-center py-10'>No hay assets pendientes de revisión.</p>";
    const myDeviceId = getDeviceId();

    pendingAssets.forEach(a => {
        const record = pendingQueue.find(x => x.id == a.queueId);
        const isOwn = record && record.submittedBy === myDeviceId;
        const tag = `<span class="bg-yellow-600/20 text-yellow-400 text-[10px] font-black uppercase px-2 py-1 rounded-lg">${escapeHTML(a.autor || 'Admin')}</span>`;

        l.innerHTML += `
            <div class="flex items-center justify-between bg-slate-900 p-4 rounded-2xl border border-white/5">
                <div class="flex items-center gap-4">
                    <img src="${escapeHTML(a.img)}" class="w-12 h-12 rounded-lg object-cover border border-white/10">
                    <div class="flex items-center gap-2">
                        <span class="font-bold text-sm">${escapeHTML(a.title)}</span>
                        ${tag}
                        ${isOwn ? '<span class="bg-slate-700 text-slate-400 text-[10px] font-black uppercase px-2 py-1 rounded-lg">Tuyo</span>' : ''}
                    </div>
                </div>
                <div class="flex gap-2">
                    <button onclick="prepareEdit('${a.queueId}', 'pending')" class="bg-blue-600/10 text-blue-400 px-4 py-2 rounded-xl text-xs font-bold uppercase">Edit</button>
                    <button onclick="approvePending('${a.queueId}')" ${isOwn ? 'disabled title="No puedes aprobar tu propia publicación"' : ''}
                        class="px-4 py-2 rounded-xl text-xs font-bold uppercase ${isOwn ? 'bg-slate-800 text-slate-600 cursor-not-allowed' : 'bg-green-600/10 text-green-500'}">Aprobar</button>
                    <button onclick="openDeleteModal('${a.queueId}', 'pending')" class="bg-red-600/10 text-red-500 px-4 py-2 rounded-xl text-xs font-bold uppercase">${isOwn ? 'Retirar' : 'Rechazar'}</button>
                </div>
            </div>`;
    });
}

// The Worker independently verifies (against Vyn-users.js) that this device
// belongs to Vyn, and rejects the call if this device is the submitter —
// the client-side "isCurrentUserVyn()" gate below is just UX, not the real lock.
async function approvePending(id) {
    try {
        await workerCall('/pending-approve', { id, deviceId: getDeviceId() });
        showNotify("Asset aprobado y publicado!");
        await refreshPendingFromServer();
        renderPendingList();
        await refreshAssetsFromKV();
        updateAdminStats();
    } catch (e) {
        showNotify("No se pudo aprobar: " + e.message, "error");
    }
}

function updatePendingTabVisibility() {
    const tabBtn = document.getElementById('tabPending');
    if (!tabBtn) return;
    tabBtn.classList.toggle('hidden', !isCurrentUserVyn());
}

function prepareEdit(id, source = 'admin') {
    const a = source === 'pending' ? pendingAssets.find(x => x.queueId == id) : assets.find(x => x.id == id);
    if (!a) return;
    document.getElementById('editId').value = id;
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
                    <span class="font-bold text-sm">${escapeHTML(u.usuario)}</span>
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
        try {
            await workerCall('/pending-reject', { id: assetToDelete, deviceId: getDeviceId() });
            await refreshPendingFromServer();
            renderPendingList();
            updateAdminStats();
            closeDeleteModal();
            showNotify("Asset rechazado.");
        } catch (e) {
            closeDeleteModal();
            showNotify("No se pudo rechazar: " + e.message, "error");
        }
    } else {
        const previousAssets = assets;
        assets = assets.filter(x => x.id != assetToDelete);
        try {
            await workerSave('/save-assets', generateAssetsFileContent(assets), 'Update assets from admin panel');
            setFileStatus(true, 'Publicado ✔️');
            renderManageList();
            updateAdminStats();
            closeDeleteModal();
            showNotify("Asset removed!");
        } catch (e) {
            // The Worker rejected the delete (e.g. not the owner and not Vyn) —
            // restore local state so the UI doesn't show a change that never saved.
            assets = previousAssets;
            renderManageList();
            closeDeleteModal();
            showNotify("No se pudo eliminar: " + e.message, "error");
        }
    }
});

// Fast public read: pulls the KV-backed asset cache (kept in sync by
// /save-assets and /pending-approve on the Worker) so publishes appear
// almost immediately instead of waiting on the GitHub Pages rebuild.
async function refreshAssetsFromKV() {
    try {
        const res = await fetch(`${WORKER_URL}/assets`);
        if (!res.ok) return;
        const data = await res.json();
        if (!Array.isArray(data.items)) return;

        assets = data.items.map(fromFileFormat);
        allAssets.length = 0;
        allAssets.push(...assets);

        if (document.getElementById('assetGrid')) { renderFilters(); renderAssetGrid(); updateHeroStats(); }
        if (document.getElementById('existingAssetsList') && !document.getElementById('sectionManage')?.classList.contains('hidden')) renderManageList();
    } catch (e) {  }
}
if (document.getElementById('assetGrid') || document.getElementById('adminContent')) {
    refreshAssetsFromKV();
}
