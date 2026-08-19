// ═══════════════════════════════════════════════════════════════
//  UmbraX — Rubis upload helper
//  Shared by .secure (obfuscated + ID-locked host) and .upload (plain
//  host). Keeps a single, hardened upload path so the two commands can
//  never drift on URL validation or timeout behaviour.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const RUBIS_UPLOAD_URL = 'https://api.rubis.app/v2/scrap?public=true&title=UmbraX%20Script';
const RUBIS_TIMEOUT_MS = 10_000;
// Only trust upload-response URLs that live under the real Rubis host — a
// rogue/MITM `raw` field must never end up inside the loader we hand the user.
const RUBIS_HOSTS = new Set(['rubis.app', 'api.rubis.app']);

// Return `url` only if it is an https URL under a known Rubis host; else null.
function safeRubisUrl(url) {
    if (typeof url !== 'string') return null;
    try {
        const u = new URL(url);
        if (u.protocol !== 'https:') return null;
        return RUBIS_HOSTS.has(u.hostname) ? url : null;
    } catch {
        return null;
    }
}

/**
 * POST `content` to Rubis and return trusted URLs built from the scrapID.
 * Throws on non-2xx / missing scrapID / network error / timeout (AbortError).
 * @param {string} content
 * @param {string} [title] optional scrap title (URL-encoded into the endpoint)
 * @returns {Promise<{ scrapID: string, rawUrl: string, viewUrl: string }>}
 */
async function uploadToRubis(content, title) {
    const url = title
        ? `https://api.rubis.app/v2/scrap?public=true&title=${encodeURIComponent(title)}`
        : RUBIS_UPLOAD_URL;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RUBIS_TIMEOUT_MS);

    let resp;
    try {
        resp = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'text/plain' },
            body:    content,
            signal:  controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }

    if (!resp.ok) throw new Error(`Rubis returned HTTP ${resp.status}`);

    const data = await resp.json();
    if (!data.scrapID) throw new Error('Rubis response missing scrapID');

    // The scrapID is used to build our own trusted URLs. Accept the response's
    // raw/view fields ONLY if they resolve to a real Rubis host over https —
    // otherwise fall back to the constructed URLs, so a tampered response can't
    // inject a foreign loader target.
    const scrapID = String(data.scrapID);
    return {
        scrapID,
        rawUrl:  safeRubisUrl(data.raw)  ?? `https://api.rubis.app/v2/scrap/${scrapID}/raw`,
        viewUrl: safeRubisUrl(data.view) ?? `https://rubis.app/view/?scrap=${scrapID}`,
    };
}

module.exports = { uploadToRubis, safeRubisUrl, RUBIS_TIMEOUT_MS, RUBIS_HOSTS };
