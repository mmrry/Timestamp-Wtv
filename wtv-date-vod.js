// ==UserScript==
// @name         W.tv — точное время VOD
// @namespace    wtv-vod-exact-time
// @version      1.0.0
// @description  Показывает точную дату и время (ДД.ММ.ГГГГ ЧЧ:ММ:СС) начала стрима для VOD на w.tv
// @author       Aaa
// @match        https://w.tv/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      streams-search-service.w.tv
// @connect      profiles-service.w.tv
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ================== НАСТРОЙКИ ==================
    // Какое поле показывать как основное время:
    //   'startedAt'  — начало стрима (рекомендуется)
    //   'finishedAt' — окончание стрима
    const TIME_FIELD = 'startedAt';

    // На странице VOD сайт показывает только дату окончания (ДД.ММ.ГГГГ).
    // true  — заменить её на точное время;
    // false — оставить как есть и добавить точное время отдельной строкой.
    const REPLACE_VOD_PAGE_DATE = true;

    // В блоке «Последняя трансляция» на странице канала есть относительная
    // дата ("2 дня назад"). true — заменить её на точное время.
    const REPLACE_LAST_BROADCAST_DATE = true;
    // ===============================================

    const API = 'https://streams-search-service.w.tv/api/v1';
    const PROFILES_API = 'https://profiles-service.w.tv/api/v1';
    const QS = '?user_lang=ru&platform=web';

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    // Разбирает только same-origin ссылки вида /<nick>/videos/<uuid>
    function parseVideoHref(a) {
        try {
            const u = new URL(a.getAttribute('href') || '', location.origin);
            if (u.origin !== location.origin) return null;
            return u.pathname.match(/^\/([^\/]+)\/videos\/([0-9a-f-]{36})\/?$/i);
        } catch (e) {
            return null;
        }
    }

    // streamId -> { startedAt, finishedAt } (в мс)
    const timesById = new Map();
    let decorateScheduled = false;

    // ---------- Форматирование ----------
    function pad(n) { return String(n).padStart(2, '0'); }

    function fmt(ms) {
        const d = new Date(ms);
        return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() +
            ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function toMs(v) {
        if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
        if (typeof v === 'string') { const t = Date.parse(v); return isNaN(t) ? null : t; }
        return null;
    }

    function getTs(info) {
        if (!info) return null;
        return info[TIME_FIELD] || info.startedAt || info.finishedAt || null;
    }

    function getTooltip(info) {
        const parts = [];
        if (info.startedAt) parts.push('Начало: ' + fmt(info.startedAt));
        if (info.finishedAt) parts.push('Конец: ' + fmt(info.finishedAt));
        return parts.join('\n');
    }

    // ---------- Сбор данных из JSON-ответов API ----------
    // Объект стрима: { streamId: <uuid>, state, startedAt: ISO, finishedAt: ISO, ... }
    function harvest(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(harvest); return; }

        if (typeof obj.streamId === 'string' && UUID_RE.test(obj.streamId) &&
            (obj.startedAt || obj.finishedAt)) {
            const id = obj.streamId.toLowerCase();
            const rec = { startedAt: toMs(obj.startedAt), finishedAt: toMs(obj.finishedAt) };
            const prev = timesById.get(id);
            if (!prev || prev.startedAt !== rec.startedAt || prev.finishedAt !== rec.finishedAt) {
                timesById.set(id, rec);
                scheduleDecorate();
            }
        }
        for (const k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) harvest(obj[k]);
        }
    }

    function isApiUrl(url) {
        return /streams-search-service\.w\.tv|streams-service\.w\.tv/.test(url);
    }

    // ---------- Перехват fetch / XHR в контексте страницы ----------
    // Tampermonkey запускает скрипт в песочнице, поэтому патчим unsafeWindow.
    const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const exp = (fn) => (typeof exportFunction === 'function') ? exportFunction(fn, W) : fn;

    try {
        const origFetch = W.fetch;
        W.fetch = exp(function (...args) {
            const p = origFetch.apply(this, args);
            try {
                const a0 = args[0];
                const url = typeof a0 === 'string' ? a0 : (a0 && a0.url) || String(a0 || '');
                if (isApiUrl(url)) {
                    p.then(resp => {
                        resp.clone().text().then(t => {
                            try { harvest(JSON.parse(t)); } catch (e) { /* not JSON */ }
                        }).catch(() => {});
                    }).catch(() => {});
                }
            } catch (e) { /* ignore */ }
            return p;
        });
    } catch (e) { /* перехват недоступен — останется fallback через GM_xmlhttpRequest */ }

    try {
        const XHR = W.XMLHttpRequest.prototype;
        const origOpen = XHR.open;
        const origSend = XHR.send;
        XHR.open = exp(function (method, url, ...rest) {
            this.__wtvvod_url = String(url);
            return origOpen.call(this, method, url, ...rest);
        });
        XHR.send = exp(function (...args) {
            if (this.__wtvvod_url && isApiUrl(this.__wtvvod_url)) {
                this.addEventListener('load', () => {
                    try { harvest(JSON.parse(this.responseText)); } catch (e) { /* not JSON */ }
                });
            }
            return origSend.apply(this, args);
        });
    } catch (e) { /* ignore */ }

    // ---------- Прямые запросы к API (fallback) ----------
    function deviceHeaders() {
        const h = { 'Accept': 'application/json' };
        try {
            const m = document.cookie.match(/(?:^|;\s*)device-id=([^;]+)/);
            const id = (m && decodeURIComponent(m[1])) || W.localStorage.getItem('device-id');
            if (id) h['x-device-id'] = id.replace(/^"|"$/g, '');
        } catch (e) { /* ignore */ }
        return h;
    }

    function gmGetJson(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: deviceHeaders(),
                onload: (r) => {
                    try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); }
                },
                onerror: reject,
                ontimeout: reject
            });
        });
    }

    // Весь список VOD канала: ник -> userId (он же channelId) -> /channels/<id>/streams
    const requestedChannels = new Set();
    function fetchChannel(nick) {
        const key = nick.toLowerCase();
        if (requestedChannels.has(key)) return;
        requestedChannels.add(key);
        gmGetJson(PROFILES_API + '/profiles/by-nickname/' + encodeURIComponent(key) + QS)
            .then(p => {
                const id = p && p.profile && p.profile.userId;
                if (!id || !UUID_RE.test(id)) throw new Error('bad userId');
                return gmGetJson(API + '/channels/' + encodeURIComponent(id) + '/streams' + QS);
            })
            .then(harvest)
            .catch(() => {});
    }

    // Одиночный VOD: /streams/<streamId> -> { stream: {...} }
    const requestedStreams = new Set();
    function fetchStream(streamId) {
        if (requestedStreams.has(streamId)) return;
        requestedStreams.add(streamId);
        gmGetJson(API + '/streams/' + streamId + QS).then(harvest).catch(() => {});
    }

    // ---------- Стили ----------
    function injectStyles() {
        if (document.getElementById('wtvvod-exact-time-css')) return;
        const st = document.createElement('style');
        st.id = 'wtvvod-exact-time-css';
        st.textContent = `
            .wtvvod-badge {
                position: absolute;
                left: 7px;
                bottom: 7px;
                z-index: 4;
                padding: 2px 6px;
                border-radius: 4px;
                background: rgba(0, 0, 0, 0.78);
                color: #fff;
                font-size: 11px;
                line-height: 1.3;
                font-family: inherit;
                font-variant-numeric: tabular-nums;
                pointer-events: none;
                white-space: nowrap;
            }
            .wtvvod-page-time {
                display: inline-block;
                margin: 6px 0;
                padding: 3px 8px;
                border-radius: 6px;
                background: rgba(125, 125, 125, 0.15);
                font-size: 13px;
                font-weight: 500;
                font-variant-numeric: tabular-nums;
            }
        `;
        (document.head || document.documentElement).appendChild(st);
    }

    // ---------- Карточки VOD ----------
    // <div data-testid="ui-stream-preview-card">
    //   <a data-testid="stream-preview" href="/<channel>/videos/<streamId>"> превью + duration-badge </a>
    //   ...
    // На карточках даты нет вообще — добавляем бейдж в левый нижний угол превью.
    function decoratePreviews() {
        document.querySelectorAll('a[href*="/videos/"]').forEach(a => {
            const hm = parseVideoHref(a);
            if (!hm) return;
            const nick = hm[1];
            const id = hm[2].toLowerCase();

            const info = timesById.get(id);
            const ts = getTs(info);
            if (!ts) { fetchChannel(nick); return; }

            const text = fmt(ts);
            const tip = getTooltip(info);

            let badge = a.querySelector(':scope > .wtvvod-badge');
            if (!badge) {
                if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
                badge = document.createElement('div');
                badge.className = 'wtvvod-badge';
                a.appendChild(badge);
            }
            if (badge.textContent !== text) badge.textContent = text;
            if (badge.title !== tip) badge.title = tip;
        });
    }

    // ---------- Блок «Последняя трансляция» на странице канала ----------
    // <div>
    //   <div class="mb-4 flex gap-3 ..."><h4 class="h4-stable">Последняя трансляция</h4><badge>2 дня назад</badge></div>
    //   <карточка с a[href="/<channel>/videos/<id>"]>
    // </div>
    function decorateLastBroadcast() {
        if (!REPLACE_LAST_BROADCAST_DATE) return;
        document.querySelectorAll('h4.h4-stable').forEach(h4 => {
            const header = h4.parentElement;
            const rel = h4.nextElementSibling;
            const root = header && header.parentElement;
            if (!rel || !root) return;
            const a = root.querySelector('a[href*="/videos/"]');
            const hm = a && parseVideoHref(a);
            if (!hm) return;
            const info = timesById.get(hm[2].toLowerCase());
            const ts = getTs(info);
            if (!ts) return;
            const text = fmt(ts);
            if (rel.textContent !== text) rel.textContent = text;
            rel.title = getTooltip(info);
        });
    }

    // ---------- Страница VOD: /<channel>/videos/<streamId> ----------
    // Сайт выводит дату окончания (ДД.ММ.ГГГГ) в
    // [data-testid="stream-info-desktop-engagement-secondary"] / "...-mobile-engagement-secondary"
    function decorateVodPage() {
        const pm = location.pathname.match(/^\/([^\/]+)\/videos\/([0-9a-f-]{36})/i);
        if (!pm) return;
        const id = pm[2].toLowerCase();
        const info = timesById.get(id);
        const ts = getTs(info);
        if (!ts) { fetchStream(id); return; }

        const text = fmt(ts);
        const tip = getTooltip(info);

        if (REPLACE_VOD_PAGE_DATE) {
            const els = document.querySelectorAll('[data-testid$="engagement-secondary"]');
            if (els.length) {
                els.forEach(el => {
                    if (el.textContent !== text) el.textContent = text;
                    if (el.title !== tip) el.title = tip;
                });
                return;
            }
        }

        // Fallback / режим "добавить строку": после заголовка стрима
        const label = (TIME_FIELD === 'finishedAt' ? 'Конец стрима: ' : 'Начало стрима: ') + text;
        let ex = document.querySelector('.wtvvod-page-time');
        if (ex) {
            if (ex.textContent !== label) ex.textContent = label;
            return;
        }
        const anchor = document.querySelector(
            '[data-testid="stream-info-desktop-engagement"], [data-testid="stream-info-mobile-engagement"], ' +
            '[data-testid="stream-info-mobile-title"]'
        );
        if (!anchor) return;
        ex = document.createElement('div');
        ex.className = 'wtvvod-page-time';
        ex.textContent = label;
        ex.title = tip;
        anchor.insertAdjacentElement('afterend', ex);
    }

    // ---------- Планировщик и наблюдение за DOM (SPA на Nuxt) ----------
    function decorateAll() {
        injectStyles();
        decoratePreviews();
        decorateLastBroadcast();
        decorateVodPage();
    }

    function scheduleDecorate() {
        if (decorateScheduled) return;
        decorateScheduled = true;
        setTimeout(() => {
            decorateScheduled = false;
            try { decorateAll(); } catch (e) { /* ignore */ }
        }, 200);
    }

    function start() {
        const mo = new MutationObserver(scheduleDecorate);
        mo.observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener('popstate', scheduleDecorate);
        // Подстраховка для SPA-переходов (pushState из песочницы не перехватить надёжно)
        setInterval(scheduleDecorate, 3000);
        scheduleDecorate();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
