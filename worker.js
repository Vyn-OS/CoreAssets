const GITHUB_OWNER = 'Vyn-OS';
const GITHUB_REPO = 'CoreAssets';
const GITHUB_BRANCH = 'main';

// Lista de orígenes permitidos. 'null' cubre el caso de abrir los archivos
// directamente con file:// (el navegador manda Origin: null en ese caso).
const ALLOWED_ORIGINS = [
    'https://vyn-os.github.io',
    'null'
];

// KV keys
const PENDING_KEY = 'pending_queue';
const ASSETS_CACHE_KEY = 'published_assets_cache';
const USERS_CACHE_KEY = 'admin_users_cache';

// Comments / ratings / downloads tuning
const MAX_COMMENT_LENGTH = 500;
const MAX_COMMENTS_PER_ASSET = 300;
const COMMENT_RATE_LIMIT_SECONDS = 60;

// Login rate-limit: 5 intentos fallidos por IP en 15 minutos.
const LOGIN_RATE_LIMIT_MAX = 5;
const LOGIN_RATE_LIMIT_SECONDS = 15 * 60;

// ============================================================================
// HTTP helpers
// ============================================================================

function corsHeaders(request) {
    const origin = request?.headers.get('Origin');
    const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin': allow,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Vary': 'Origin',
    };
}

// Baseline security headers applied to every response. CSP here is
// deliberately restrictive — the API returns JSON, nothing else, so no
// 'unsafe-inline' or external origins are needed. The public pages set
// their own CSP via <meta> since they load Tailwind CDN + fonts.
const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};

function json(request, data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...SECURITY_HEADERS,
            ...corsHeaders(request),
            ...extraHeaders
        }
    });
}

// ============================================================================
// Session & identity
// ============================================================================

async function isValidSession(request, env) {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace('Bearer ', '').trim();
    if (!token) return false;
    const sess = await env.SESSIONS.get(token);
    return !!sess;
}

// Resolves the deviceId tied to the current session token. Ownership checks
// use this instead of trusting the request body, since the body is client-
// controlled and could be forged by anyone holding a valid token.
async function getSessionDeviceId(request, env) {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace('Bearer ', '').trim();
    if (!token) return null;
    const raw = await env.SESSIONS.get(token);
    if (!raw) return null;
    try { return JSON.parse(raw).deviceId || null; } catch (e) { return null; }
}

async function getUsernameForDevice(env, deviceId) {
    if (!deviceId) return null;
    const users = await getAdminUsers(env);
    const u = users.find(x => x.deviceId === deviceId);
    return (u && !u.banned) ? (u.usuario || '').trim() : null;
}

// ============================================================================
// GitHub (only used now for Vyn-users.js and Vyn-body.js)
// ============================================================================

