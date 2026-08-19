// ═══════════════════════════════════════════════════════════════
//  UmbraX — Pastefy upload helper
//  An alternate host to Rubis, offered alongside it in .upload and
//  .secure so a user can pick whichever one their executor reaches.
//  Mirrors rubis.js's hardening: host-allowlisted URLs, a timeout,
//  and a single POST path both commands share so they never drift.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

// Pastefy v2 create-paste endpoint. Anonymous UNLISTED pastes need no API key.
const PASTEFY_UPLOAD_URL = 'https://pastefy.app/api/v2/paste';
const PASTEFY_TIMEOUT_MS = 10_000;
// Only trust upload-response URLs under the real Pastefy host — a rogue/MITM
// `raw_url` must never end up inside the loader we hand the user.
const PASTEFY_HOSTS = new Set(['pastefy.app']);

// Return `url` only if it is an https URL under a known Pastefy host; else null.
function safePastefyUrl(url) {
    if (typeof url !== 'string') return null;
    try {
        const u = new URL(url);
        if (u.protocol !== 'https:') return null;
        return PASTEFY_HOSTS.has(u.hostname) ? url : null;
    } catch {
        return null;
    }
}

/**
 * POST `content` to Pastefy and return trusted URLs built from the paste id.
 * Throws on non-2xx / missing id / network error / timeout (AbortError).
 * @param {string} content
 * @param {string} [title] optional paste title
 * @returns {Promise<{ pasteId: string, rawUrl: string, viewUrl: string }>}
 */
async function uploadToPastefy(content, title) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PASTEFY_TIMEOUT_MS);

    let resp;
    try {
        resp = await fetch(PASTEFY_UPLOAD_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                title:      title || 'UmbraX Script',
                content,
                visibility: 'UNLISTED',
            }),
            signal:  controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }

    if (!resp.ok) throw new Error(`Pastefy returned HTTP ${resp.status}`);

    const data = await resp.json();
    const paste = data && data.paste ? data.paste : data;
    if (!paste || !paste.id) throw new Error('Pastefy response missing paste id');

    // The id builds our own trusted URLs. Accept the response's raw_url ONLY if
    // it resolves to a real Pastefy host over https — otherwise fall back to the
    // constructed URL, so a tampered response can't inject a foreign target.
    const pasteId = String(paste.id);
    return {
        pasteId,
        rawUrl:  safePastefyUrl(paste.raw_url) ?? `https://pastefy.app/${pasteId}/raw`,
        viewUrl: `https://pastefy.app/${pasteId}`,
    };
}

module.exports = { uploadToPastefy, safePastefyUrl, PASTEFY_TIMEOUT_MS, PASTEFY_HOSTS };
