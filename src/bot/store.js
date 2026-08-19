// ═══════════════════════════════════════════════════════════════
//  UmbraX — Persistent State Store
//
//  Persists cooldowns + usage stats to data/state.json so a restart
//  doesn't reset stats or let users bypass the cooldown by triggering
//  a restart. Writes are debounced and atomic (temp file + rename).
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const WRITE_DEBOUNCE_MS = 2000;

class Store {
    constructor() {
        this.cooldowns = new Map();   // userId -> last-use epoch ms
        this.stats = { total: 0, totalBytes: 0, errors: 0, encrypts: 0, uploads: 0, guardsDeployed: 0, users: new Set() };
        this.firstSeen = Date.now();   // when stats tracking began; persisted below
        // Active + finished giveaways, keyed by their message id. Persisted so a
        // restart doesn't drop the timer or lose entrants (see giveaway.js).
        this.giveaways = new Map();   // messageId -> giveaway record
        // Monotonic per-guild ticket number so ticket channels are named
        // ticket-0001, ticket-0002, … regardless of who opens them.
        this.ticketCounters = new Map();   // guildId -> last-used number
        // Staff-configured application positions, keyed by guild. Each value is
        // an array of position records (see application.js for the shape).
        this.applications = new Map();   // guildId -> [ position, … ]
        // Moderation warnings, persisted so they survive restarts. Keyed by
        // `${guildId}:${userId}`; each value is an array of warn records
        // { reason, by, at } (see moderation.js).
        this.warnings = new Map();   // "guildId:userId" -> [ { reason, by, at }, … ]
        this._writeTimer = null;
        this._load();
    }

    _load() {
        try {
            const raw = fs.readFileSync(STATE_FILE, 'utf-8');
            const data = JSON.parse(raw);
            if (data.cooldowns) for (const [k, v] of Object.entries(data.cooldowns)) this.cooldowns.set(k, v);
            if (data.stats) {
                this.stats.total = data.stats.total || 0;
                this.stats.totalBytes = data.stats.totalBytes || 0;
                this.stats.errors = data.stats.errors || 0;
                this.stats.encrypts = data.stats.encrypts || 0;
                this.stats.uploads = data.stats.uploads || 0;
                this.stats.guardsDeployed = data.stats.guardsDeployed || 0;
                this.stats.users = new Set(data.stats.users || []);
            }
            if (data.firstSeen) this.firstSeen = data.firstSeen;
            if (Array.isArray(data.giveaways)) {
                for (const g of data.giveaways) if (g && g.messageId) this.giveaways.set(g.messageId, g);
            }
            if (data.ticketCounters) for (const [k, v] of Object.entries(data.ticketCounters)) this.ticketCounters.set(k, v);
            if (data.applications) for (const [k, v] of Object.entries(data.applications)) if (Array.isArray(v)) this.applications.set(k, v);
            if (data.warnings) for (const [k, v] of Object.entries(data.warnings)) if (Array.isArray(v)) this.warnings.set(k, v);
        } catch (err) {
            if (err.code !== 'ENOENT') console.warn('[store] could not load state:', err.message);
            // Fresh start otherwise.
        }
    }

    // Debounced persist — coalesces bursts of updates into one write.
    save() {
        if (this._writeTimer) return;
        this._writeTimer = setTimeout(() => {
            this._writeTimer = null;
            this._flush();
        }, WRITE_DEBOUNCE_MS);
        if (this._writeTimer.unref) this._writeTimer.unref();
    }