async function saveFileToGithub(env, path, content, message) {
    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
    const headers = {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'coreassets-worker'
    };

    let sha = null;
    const getRes = await fetch(`${apiUrl}?ref=${GITHUB_BRANCH}`, { headers });
    if (getRes.ok) {
        const data = await getRes.json();
        sha = data.sha;
    }

    const body = {
        message,
        content: btoa(unescape(encodeURIComponent(content))),
        branch: GITHUB_BRANCH
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(apiUrl, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!putRes.ok) {
        const err = await putRes.json().catch(() => ({}));
        throw new Error(err.message || `GitHub error ${putRes.status}`);
    }
    return putRes.json();
}

// ============================================================================
// Assets (KV only)
// ============================================================================

// Legacy parser, kept ONLY for the one-time bootstrap below. Once KV has
// data, this never runs again — you can delete it (and the bootstrap
// function) after confirming /assets returns from KV.
function parseAssetsFileContent(content) {
    const match = content.match(/var\s+assetsCreados\s*=\s*(\[[\s\S]*\]);?/);
    if (!match) return [];
    try { return JSON.parse(match[1]); } catch (e) { return []; }
}

function assetsContentEqual(a, b) {
    const fields = ['nome', 'descricao', 'descricaoLonga', 'linkDownload', 'formato', 'tamanho', 'status', 'fail', 'autor'];
    for (const f of fields) {
        if ((a[f] ?? '') !== (b[f] ?? '')) return false;
    }
    if (JSON.stringify(a.categoria || []) !== JSON.stringify(b.categoria || [])) return false;
    if (JSON.stringify(a.imagens || []) !== JSON.stringify(b.imagens || [])) return false;
    return true;
}

// Single source of truth for the published list. KV-only; the first time
// it finds KV empty, it tries to seed from the legacy Vyn-assets.js file
// so the switch doesn't lose anything. That fetch fails silently if the
// file is already gone — you just start from an empty library instead.
async function getAssetsFromKV(env) {
    const cached = await env.SESSIONS.get(ASSETS_CACHE_KEY);
    if (cached) {
        try { return JSON.parse(cached); } catch (e) { return []; }
    }

    try {
        const raw = await fetch(
            `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/Vyn-assets.js`
        );
        if (!raw.ok) return [];
        const text = await raw.text();
        const parsed = parseAssetsFileContent(text);
        await env.SESSIONS.put(ASSETS_CACHE_KEY, JSON.stringify(parsed));
        return parsed;
    } catch (e) {
        return [];
    }
}

// ============================================================================
// Users (still GitHub-backed)
// ============================================================================

function parseUsersFileContent(content) {
    const match = content.match(/var\s+adminUsers\s*=\s*(\[[\s\S]*\]);?/);
    if (!match) return [];
    try { return JSON.parse(match[1]); } catch (e) { return []; }
}

async function getAdminUsers(env) {
    let cached = await env.SESSIONS.get(USERS_CACHE_KEY);
    if (!cached) {
        const raw = await fetch(
            `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/Vyn-users.js`
        );
        if (raw.ok) {
            const text = await raw.text();
            const parsed = parseUsersFileContent(text);
            cached = JSON.stringify(parsed);
            await env.SESSIONS.put(USERS_CACHE_KEY, cached);
        } else {
            cached = '[]';
        }
    }
    return JSON.parse(cached);
}

async function isDeviceVyn(env, deviceId) {
    if (!deviceId) return false;
    const users = await getAdminUsers(env);
    const u = users.find(x => x.deviceId === deviceId);
    return !!u && !u.banned && (u.usuario || '').trim().toLowerCase() === 'vyn';
}

// ============================================================================
// Pending queue
// ============================================================================

async function getPendingQueue(env) {
    const raw = await env.SESSIONS.get(PENDING_KEY);
    return raw ? JSON.parse(raw) : [];
}

async function setPendingQueue(env, items) {
    await env.SESSIONS.put(PENDING_KEY, JSON.stringify(items));
}

// ============================================================================
// Comments
// ============================================================================

function commentsKey(assetId) { return `comments:${assetId}`; }

async function getComments(env, assetId) {
    const raw = await env.SESSIONS.get(commentsKey(assetId));
    return raw ? JSON.parse(raw) : [];
}

async function setComments(env, assetId, items) {
    await env.SESSIONS.put(commentsKey(assetId), JSON.stringify(items));
}

// ============================================================================
// Ratings
// ============================================================================

function ratingsKey(assetId) { return `ratings:${assetId}`; }

async function getRatingsMap(env, assetId) {
    const raw = await env.SESSIONS.get(ratingsKey(assetId));
    return raw ? JSON.parse(raw) : {};
}

function summarizeRatings(map) {
    const values = Object.values(map);
    const count = values.length;
    const average = count ? values.reduce((a, b) => a + b, 0) / count : 0;
    return { average, count };
}

// ============================================================================
// Downloads
// ============================================================================

function downloadsKey(assetId) { return `downloads:${assetId}`; }

async function getDownloadCount(env, assetId) {
    const raw = await env.SESSIONS.get(downloadsKey(assetId));
    return raw ? parseInt(raw, 10) || 0 : 0;
}

// ============================================================================
// Entry point
// ============================================================================

export default {
    async fetch(request, env) {
        try {
            return await handleRequest(request, env);
        } catch (e) {
            // Without this, an uncaught exception returns Cloudflare's raw
            // error page with NO CORS headers, which the browser reports as
            // a misleading "blocked by CORS" error even when the real
            // problem is a 500.
            return json(request, { error: e.message || 'Internal error' }, 500);
        }
    }
};

async function handleRequest(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: { ...SECURITY_HEADERS, ...corsHeaders(request) } });
    }

    // ------------------------------------------------------------------------
    // AUTH
    // ------------------------------------------------------------------------
    if (url.pathname === '/login' && request.method === 'POST') {
        // Client IP for rate-limiting. CF-Connecting-IP is set by Cloudflare
        // and can't be spoofed by the client behind their edge.
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rlKey = `ratelimit:login:${ip}`;

        const currentAttempts = parseInt(await env.SESSIONS.get(rlKey) || '0', 10);
        if (currentAttempts >= LOGIN_RATE_LIMIT_MAX) {
            const retryAfter = LOGIN_RATE_LIMIT_SECONDS;
            return json(request,
                { error: `Demasiados intentos. Espera ${Math.ceil(retryAfter / 60)} minutos.` },
                429,
                { 'Retry-After': String(retryAfter) }
            );
        }

        const { password, deviceId } = await request.json().catch(() => ({}));
        if (password !== env.ADMIN_PASSWORD) {
            // Increment only on failure. First attempt that fails sets the
            // TTL, so the window is "5 fails inside 15 min" from the first.
            await env.SESSIONS.put(rlKey, String(currentAttempts + 1), {
                expirationTtl: LOGIN_RATE_LIMIT_SECONDS
            });
            return json(request, { error: 'Incorrect password' }, 401);
        }

        // Successful login clears the counter for this IP.
        await env.SESSIONS.delete(rlKey);

        const token = crypto.randomUUID();
        // deviceId is stored alongside the token so later requests can
        // resolve "who is making this call" server-side, instead of trusting
        // a deviceId sent in the request body.
        await env.SESSIONS.put(token, JSON.stringify({ created: Date.now(), deviceId: deviceId || null }), {
            expirationTtl: 3600
        });
        return json(request, { token });
    }

    // ------------------------------------------------------------------------
    // PUBLIC: fast asset read from KV
    // ------------------------------------------------------------------------
    if (url.pathname === '/assets' && request.method === 'GET') {
        const items = await getAssetsFromKV(env);
        return json(request, { items }, 200, { 'Cache-Control': 'public, max-age=15' });
    }

    // ------------------------------------------------------------------------
    // AGGREGATED EXTRAS: comments + rating + downloads for one asset
    // Replaces 3 separate fetches in the modal with 1 round-trip.
    // ------------------------------------------------------------------------
    const extrasMatch = url.pathname.match(/^\/asset\/([^/]+)\/extras$/);
    if (extrasMatch && request.method === 'GET') {
        const assetId = extrasMatch[1];
        const [comments, ratingsMap, downloads] = await Promise.all([
            getComments(env, assetId),
            getRatingsMap(env, assetId),
            getDownloadCount(env, assetId)
        ]);
        return json(request, {
            comments,
            rating: summarizeRatings(ratingsMap),
            downloads
        }, 200, { 'Cache-Control': 'public, max-age=5' });
    }

    // ------------------------------------------------------------------------
    // ADMIN: overwrite the whole published list (KV-only)
    // Body: { assets: [ ... ], message?: string }
    // ------------------------------------------------------------------------
    if (url.pathname === '/save-assets' && request.method === 'POST') {
        if (!(await isValidSession(request, env))) return json(request, { error: 'Unauthorized' }, 401);

        const body = await request.json().catch(() => ({}));
        const after = Array.isArray(body.assets) ? body.assets : null;
        if (!after) return json(request, { error: 'Missing assets array' }, 400);

        const deviceId = await getSessionDeviceId(request, env);
        const username = await getUsernameForDevice(env, deviceId);
        const vyn = await isDeviceVyn(env, deviceId);

        const before = await getAssetsFromKV(env);
        const beforeById = new Map(before.map(a => [String(a.id), a]));
        const afterById = new Map(after.map(a => [String(a.id), a]));
        const isOwner = (autor) => !!username && (autor || '').trim().toLowerCase() === username.toLowerCase();

        if (!vyn) {
            // Deleted
            for (const b of before) {
                if (!afterById.has(String(b.id)) && !isOwner(b.autor)) {
                    return json(request, { error: `No puedes eliminar "${b.nome || b.id}" — no eres el dueño de este asset.` }, 403);
                }
            }
            // Edited
            for (const a of after) {
                const b = beforeById.get(String(a.id));
                if (b && !assetsContentEqual(a, b) && !isOwner(b.autor)) {
                    return json(request, { error: `No puedes editar "${b.nome || b.id}" — no eres el dueño de este asset.` }, 403);
                }
            }
            // New
            for (const a of after) {
                if (!beforeById.has(String(a.id)) && !isOwner(a.autor)) {
                    return json(request, { error: `No puedes publicar "${a.nome || a.id}" a nombre de otro usuario.` }, 403);
                }
            }
        }

        await env.SESSIONS.put(ASSETS_CACHE_KEY, JSON.stringify(after));
        return json(request, { ok: true });
    }

    // ------------------------------------------------------------------------
    // Vyn-body.js (still GitHub-backed)
    // ------------------------------------------------------------------------
    if (url.pathname === '/save-library' && request.method === 'POST') {
        if (!(await isValidSession(request, env))) return json(request, { error: 'Unauthorized' }, 401);
        const { content, message } = await request.json().catch(() => ({}));
        if (!content) return json(request, { error: 'Missing content' }, 400);
        try {
            const result = await saveFileToGithub(env, 'Vyn-body.js', content, message || 'Update library from admin panel');
            return json(request, { ok: true, commit: result.commit?.sha });
        } catch (e) {
            return json(request, { error: e.message }, 500);
        }
    }

    // ------------------------------------------------------------------------
    // Vyn-users.js (still GitHub-backed)
    // ------------------------------------------------------------------------
    if (url.pathname === '/save-users' && request.method === 'POST') {
        if (!(await isValidSession(request, env))) return json(request, { error: 'Unauthorized' }, 401);
        const { content, message } = await request.json().catch(() => ({}));
        if (!content) return json(request, { error: 'Missing content' }, 400);
        try {
            const result = await saveFileToGithub(env, 'Vyn-users.js', content, message || 'Update admin users from admin panel');
            // Keep the role-check cache in sync so approvals see fresh roles immediately.
            await env.SESSIONS.put(USERS_CACHE_KEY, JSON.stringify(parseUsersFileContent(content)));
            return json(request, { ok: true, commit: result.commit?.sha });
        } catch (e) {
            return json(request, { error: e.message }, 500);
        }
    }

    // ------------------------------------------------------------------------
    // PENDING
    // ------------------------------------------------------------------------

    if (url.pathname === '/pending-list' && request.method === 'GET') {
        if (!(await isValidSession(request, env))) return json(request, { error: 'Unauthorized' }, 401);
        const items = await getPendingQueue(env);
        return json(request, { items });
    }

    // Submit a new asset for review. submittedBy is resolved from the
    // session token, not trusted from the body — otherwise a submitter
    // could forge someone else's deviceId and later dodge the
    // "can't approve your own submission" check.
    if (url.pathname === '/pending-submit' && request.method === 'POST') {
        if (!(await isValidSession(request, env))) return json(request, { error: 'Unauthorized' }, 401);
        const { asset } = await request.json().catch(() => ({}));
        const deviceId = await getSessionDeviceId(request, env);
        if (!asset || !deviceId) return json(request, { error: 'Missing asset or deviceId' }, 400);

        const items = await getPendingQueue(env);
        items.push({
            id: Date.now(),
            asset,
            submittedBy: deviceId,
            submittedAt: new Date().toISOString()
        });
        await setPendingQueue(env, items);
        return json(request, { ok: true });
    }

    // Edit an asset still in the queue. Allowed for the original submitter
    // or for Vyn. deviceId comes from the session token, not the body.
    if (url.pathname === '/pending-update' && request.method === 'POST') {
        if (!(await isValidSession(request, env))) return json(request, { error: 'Unauthorized' }, 401);
        const { id, asset } = await request.json().catch(() => ({}));
        if (!id || !asset) return json(request, { error: 'Missing id or asset' }, 400);

        const items = await getPendingQueue(env);
        const item = items.find(x => x.id == id);
        if (!item) return json(request, { error: 'Pending item not found' }, 404);

        const deviceId = await getSessionDeviceId(request, env);
        const vyn = await isDeviceVyn(env, deviceId);
        if (item.submittedBy !== deviceId && !vyn) {
            return json(request, { error: 'No autorizado para editar este elemento.' }, 403);
        }

        item.asset = asset;
        await setPendingQueue(env, items);
        return json(request, { ok: true });
    }

    // Approve: moves the item into the published assets list. KV-only now.
    // Server-verified rules:
    //   1. Only a device registered as "Vyn" in Vyn-users.js may approve.
    //   2. A submitter can never approve their own item, even if they are Vyn.
    if (url.pathname === '/pending-approve' && request.method === 'POST') {
        if (!(await isValidSession(request, env))) return json(request, { error: 'Unauthorized' }, 401);
        const { id } = await request.json().catch(() => ({}));
        if (!id) return json(request, { error: 'Missing id' }, 400);

        const deviceId = await getSessionDeviceId(request, env);
        const vyn = await isDeviceVyn(env, deviceId);
        if (!vyn) return json(request, { error: 'Solo Vyn puede aprobar publicaciones.' }, 403);

        const items = await getPendingQueue(env);
        const item = items.find(x => x.id == id);
        if (!item) return json(request, { error: 'Pending item not found' }, 404);

        if (item.submittedBy === deviceId) {
            return json(request, { error: 'No puedes aprobar tu propia publicación.' }, 403);
        }

        const currentAssets = await getAssetsFromKV(env);
        currentAssets.push(item.asset);
        await env.SESSIONS.put(ASSETS_CACHE_KEY, JSON.stringify(currentAssets));

        const remaining = items.filter(x => x.id != id);
        await setPendingQueue(env, remaining);

        return json(request, { ok: true });
    }

    // Reject/withdraw. Allowed for Vyn (rejecting anyone's submission) or
    // for the original submitter (withdrawing their own).
    if (url.pathname === '/pending-reject' && request.method === 'POST') {
        if (!(await isValidSession(request, env))) return json(request, { error: 'Unauthorized' }, 401);
        const { id } = await request.json().catch(() => ({}));
        if (!id) return json(request, { error: 'Missing id' }, 400);

        const items = await getPendingQueue(env);
        const item = items.find(x => x.id == id);
        if (!item) return json(request, { ok: true }); // already gone, nothing to do

        const deviceId = await getSessionDeviceId(request, env);
        const vyn = await isDeviceVyn(env, deviceId);
        if (item.submittedBy !== deviceId && !vyn) {
            return json(request, { error: 'No autorizado para rechazar este elemento.' }, 403);
        }

        const remaining = items.filter(x => x.id != id);
        await setPendingQueue(env, remaining);
        return json(request, { ok: true });
    }

    // ------------------------------------------------------------------------
    // COMMENTS (public read/write)
    // ------------------------------------------------------------------------
    const commentsMatch = url.pathname.match(/^\/comments\/([^/]+)$/);
    if (commentsMatch && request.method === 'GET') {
        const items = await getComments(env, commentsMatch[1]);
        return json(request, { items });
    }

    if (commentsMatch && request.method === 'POST') {
        const assetId = commentsMatch[1];
        const body = await request.json().catch(() => ({}));
        const deviceId = String(body.deviceId || '').slice(0, 100);
        const username = String(body.username || 'Anónimo').slice(0, 40);
        const text = String(body.text || '').trim();

        if (!deviceId) return json(request, { error: 'Missing deviceId' }, 400);
        if (!text) return json(request, { error: 'Empty comment' }, 400);
        if (text.length > MAX_COMMENT_LENGTH) return json(request, { error: 'Comment too long' }, 400);

        const rlKey = `ratelimit:comment:${deviceId}`;
        if (await env.SESSIONS.get(rlKey)) {
            return json(request, { error: 'Estás comentando demasiado rápido, espera un momento.' }, 429);
        }
        await env.SESSIONS.put(rlKey, '1', { expirationTtl: COMMENT_RATE_LIMIT_SECONDS });

        const items = await getComments(env, assetId);
        items.push({
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
            deviceId,
            username,
            text,
            createdAt: new Date().toISOString()
        });
        const trimmed = items.slice(-MAX_COMMENTS_PER_ASSET);
        await setComments(env, assetId, trimmed);
        return json(request, { items: trimmed });
    }

    // Admin moderation: list every comment across every asset.
    if (url.pathname === '/comments-all' && request.method === 'GET') {
        if (!(await isValidSession(request, env))) return json(request, { error: 'Unauthorized' }, 401);
        const list = await env.SESSIONS.list({ prefix: 'comments:' });
        const all = [];
        for (const key of list.keys) {
            const assetId = key.name.replace('comments:', '');
            const items = await getComments(env, assetId);
            items.forEach(c => all.push({ ...c, assetId }));
        }
        all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return json(request, { items: all });
    }

    if (url.pathname === '/comments-delete' && request.method === 'POST') {
        if (!(await isValidSession(request, env))) return json(request, { error: 'Unauthorized' }, 401);
        const deviceId = await getSessionDeviceId(request, env);
        if (!(await isDeviceVyn(env, deviceId))) return json(request, { error: 'Solo Vyn puede eliminar comentarios.' }, 403);
        const { assetId, commentId } = await request.json().catch(() => ({}));
        if (!assetId || !commentId) return json(request, { error: 'Missing assetId or commentId' }, 400);

        const items = await getComments(env, assetId);
        const filtered = items.filter(c => c.id !== commentId);
        await setComments(env, assetId, filtered);
        return json(request, { ok: true });
    }

    // ------------------------------------------------------------------------
    // RATINGS (public, one per device per asset, overwritable)
    // ------------------------------------------------------------------------
    const ratingMatch = url.pathname.match(/^\/rating\/([^/]+)$/);
    if (ratingMatch && request.method === 'GET') {
        const map = await getRatingsMap(env, ratingMatch[1]);
        return json(request, summarizeRatings(map));
    }

    if (ratingMatch && request.method === 'POST') {
        const assetId = ratingMatch[1];
        const body = await request.json().catch(() => ({}));
        const deviceId = String(body.deviceId || '').slice(0, 100);
        const stars = Number(body.stars);

        if (!deviceId) return json(request, { error: 'Missing deviceId' }, 400);
        if (!Number.isInteger(stars) || stars < 1 || stars > 5) return json(request, { error: 'Invalid rating' }, 400);

        const map = await getRatingsMap(env, assetId);
        map[deviceId] = stars;
        await env.SESSIONS.put(ratingsKey(assetId), JSON.stringify(map));
        return json(request, summarizeRatings(map));
    }

    // ------------------------------------------------------------------------
    // DOWNLOAD COUNTER (public, best-effort)
    // KV is eventually-consistent, so under heavy concurrent traffic this
    // read-then-write can lose a few increments — an acceptable trade-off
    // for a display counter.
    // ------------------------------------------------------------------------
    const downloadsMatch = url.pathname.match(/^\/downloads\/([^/]+)$/);
    if (downloadsMatch && request.method === 'GET') {
        const count = await getDownloadCount(env, downloadsMatch[1]);
        return json(request, { count });
    }

    const downloadMatch = url.pathname.match(/^\/download\/([^/]+)$/);
    if (downloadMatch && request.method === 'POST') {
        const assetId = downloadMatch[1];
        const count = (await getDownloadCount(env, assetId)) + 1;
        await env.SESSIONS.put(downloadsKey(assetId), String(count));
        return json(request, { count });
    }

    return json(request, { error: 'Not found' }, 404);
}