    _flush() {
        const data = {
            cooldowns: Object.fromEntries(this.cooldowns),
            stats: {
                total: this.stats.total,
                totalBytes: this.stats.totalBytes,
                errors: this.stats.errors,
                encrypts: this.stats.encrypts,
                uploads: this.stats.uploads,
                guardsDeployed: this.stats.guardsDeployed,
                users: [...this.stats.users],
            },
            firstSeen: this.firstSeen,
            giveaways: [...this.giveaways.values()],
            ticketCounters: Object.fromEntries(this.ticketCounters),
            applications: Object.fromEntries(this.applications),
            warnings: Object.fromEntries(this.warnings),
            savedAt: Date.now(),
        };
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            const tmp = STATE_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
            fs.renameSync(tmp, STATE_FILE);   // atomic replace
        } catch (err) {
            console.warn('[store] could not save state:', err.message);
        }
    }

    // Synchronous flush for shutdown handlers.
    flushNow() {
        if (this._writeTimer) { clearTimeout(this._writeTimer); this._writeTimer = null; }
        this._flush();
    }

    // ── Cooldown helpers ─────────────────────────────────────────
    getCooldown(userId) { return this.cooldowns.get(userId) ?? 0; }
    setCooldown(userId, when) { this.cooldowns.set(userId, when); this.save(); }

    // ── Giveaway helpers ─────────────────────────────────────────
    // Records are plain JSON-serialisable objects (see giveaway.js for shape);
    // callers mutate then call saveGiveaway to persist.
    getGiveaway(messageId)   { return this.giveaways.get(messageId) ?? null; }
    listGiveaways()          { return [...this.giveaways.values()]; }
    saveGiveaway(g)          { if (g && g.messageId) { this.giveaways.set(g.messageId, g); this.save(); } }
    deleteGiveaway(messageId) { if (this.giveaways.delete(messageId)) this.save(); }

    // ── Ticket counter ───────────────────────────────────────────
    // Returns the next ticket number for a guild (1-based) and persists it.
    nextTicketNumber(guildId) {
        const n = (this.ticketCounters.get(guildId) ?? 0) + 1;
        this.ticketCounters.set(guildId, n);
        this.save();
        return n;
    }

    // ── Application positions ─────────────────────────────────────
    // Positions are plain JSON-serialisable records (see application.js for the
    // shape: { key, label, roleId, questions: [...] }). Stored per guild.
    listPositions(guildId)      { return this.applications.get(guildId) ?? []; }
    getPosition(guildId, key)   { return this.listPositions(guildId).find(p => p.key === key) ?? null; }
    savePosition(guildId, pos) {
        if (!pos || !pos.key) return;
        const list = this.applications.get(guildId) ?? [];
        const idx = list.findIndex(p => p.key === pos.key);
        if (idx === -1) list.push(pos); else list[idx] = pos;
        this.applications.set(guildId, list);
        this.save();
    }
    deletePosition(guildId, key) {
        const list = this.applications.get(guildId);
        if (!list) return false;
        const next = list.filter(p => p.key !== key);
        if (next.length === list.length) return false;
        this.applications.set(guildId, next);
        this.save();
        return true;
    }

    // ── Moderation warnings (persisted) ──────────────────────────
    // Records are { reason, by, at } objects; callers read the list to count
    // and render. Keyed by guild+user so the same user in two guilds is separate.
    _warnKey(guildId, userId) { return `${guildId}:${userId}`; }
    getWarnings(guildId, userId) { return this.warnings.get(this._warnKey(guildId, userId)) ?? []; }
    addWarning(guildId, userId, record) {
        const key = this._warnKey(guildId, userId);
        const list = this.warnings.get(key) ?? [];
        list.push(record);
        this.warnings.set(key, list);
        this.save();
        return list.length;
    }
    // Clear all of a user's warnings; returns how many were removed.
    clearWarnings(guildId, userId) {
        const key = this._warnKey(guildId, userId);
        const n = (this.warnings.get(key) ?? []).length;
        if (this.warnings.delete(key)) this.save();
        return n;
    }
    // Remove a single warning by 1-based index; returns true if one was removed.
    removeWarning(guildId, userId, index) {
        const key = this._warnKey(guildId, userId);
        const list = this.warnings.get(key);
        if (!list || index < 1 || index > list.length) return false;
        list.splice(index - 1, 1);
        if (list.length) this.warnings.set(key, list); else this.warnings.delete(key);
        this.save();
        return true;
    }
    // Total warnings recorded for a guild (used by .stats). Sums the arrays
    // whose key is prefixed with the guild id.
    countWarnings(guildId) {
        let total = 0;
        for (const [key, list] of this.warnings) {
            if (key.startsWith(guildId + ':')) total += list.length;
        }
        return total;
    }
}

module.exports = new Store();   // singleton
