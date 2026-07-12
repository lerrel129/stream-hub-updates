const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const BASE_URL = "https://www.sledujteto.cz";
const API_URL = `${BASE_URL}/api/web`;
const PROXY_PORT = 7516;
const ADDON_PORT = 7515;
const TMDB_API_KEY = "6886604aa36c09e80400a8732d061684";
// Portable build passes STREAMHUB_CONFIG_DIR (the folder next to the exe),
// so logins survive even though the app code is unpacked into a temp dir.
const CONFIG_PATH = path.join(process.env.STREAMHUB_CONFIG_DIR || __dirname, "config.json");

// ============ OTA UPDATE ============
// Version of this code. INCREASE this number for every new release
// (and put the same number into "version" in update.json on GitHub).
const APP_VERSION = 11;
// Raw link to update.json in the GitHub repo (lerrel129/stream-hub-updates).
const UPDATE_MANIFEST_URL =
    "https://raw.githubusercontent.com/lerrel129/stream-hub-updates/main/update.json";
// Exit code used when the process terminates after downloading an update -
// the wrapper (desktop/android) restarts the app based on it.
const UPDATE_EXIT_CODE = 87;
// Version of the native wrapper (APK versionCode). The Android wrapper
// passes it as process.argv[2]. On PC it stays 0 (APK update is PC-irrelevant).
const NATIVE_VERSION = parseInt(process.argv[2]) || 0;
// Version NAME shown to the user (e.g. "1.3"). The wrapper passes it as
// process.argv[3] - Android: versionName, PC: the desktop app version.
const NATIVE_VERSION_NAME = process.argv[3] || "";

// ============ CONFIG ============

// Passwords in config.json are stored obfuscated (prefix "enc1:", XOR + base64).
// This is not real encryption - it only prevents casual plaintext reading.
const SECRET_KEY = "StreamHub-cfg-v1";
const ENC_PREFIX = "enc1:";
const PASSWORD_KEYS = ["stPassword", "fsPassword", "wsPassword", "ptPassword"];

function xorBytes(buf) {
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length);
    return out;
}

function encSecret(plain) {
    if (!plain) return plain;
    return ENC_PREFIX + xorBytes(Buffer.from(plain, "utf8")).toString("base64");
}

function decSecret(stored) {
    if (!stored || !stored.startsWith(ENC_PREFIX)) return stored; // plaintext from older versions
    try { return xorBytes(Buffer.from(stored.slice(ENC_PREFIX.length), "base64")).toString("utf8"); }
    catch (e) { return ""; }
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
            for (const k of PASSWORD_KEYS) if (cfg[k]) cfg[k] = decSecret(cfg[k]);
            return cfg;
        }
    } catch (e) { console.error("[CONFIG] Load error:", e.message); }
    return {};
}

function saveConfig(cfg) {
    try {
        const out = { ...cfg };
        for (const k of PASSWORD_KEYS) if (out[k]) out[k] = encSecret(out[k]);
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2), "utf8");
    } catch (e) { console.error("[CONFIG] Save error:", e.message); }
}

let config = loadConfig();

// ============ CAPPED CACHES ============

// LRU cache behind a Proxy so existing `cache[key]` syntax keeps working.
// Prevents unbounded memory growth (important on Android where the
// foreground service runs for days).
function lruCache(maxEntries) {
    const map = new Map();
    return new Proxy({}, {
        get(_, key) {
            if (typeof key !== "string") return undefined;
            if (!map.has(key)) return undefined;
            const val = map.get(key);
            map.delete(key); map.set(key, val); // refresh recency
            return val;
        },
        set(_, key, val) {
            if (map.has(key)) map.delete(key);
            map.set(key, val);
            if (map.size > maxEntries) map.delete(map.keys().next().value);
            return true;
        },
        has(_, key) { return map.has(key); },
        deleteProperty(_, key) { map.delete(key); return true; },
        ownKeys() { return [...map.keys()]; },
        getOwnPropertyDescriptor(_, key) {
            if (!map.has(key)) return undefined;
            return { value: map.get(key), enumerable: true, configurable: true, writable: true };
        },
    });
}

// ============ SLEDUJTETO ============

const urlCache = lruCache(2000);
const metaCache = lruCache(2000);
const fileDataCache = lruCache(2000);
const streamCache = lruCache(500);
let sessionCookie = "";
let loggedIn = false;
let stPremium = false;
let serverRunning = true;

function mergeCookies(existing, newCookies) {
    const map = {};
    existing.split("; ").forEach(c => { const i = c.indexOf("="); if (i > 0) map[c.substring(0, i)] = c.substring(i + 1); });
    newCookies.forEach(c => { const i = c.indexOf("="); if (i > 0) map[c.substring(0, i)] = c.substring(i + 1); });
    Object.keys(map).forEach(k => { if (map[k] === "deleted" || map[k] === "") delete map[k]; });
    return Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ");
}

function api(url, opts = {}) {
    return axios({
        url, timeout: 15000,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
            "X-Requested-With": "XMLHttpRequest", "Accept": "application/json", "Referer": BASE_URL,
            ...(sessionCookie ? { Cookie: sessionCookie } : {}), ...(opts.headers || {}),
        },
        maxRedirects: opts.followRedirects === false ? 0 : 5,
        validateStatus: () => true, ...opts,
    });
}

function detectPremium(html) {
    const idx = html.indexOf("Premium:");
    if (idx >= 0) {
        const after = html.substring(idx, Math.min(idx + 200, html.length)).toLowerCase();
        if (after.includes("aktivn")) {
            console.log("[PREMIUM] SledujTeTo: ✓ aktivní");
            return true;
        }
    }
    // fallback
    const lower = html.toLowerCase();
    if (lower.includes("premium") && lower.includes("aktivn")) {
        console.log("[PREMIUM] SledujTeTo: ✓ (fallback)");
        return true;
    }
    console.log("[PREMIUM] SledujTeTo: ✗");
    return false;
}

async function login(email, password) {
    try {
        const page = await axios.get(`${BASE_URL}/account/login/`, {
            headers: { "User-Agent": "Mozilla/5.0" }, maxRedirects: 5,
        });
        sessionCookie = (page.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");

        const params = new URLSearchParams();
        params.append("email", email); params.append("password", password);
        params.append("remember", "1"); params.append("last_uri", "");
        params.append("form_id", "Form_Login"); params.append("model_id", "0");
        params.append("login", "Přihlásit");

        const resp = await axios.post(`${BASE_URL}/account/login/`, params.toString(), {
            headers: {
                "User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded",
                "Referer": `${BASE_URL}/account/login/`, "Origin": BASE_URL, Cookie: sessionCookie,
            },
            maxRedirects: 0, validateStatus: () => true,
        });

        const newCookies = (resp.headers["set-cookie"] || []).map(c => c.split(";")[0]);
        if (newCookies.length) sessionCookie = mergeCookies(sessionCookie, newCookies);
        console.log("[LOGIN] After POST cookies:", sessionCookie.substring(0, 120));

        const code = resp.status;
        const location = resp.headers.location || "";
        if (code >= 301 && code <= 303 && location && !location.includes("/account/login")) {
            loggedIn = true;
            const followUrl = location.startsWith("http") ? location : `${BASE_URL}${location}`;
            const follow = await axios.get(followUrl, {
                headers: { "User-Agent": "Mozilla/5.0", Cookie: sessionCookie }, validateStatus: () => true,
            });
            const moreCookies = (follow.headers["set-cookie"] || []).map(c => c.split(";")[0]);
            if (moreCookies.length) sessionCookie = mergeCookies(sessionCookie, moreCookies);
            console.log("[LOGIN] After redirect cookies:", sessionCookie.substring(0, 120));

            // Detect premium from redirect page
            const body = typeof follow.data === "string" ? follow.data : "";
            stPremium = detectPremium(body);

            console.log(`[LOGIN] SledujTeTo OK as ${email}, premium=${stPremium}`);
            return true;
        }
        console.log(`[LOGIN] SledujTeTo Failed - code=${code}`);
        return false;
    } catch (e) {
        console.error("[LOGIN] SledujTeTo Error:", e.message);
        return false;
    }
}

async function checkPremiumStatus() {
    try {
        console.log("[PREMIUM] Checking... cookies:", sessionCookie.substring(0, 80));
        const resp = await axios.get(`${BASE_URL}/account/dashboard/?page=1`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "text/html",
                "Referer": BASE_URL,
                Cookie: sessionCookie,
            },
            maxRedirects: 5, validateStatus: () => true, timeout: 15000,
        });
        const html = typeof resp.data === "string" ? resp.data : "";
        console.log("[PREMIUM] Dashboard: status=%d len=%d hasPremiumKey=%s", resp.status, html.length, html.includes("Premium:"));

        // Only update premium if page actually contains dashboard content
        if (html.includes("Premium:") || html.includes("dashboard")) {
            stPremium = detectPremium(html);
        } else {
            console.log("[PREMIUM] Dashboard page not recognized, keeping stPremium=" + stPremium);
        }
    } catch (e) {
        console.error("[PREMIUM] Check error (keeping stPremium=" + stPremium + "):", e.message);
    }
}

let lastPremiumCheck = 0;
async function refreshPremium() {
    const now = Date.now();
    if (now - lastPremiumCheck < 5 * 60 * 1000) return;
    lastPremiumCheck = now;
    await checkPremiumStatus();
}

async function fetchVideos(query, page = 1) {
    try {
        let url = `${API_URL}/videos?page=${page}`;
        if (query) url += `&query=${encodeURIComponent(query)}`;
        const resp = await api(url);
        const data = resp.data?.data || resp.data;
        const files = data?.files || [];
        return files.map(f => {
            const id = String(f.id);
            if (f.full_url) urlCache[id] = f.full_url;
            fileDataCache[id] = f;
            const info = parseVideoInfo(f.name);
            const meta = {
                id: `sleduj:${id}`, type: "movie",
                name: `${info.flag ? info.flag + " " : ""}${f.name || "Unknown"}`,
                poster: f.preview || "", background: f.preview || "",
                description: [info.lang, f.resolution ? `[${f.resolution}]` : "", info.quality, f.duration, f.filesize, f.description].filter(Boolean).join(" | "),
                runtime: f.duration || "",
            };
            metaCache[id] = meta;
            return meta;
        });
    } catch (e) { console.error("[CATALOG] Error:", e.message); return []; }
}

async function getStreamInfo(videoId, retried = false) {
    if (streamCache[videoId] && Date.now() - streamCache[videoId].ts < 300000) return streamCache[videoId];
    try {
        const filePageUrl = urlCache[videoId] || `${BASE_URL}/file/${videoId}/`;
        const pageResp = await api(filePageUrl, { headers: { Accept: "text/html", Referer: BASE_URL } });
        const html = typeof pageResp.data === "string" ? pageResp.data : "";
        const initMatch = html.match(/init\(\s*(\d+)\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/);
        if (!initMatch) {
            // Session may have expired - re-login once from saved credentials and retry
            if (!retried && config.stEmail && config.stPassword) {
                console.log("[STREAM] ST init not found, re-login + retry...");
                if (await login(config.stEmail, config.stPassword)) return getStreamInfo(videoId, true);
            }
            return null;
        }
        const [, fileId, playerBase, , mirror] = initMatch;
        const linkResp = await api(`${mirror}/services/add-file-link`, {
            method: "POST", data: { params: { id: parseInt(fileId) } },
            headers: { "Content-Type": "application/json", Origin: BASE_URL, Referer: filePageUrl },
        });
        if (!linkResp.data.hash) return null;
        const newCookies = (linkResp.headers["set-cookie"] || []).map(c => c.split(";")[0]);
        if (newCookies.length) {
            const cookieMap = {};
            sessionCookie.split("; ").forEach(c => { const i = c.indexOf("="); if (i > 0) cookieMap[c.substring(0, i)] = c.substring(i + 1); });
            newCookies.forEach(c => { const i = c.indexOf("="); if (i > 0) cookieMap[c.substring(0, i)] = c.substring(i + 1); });
            Object.keys(cookieMap).forEach(k => { if (cookieMap[k] === "deleted") delete cookieMap[k]; });
            sessionCookie = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join("; ");
        }
        const info = { videoUrl: playerBase + linkResp.data.hash, mirror, fileId, hash: linkResp.data.hash, ts: Date.now() };
        streamCache[videoId] = info;
        return info;
    } catch (e) { console.error("[STREAM] Error:", e.message); return null; }
}

function parseVideoInfo(name) {
    const n = name || ""; const upper = n.toUpperCase();
    let flag = "", lang = "", quality = "";
    if (/SK\s*dabing/i.test(n)) { flag = "🇸🇰"; lang = "SK dabing"; }
    else if (/CZ\s*dabing/i.test(n)) { flag = "🇨🇿"; lang = "CZ dabing"; }
    else if (/SK\s*tit/i.test(n)) { flag = "🇸🇰"; lang = "SK titulky"; }
    else if (/CZ\s*tit/i.test(n)) { flag = "🇨🇿"; lang = "CZ titulky"; }
    else if (/SK\s*film/i.test(n)) { flag = "🇸🇰"; lang = "SK"; }
    else if (/CZ\s*(film|komedie|drama)/i.test(n)) { flag = "🇨🇿"; lang = "CZ"; }
    if (upper.includes("4K") || upper.includes("2160")) quality = "4K";
    else if (upper.includes("1080") || upper.includes("FULLHD")) quality = "1080p";
    else if (upper.includes("HD")) quality = "HD";
    else if (upper.includes("720")) quality = "720p";
    return { flag, lang, quality };
}

function stFormatName(videoName, fd, imdbId) {
    const info = parseVideoInfo(videoName);
    const flags = new Set();
    if (info.flag === "🇸🇰") flags.add("🇸🇰");
    if (info.flag === "🇨🇿") flags.add("🇨🇿");
    // Title-based detection from TMDB
    if (imdbId) {
        const cached = tmdbCache[imdbId];
        if (cached) {
            const lower = (videoName || "").toLowerCase();
            const norm = stripDiacritics(lower);
            const czNorm = cached.czTitle ? stripDiacritics(cached.czTitle.toLowerCase()) : "";
            const skNorm = cached.skTitle ? stripDiacritics(cached.skTitle.toLowerCase()) : "";
            const sameTitles = czNorm && skNorm && czNorm === skNorm;
            if (skNorm && !sameTitles && (lower.includes(cached.skTitle.toLowerCase()) || norm.includes(skNorm))) flags.add("🇸🇰");
            if (czNorm && (lower.includes(cached.czTitle.toLowerCase()) || norm.includes(czNorm))) flags.add("🇨🇿");
        }
    }
    const parts = [...flags];
    if (fd?.resolution) {
        const w = parseInt(fd.resolution);
        if (w >= 3840) parts.push("4K"); else if (w >= 2560) parts.push("2K");
        else if (w >= 1280) parts.push("HD"); else parts.push("SD");
    }
    return parts.join("\n");
}

function stFormatDesc(videoName, fd) {
    const parts = [videoName || ""];
    if (fd?.duration) parts.push("⏱ " + fd.duration);
    if (fd?.filesize) parts.push("💾 " + fd.filesize);
    return parts.join("\n");
}

// ============ AUDIO DETECTION (shared) ============

// Word-boundary based SK/CZ detection - a plain substring test flagged
// e.g. "maska"/"whiskey" as SK and any "cs" inside a word as CZ.
const SK_AUDIO_RE = /(^|[^a-z0-9])(sk|svk|slovak|slovensk\w*)($|[^a-z0-9])/;
const CZ_AUDIO_RE = /(^|[^a-z0-9])(cz|cze|cs|czech|cesk\w*)($|[^a-z0-9])/;
const DABING_RE = /(^|[^a-z0-9])dabing($|[^a-z0-9])/;

function detectAudio(name) {
    const n = stripDiacritics((name || "").toLowerCase());
    const tags = [];
    if (SK_AUDIO_RE.test(n)) tags.push("SK");
    if (CZ_AUDIO_RE.test(n)) tags.push("CZ");
    // bare "dabing" without an explicit language marker usually means CZ
    else if (!tags.length && DABING_RE.test(n)) tags.push("CZ");
    return tags.join(" ");
}

// ============ FASTSHARE ============

let fsCookie = "";
let fsLoggedIn = false;
let fsUnlimited = false;
let fsUser = "";
const fsFileCache = lruCache(1000);

async function fsLogin(username, password) {
    try {
        const url = `https://fastshare.cz/api/api_kodi.php?process=login&login=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
        const resp = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        const hash = resp.data?.user?.hash;
        if (hash) {
            fsCookie = `FASTSHARE=${hash}`;
            fsLoggedIn = true;
            fsUnlimited = resp.data.user.unlimited === true;
            fsUser = username;
            console.log(`[LOGIN] Fastshare OK as ${username}, unlimited=${fsUnlimited}`);
            return true;
        }
        console.log("[LOGIN] Fastshare failed - no hash");
    } catch (e) { console.error("[LOGIN] Fastshare Error:", e.message); }
    return false;
}

function makeFsTerm(query) {
    const cleaned = query.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
    return Buffer.from(cleaned).toString("base64").replace(/=+$/, "");
}

async function fsSearch(query) {
    if (!query) return [];
    try {
        const searchUrl = `https://fastshare.cloud/${query.replace(/ /g, "-")}/s`;
        const searchResp = await axios.get(searchUrl, {
            headers: { "User-Agent": "Mozilla/5.0", ...(fsCookie ? { Cookie: fsCookie } : {}) },
        });
        const searchHtml = typeof searchResp.data === "string" ? searchResp.data : "";
        const tokenMatch = searchHtml.match(/id="search_token"\s*value="([^"]+)"/);
        if (!tokenMatch) return [];
        const token = tokenMatch[1];
        const term = makeFsTerm(query);
        let limit = 1;
        const allItems = [];
        const MAX_FS_PAGES = 10; // safety cap - the loop used to be unbounded
        for (let pageNo = 0; pageNo < MAX_FS_PAGES; pageNo++) {
            const pageUrl = `https://fastshare.cloud/test2.php?token=${token}&search_purpose=0&search_resolution=0&order=&type=video&term=${term}&plain_search=0&limit=${limit}&step=3`;
            const resp = await axios.get(pageUrl, {
                headers: { "User-Agent": "Mozilla/5.0", ...(fsCookie ? { Cookie: fsCookie } : {}) },
            });
            const html = typeof resp.data === "string" ? resp.data : "";
            const lis = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(m => m[1]);
            if (!lis.length) break;
            allItems.push(...lis);
            limit += 9;
        }
        if (!allItems.length || allItems[0].includes("nebylo nic nalezeno")) return [];

        const files = [];
        for (const li of allItems) {
            const nameM = li.match(/<div[^>]*class="video_detail"[^>]*>.*?<p[^>]*>\s*<a[^>]*>(.*?)<\/a>/si);
            const fileName = nameM ? nameM[1].trim() : "(NO NAME)";
            const dlM = li.match(/<a[^>]*href=["']([^"']+)["'][^>]*title=["']Rychl[^"']*stažen[^"']*["']/i);
            if (!dlM) continue;
            const dlHref = dlM[1].trim();
            const detailMatches = [...li.matchAll(/<span[^>]*class="[^"]*\bvideo_time\b[^"]*"[^>]*>(.*?)<\/span>/gsi)].map(m => m[1]);
            const durM = detailMatches[0]?.match(/(\d{1,2}:\d{2}:\d{2})/);
            const duration = durM ? durM[1] : "";
            const resolution = detailMatches[1]?.trim().split(";").pop()?.trim() || "";
            const size = (detailMatches[3] || detailMatches[2] || "").trim();
            const audio = detectAudio(fileName);
            const idM = dlHref.match(/[?&]id=(\d+)/);
            const fsId = idM ? idM[1] : String(dlHref.hashCode || Math.random());
            const file = { name: fileName, size, duration, resolution, downloadUrl: dlHref, audioTracks: audio, fsId };
            fsFileCache[fsId] = file;
            files.push(file);
        }
        console.log(`[FASTSHARE] Search '${query}': ${files.length} results`);
        return files;
    } catch (e) { console.error("[FASTSHARE] Search error:", e.message); return []; }
}

function fsFormatName(file) {
    const parts = [];
    const audio = (file.audioTracks || "").toUpperCase();
    if (audio.includes("SK")) parts.push("🇸🇰");
    if (audio.includes("CZ")) parts.push("🇨🇿");
    if (file.resolution) {
        const hM = file.resolution.match(/x(\d+)/i);
        const h = hM ? parseInt(hM[1]) : 0;
        if (h >= 2160) parts.push("4K"); else if (h >= 1440) parts.push("2K");
        else if (h >= 720) parts.push("HD"); else if (h > 0) parts.push("SD");
    }
    return parts.join("\n");
}

function fsFormatDesc(file) {
    const parts = [file.name];
    if (file.duration) parts.push("⏱ " + file.duration);
    if (file.size) parts.push("💾 " + file.size);
    return parts.join("\n");
}

// ============ HELLSPY ============

const hsFileCache = lruCache(1000);

async function hsSearch(query) {
    if (!query) return [];
    try {
        const url = `https://api.hellspy.to/gw/search?query=${encodeURIComponent(query)}&offset=0&limit=99`;
        const resp = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        const items = resp.data?.items || [];
        const files = [];
        for (const v of items) {
            const objType = (v.objectType || "").toLowerCase();
            const prefix = objType.substring(0, 2);
            const suffix = objType.length >= 5 ? objType.substring(objType.length - 5) : objType;
            const sizeGB = v.size > 0 ? `${(v.size / (1024 ** 3)).toFixed(2)} GB` : "";
            const dur = v.duration > 0 ? `${Math.floor(v.duration / 3600)}h ${Math.floor((v.duration % 3600) / 60)}m` : "";
            const file = {
                name: v.title, size: sizeGB, duration: dur,
                thumbnail: v.thumbs?.[0] || "",
                downloadUrl: `https://api.hellspy.to/${prefix}/${suffix}/${v.id}/${v.fileHash}/download`,
                audioTracks: detectAudio(v.title), hsId: String(v.id),
            };
            hsFileCache[file.hsId] = file;
            files.push(file);
        }
        console.log(`[HELLSPY] Search '${query}': ${files.length} results`);
        return files;
    } catch (e) { console.error("[HELLSPY] Search error:", e.message); return []; }
}

function hsFormatName(file) {
    const parts = [];
    const audio = (file.audioTracks || "").toUpperCase();
    if (audio.includes("SK")) parts.push("🇸🇰");
    if (audio.includes("CZ")) parts.push("🇨🇿");
    return parts.join("\n");
}

function hsFormatDesc(file) {
    const parts = [file.name];
    if (file.duration) parts.push("⏱ " + file.duration);
    if (file.size) parts.push("💾 " + file.size);
    return parts.join("\n");
}

// ============ TMDB (shared) ============

const tmdbCache = lruCache(500);
async function tmdbGetNames(imdbId) {
    if (tmdbCache[imdbId]) return tmdbCache[imdbId];
    const names = []; let year = ""; let czTitle = ""; let skTitle = "";
    try {
        const czResp = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
            params: { api_key: TMDB_API_KEY, external_source: "imdb_id", language: "cs-CZ" }, timeout: 8000,
        });
        const czMovie = czResp.data?.movie_results?.[0];
        if (czMovie) {
            year = czMovie.release_date?.substring(0, 4) || "";
            czTitle = czMovie.title || "";
            if (czMovie.title) names.push(czMovie.title);
            if (czMovie.original_title && !names.includes(czMovie.original_title)) names.push(czMovie.original_title);
            const skResp = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
                params: { api_key: TMDB_API_KEY, external_source: "imdb_id", language: "sk-SK" }, timeout: 8000,
            });
            skTitle = skResp.data?.movie_results?.[0]?.title || "";
            if (skTitle && !names.includes(skTitle)) names.push(skTitle);
        } else {
            const tv = czResp.data?.tv_results?.[0];
            if (tv) {
                year = tv.first_air_date?.substring(0, 4) || "";
                czTitle = tv.name || "";
                if (tv.name) names.push(tv.name);
                if (tv.original_name && !names.includes(tv.original_name)) names.push(tv.original_name);
                const skResp = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
                    params: { api_key: TMDB_API_KEY, external_source: "imdb_id", language: "sk-SK" }, timeout: 8000,
                });
                skTitle = skResp.data?.tv_results?.[0]?.name || "";
                if (skTitle && !names.includes(skTitle)) names.push(skTitle);
            }
        }
    } catch (e) {
        // Network/API failure - do NOT cache, otherwise the title would
        // return no streams until restart. Next request retries TMDB.
        console.error("[TMDB] Error:", e.message);
        return { names, year, czTitle, skTitle };
    }
    const result = { names, year, czTitle, skTitle };
    tmdbCache[imdbId] = result;
    return result;
}

async function buildImdbQueries(imdbId, season, episode) {
    const { names, year } = await tmdbGetNames(imdbId);
    if (!names.length) return { queries: [], epTag: "" };
    const epTag = (season && episode) ? `S${String(season).padStart(2,"0")}E${String(episode).padStart(2,"0")}` : "";
    const queries = [];
    for (const n of names) {
        if (epTag) queries.push(`${n} ${epTag}`);
        queries.push(year ? `${n} ${year}` : n);
    }
    console.log(`[TMDB] Queries for ${imdbId}${epTag ? " " + epTag : ""}:`, queries);
    return { queries, epTag, season, episode };
}

function stripDiacritics(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function enhanceAudioByTitle(files, nameField, imdbId) {
    const cached = tmdbCache[imdbId];
    if (!cached || (!cached.czTitle && !cached.skTitle)) return;
    const czNorm = cached.czTitle ? stripDiacritics(cached.czTitle.toLowerCase()) : "";
    const skNorm = cached.skTitle ? stripDiacritics(cached.skTitle.toLowerCase()) : "";
    const czExact = cached.czTitle ? cached.czTitle.toLowerCase() : "";
    const skExact = cached.skTitle ? cached.skTitle.toLowerCase() : "";
    // skip if CZ and SK titles are identical after normalization
    const sameTitles = czNorm && skNorm && czNorm === skNorm;
    for (const f of files) {
        const fnLower = (f[nameField] || "").toLowerCase();
        const fnNorm = stripDiacritics(fnLower);
        let audio = f.audioTracks || "";
        if (skNorm && !sameTitles) {
            // SK: match exact diacritics first, then normalized
            if ((fnLower.includes(skExact) || fnNorm.includes(skNorm)) && !audio.includes("SK")) {
                audio = audio ? audio + " SK" : "SK";
            }
        }
        if (czNorm) {
            if ((fnLower.includes(czExact) || fnNorm.includes(czNorm)) && !audio.includes("CZ")) {
                audio = audio ? audio + " CZ" : "CZ";
            }
        }
        f.audioTracks = audio.trim();
    }
}

function makeEpFilter(epTag, season, episode) {
    if (!epTag) return null;
    const ss = String(season).padStart(2, "0"), ee = String(episode).padStart(2, "0");
    const variants = [
        epTag.toLowerCase(),      // s01e02
        `${season}x${ee}`,        // 1x02
        `${ss}x${ee}`,            // 01x02
        `s${ss} e${ee}`,          // s01 e02
        `s${season}e${episode}`,  // s1e2
    ];
    return (name) => {
        const lower = name.toLowerCase();
        return variants.some(v => lower.includes(v));
    };
}

async function searchStForImdb(imdbId, season, episode) {
    const { queries, epTag } = await buildImdbQueries(imdbId, season, episode);
    if (!queries.length) return [];
    const seen = new Set(), all = [];
    const perQuery = await Promise.all(queries.map(q => fetchVideos(q)));
    for (const r of perQuery) {
        for (const item of r) { if (!seen.has(item.id)) { seen.add(item.id); all.push(item); } }
    }
    const matchesEp = makeEpFilter(epTag, season, episode);
    return matchesEp ? all.filter(i => matchesEp(i.name || i.title || "")) : all;
}

async function searchFsForImdb(imdbId, season, episode) {
    if (!fsLoggedIn) return [];
    const { queries, epTag } = await buildImdbQueries(imdbId, season, episode);
    if (!queries.length) return [];
    const seen = new Set(), all = [];
    const perQuery = await Promise.all(queries.map(q => fsSearch(q)));
    for (const r of perQuery) {
        for (const f of r) { if (!seen.has(f.fsId)) { seen.add(f.fsId); all.push(f); } }
    }
    const matchesEp = makeEpFilter(epTag, season, episode);
    return matchesEp ? all.filter(f => matchesEp(f.name)) : all;
}

async function searchHsForImdb(imdbId, season, episode) {
    const { queries, epTag } = await buildImdbQueries(imdbId, season, episode);
    if (!queries.length) return [];
    const seen = new Set(), all = [];
    const perQuery = await Promise.all(queries.map(q => hsSearch(q)));
    for (const r of perQuery) {
        for (const f of r) { if (!seen.has(f.hsId)) { seen.add(f.hsId); all.push(f); } }
    }
    const matchesEp = makeEpFilter(epTag, season, episode);
    return matchesEp ? all.filter(f => matchesEp(f.name)) : all;
}

async function searchWsForImdb(imdbId, season, episode) {
    if (!wsLoggedIn) return [];
    const { queries, epTag } = await buildImdbQueries(imdbId, season, episode);
    if (!queries.length) return [];
    const seen = new Set(), all = [];
    const perQuery = await Promise.all(queries.map(q => wsSearch(q)));
    for (const r of perQuery) {
        for (const f of r) { if (!seen.has(f.wsId)) { seen.add(f.wsId); all.push(f); } }
    }
    const matchesEp = makeEpFilter(epTag, season, episode);
    return matchesEp ? all.filter(f => matchesEp(f.name)) : all;
}

// ============ WEBSHARE ============

const md5crypt = require("apache-md5");
const crypto = require("crypto");

let wsToken = "";
let wsLoggedIn = false;
let wsVip = false;
let wsUser = "";
const wsFileCache = lruCache(1000);

async function wsLogin(username, password) {
    try {
        // 1. Get salt
        const saltResp = await axios.post("https://webshare.cz/api/salt/", `username_or_email=${encodeURIComponent(username)}`, {
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, timeout: 10000,
        });
        const saltMatch = saltResp.data.match(/<salt>([^<]*)<\/salt>/);
        const salt = saltMatch?.[1];
        if (!salt) { console.log("[LOGIN] Webshare: no salt returned"); return false; }

        // 2. Hash password: SHA1(md5_crypt(password, salt))
        const crypted = md5crypt(password, `$1$${salt}$`);
        const hashedPassword = crypto.createHash("sha1").update(crypted).digest("hex");

        // 3. Compute digest: MD5(username:Webshare:hashedPassword)
        const digest = crypto.createHash("md5").update(`${username}:Webshare:${hashedPassword}`).digest("hex");

        // 4. Login
        const loginResp = await axios.post("https://webshare.cz/api/login/",
            `username_or_email=${encodeURIComponent(username)}&password=${hashedPassword}&digest=${digest}&keep_logged_in=1`, {
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, timeout: 10000,
        });
        const tokenMatch = loginResp.data.match(/<token>([^<]*)<\/token>/);
        const token = tokenMatch?.[1];
        if (token) {
            wsToken = token;
            wsLoggedIn = true;
            wsUser = username;
            // Check VIP status
            await wsCheckVip();
            console.log(`[LOGIN] Webshare OK as ${username}, vip=${wsVip}`);
            return true;
        }
        console.log("[LOGIN] Webshare: no token returned");
    } catch (e) { console.error("[LOGIN] Webshare error:", e.message); }
    return false;
}

async function wsCheckVip() {
    try {
        const resp = await axios.post("https://webshare.cz/api/user_data/", `wst=${wsToken}`, {
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, timeout: 10000,
        });
        const vipMatch = resp.data.match(/<vip>([^<]*)<\/vip>/);
        wsVip = vipMatch?.[1] === "1";
    } catch (e) { console.error("[WS] VIP check error:", e.message); }
}

async function wsSearch(query, retried = false) {
    if (!query || !wsLoggedIn) return [];
    try {
        const resp = await axios.post("https://webshare.cz/api/search/",
            `what=${encodeURIComponent(query)}&category=video&sort=&limit=25&offset=0&wst=${wsToken}`, {
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, timeout: 15000,
        });
        // Expired token - re-login once from saved credentials and retry
        if (/<status>FATAL<\/status>/.test(resp.data) && !retried && config.wsUsername && config.wsPassword) {
            console.log("[WEBSHARE] Token expired, re-login + retry...");
            if (await wsLogin(config.wsUsername, config.wsPassword)) return wsSearch(query, true);
            return [];
        }
        const files = [];
        const fileRegex = /<file>([\s\S]*?)<\/file>/g;
        let m;
        while ((m = fileRegex.exec(resp.data)) !== null) {
            const xml = m[1];
            const get = (tag) => { const r = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)); return r?.[1] || ""; };
            const ident = get("ident");
            const name = get("name");
            const size = parseInt(get("size")) || 0;
            const sizeStr = size > 0 ? `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB` : "";
            const positiveVotes = parseInt(get("positive_votes")) || 0;
            const negativeVotes = parseInt(get("negative_votes")) || 0;

            const file = { wsId: ident, name, size: sizeStr, audioTracks: detectAudio(name), positiveVotes, negativeVotes };
            wsFileCache[ident] = file;
            files.push(file);
        }
        if (files.length) console.log(`[WEBSHARE] Search '${query}': ${files.length} results`);
        return files;
    } catch (e) { console.error("[WEBSHARE] Search error:", e.message); return []; }
}

async function wsGetLink(ident, retried = false) {
    try {
        const resp = await axios.post("https://webshare.cz/api/file_link/",
            `ident=${encodeURIComponent(ident)}&download_type=video_stream&force_https=1&wst=${wsToken}`, {
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, timeout: 10000,
        });
        const linkMatch = resp.data.match(/<link>([^<]*)<\/link>/);
        if (linkMatch?.[1]) return linkMatch[1];
        // Expired token - re-login once from saved credentials and retry
        if (!retried && config.wsUsername && config.wsPassword) {
            console.log("[WEBSHARE] file_link failed, re-login + retry...");
            if (await wsLogin(config.wsUsername, config.wsPassword)) return wsGetLink(ident, true);
        }
        return null;
    } catch (e) { console.error("[WEBSHARE] Link error:", e.message); return null; }
}

function wsFormatName(f) {
    const parts = [];
    const audio = (f.audioTracks || "").toUpperCase();
    if (audio.includes("SK")) parts.push("\uD83C\uDDF8\uD83C\uDDF0");
    if (audio.includes("CZ")) parts.push("\uD83C\uDDE8\uD83C\uDDFF");
    return parts.join("");
}

function wsFormatDesc(f) {
    const parts = [f.name];
    if (f.size) parts.push("\uD83D\uDCBE " + f.size);
    if (f.positiveVotes > 0 || f.negativeVotes > 0) parts.push(`\uD83D\uDC4D ${f.positiveVotes} \uD83D\uDC4E ${f.negativeVotes}`);
    return parts.join("\n");
}

// ============ PREHRAJ.TO ============

let ptCookie = "";
let ptLoggedIn = false;
let ptUser = "";
const ptFileCache = lruCache(1000);

async function ptLogin(email, password) {
    try {
        // Get initial cookies from homepage
        const pageResp = await axios.get("https://prehraj.to/", {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" },
            maxRedirects: 5, validateStatus: () => true,
        });
        ptCookie = (pageResp.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");

        // Login POST
        const params = new URLSearchParams();
        params.append("email", email);
        params.append("password", password);
        params.append("remember_login", "on");
        params.append("login", "Přihlásit se");
        params.append("_do", "loginDialog-login-loginForm-submit");

        const resp = await axios.post("https://prehraj.to/?frm=loginDialog-login-loginForm", params.toString(), {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": "https://prehraj.to/",
                "X-Requested-With": "XMLHttpRequest",
                Cookie: ptCookie,
            },
            maxRedirects: 0, validateStatus: () => true,
        });

        const newCookies = (resp.headers["set-cookie"] || []).map(c => c.split(";")[0]);
        if (newCookies.length) ptCookie = mergeCookies(ptCookie, newCookies);

        // Follow redirect if 302/303
        if (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
            const loc = resp.headers.location.startsWith("http") ? resp.headers.location : `https://prehraj.to${resp.headers.location}`;
            const followResp = await axios.get(loc, {
                headers: { "User-Agent": "Mozilla/5.0", Cookie: ptCookie },
                maxRedirects: 5, validateStatus: () => true,
            });
            const moreCookies = (followResp.headers["set-cookie"] || []).map(c => c.split(";")[0]);
            if (moreCookies.length) ptCookie = mergeCookies(ptCookie, moreCookies);
        }

        // Check if logged in by looking for logout link or user info in cookies
        const checkResp = await axios.get("https://prehraj.to/", {
            headers: { "User-Agent": "Mozilla/5.0", Cookie: ptCookie },
            maxRedirects: 5, validateStatus: () => true,
        });
        const html = typeof checkResp.data === "string" ? checkResp.data : "";
        const moreCookies2 = (checkResp.headers["set-cookie"] || []).map(c => c.split(";")[0]);
        if (moreCookies2.length) ptCookie = mergeCookies(ptCookie, moreCookies2);

        if (html.includes("odhlásit") || html.includes("Odhlásit") || html.includes("?do=logout") || html.includes("user-menu")) {
            ptLoggedIn = true;
            ptUser = email;
            console.log(`[LOGIN] Prehraj.to OK as ${email}`);
            return true;
        }
        console.log("[LOGIN] Prehraj.to failed - not logged in after POST");
        return false;
    } catch (e) { console.error("[LOGIN] Prehraj.to error:", e.message); return false; }
}

async function ptSearch(query) {
    if (!query) return [];
    try {
        const slug = query.replace(/[^a-zA-Z0-9áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽäľĺŕôöüÄĽĺŔÔÖÜ ]+/g, " ").trim().replace(/\s+/g, "-");
        const url = `https://prehraj.to/hledej/${encodeURIComponent(slug)}`;
        const resp = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" }, timeout: 15000 });
        const html = typeof resp.data === "string" ? resp.data : "";
        const files = [];
        // Each result is: <a class="video video--small video--link" href="/slug/id" title="...">...</a>
        const itemRegex = /<a[^>]*class="video video--small video--link"[^>]*href="([^"]+)"[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while ((m = itemRegex.exec(html)) !== null) {
            const href = m[1];
            const titleAttr = m[2];
            const block = m[3];
            const pathParts = href.split("/").filter(Boolean);
            if (pathParts.length < 2) continue;
            const ptSlug = pathParts[pathParts.length - 2];
            const ptId = pathParts[pathParts.length - 1];
            // Title from <h3> or from title attribute
            const titleM = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
            const name = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : (titleAttr || ptSlug);
            // Duration from video__tag--time
            const durM = block.match(/video__tag--time[^>]*>([\s\S]*?)<\/div>/i);
            const duration = durM ? durM[1].replace(/<[^>]+>/g, "").trim() : "";
            // Size from video__tag--size
            const sizeM = block.match(/video__tag--size[^>]*>([\s\S]*?)<\/div>/i);
            const size = sizeM ? sizeM[1].replace(/<[^>]+>/g, "").trim() : "";
            // Quality from video__tag--format
            const qualM = block.match(/format__text[^>]*>([\s\S]*?)<\/span>/i);
            const quality = qualM ? qualM[1].replace(/<[^>]+>/g, "").trim() : "";
            // Likes from video__tag--like
            const likesM = block.match(/video__tag--like[^>]*>([\s\S]*?)<\/div>/i);
            const likes = likesM ? parseInt(likesM[1].replace(/<[^>]+>/g, "").trim()) || 0 : 0;
            // Thumbnail
            const thumbM = block.match(/<img[^>]*src="(https:\/\/thumb[^"]+)"[^>]*/i);
            const thumbnail = thumbM ? thumbM[1] : "";

            const file = { name, ptId, ptSlug, duration, size, quality, likes, thumbnail, audioTracks: detectAudio(name) };
            ptFileCache[ptId] = file;
            files.push(file);
        }
        if (files.length) console.log(`[PREHRAJ.TO] Search '${query}': ${files.length} results`);
        return files;
    } catch (e) { console.error("[PREHRAJ.TO] Search error:", e.message); return []; }
}

async function ptGetStreamUrl(ptSlug, ptId) {
    try {
        // 1. Fetch the video page to get cookies
        const pageUrl = `https://prehraj.to/${ptSlug}/${ptId}`;
        const pageResp = await axios.get(pageUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                ...(ptCookie ? { Cookie: ptCookie } : {}),
            },
            timeout: 15000,
        });
        // Collect cookies from page visit
        let cookies = ptCookie || "";
        const pageCookies = (pageResp.headers["set-cookie"] || []).map(c => c.split(";")[0]);
        if (pageCookies.length) cookies = mergeCookies(cookies, pageCookies);

        // 2. Use ?do=download to get the original file URL (all audio tracks)
        const dlResp = await axios.get(`${pageUrl}?do=download`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                "Referer": pageUrl,
                Cookie: cookies,
            },
            maxRedirects: 0, validateStatus: () => true, timeout: 15000,
        });
        if (dlResp.status >= 300 && dlResp.status < 400 && dlResp.headers.location) {
            console.log(`[PREHRAJ.TO] Download URL for ${ptId}: original file`);
            return dlResp.headers.location;
        }

        // 3. Fallback: extract stream URL from page (transcoded, single audio track)
        const html = typeof pageResp.data === "string" ? pageResp.data : "";
        const srcMatches = [...html.matchAll(/videos\.push\(\s*\{[^}]*src:\s*['"]([^'"]+)['"]/g)];
        if (srcMatches.length) return srcMatches[0][1];
        const cdnMatch = html.match(/https:\/\/pf-storage\d+\.premiumcdn\.net\/[^"'\s]+\.mp4[^"'\s]*/);
        if (cdnMatch) return cdnMatch[0];
        return null;
    } catch (e) { console.error("[PREHRAJ.TO] Stream URL error:", e.message); return null; }
}

async function searchPtForImdb(imdbId, season, episode) {
    const { queries, epTag } = await buildImdbQueries(imdbId, season, episode);
    if (!queries.length) return [];
    const seen = new Set(), all = [];
    const perQuery = await Promise.all(queries.map(q => ptSearch(q)));
    for (const r of perQuery) {
        for (const f of r) { if (!seen.has(f.ptId)) { seen.add(f.ptId); all.push(f); } }
    }
    const matchesEp = makeEpFilter(epTag, season, episode);
    return matchesEp ? all.filter(f => matchesEp(f.name)) : all;
}

function ptFormatName(file) {
    const parts = [];
    const audio = (file.audioTracks || "").toUpperCase();
    if (audio.includes("SK")) parts.push("🇸🇰");
    if (audio.includes("CZ")) parts.push("🇨🇿");
    if (file.quality) parts.push(file.quality);
    return parts.join("\n");
}

function ptFormatDesc(file) {
    const parts = [file.name];
    if (file.duration) parts.push("⏱ " + file.duration);
    if (file.size) parts.push("💾 " + file.size);
    if (file.likes > 0) parts.push("❤ " + file.likes);
    return parts.join("\n");
}

// ============ LABELS ============

function stLabel() { return `SledujTeTo.cz ${stPremium ? "✓" : "✗"}`; }
function fsLabel() { return `Fastshare.cz ${fsUnlimited ? "✓" : "✗"}`; }
function wsLabel() { return `Webshare.cz ${wsVip ? "✓" : "✗"}`; }

// ============ LAN MODE ============

// LAN mode (config.lanMode): when enabled the servers listen on 0.0.0.0,
// so Stremio on iPhone / LG TV / another PC on the same network can use
// the addons via http://<this-device-ip>:7515/... Default is OFF -
// bound to 127.0.0.1 only, unreachable from the network.
let proxyServer = null;
let addonServer = null;

function currentBindHost() { return config.lanMode ? "0.0.0.0" : "127.0.0.1"; }

function getLanIps() {
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const i of list || []) {
            if (i.family === "IPv4" && !i.internal) ips.push(i.address);
        }
    }
    return ips;
}

// Responses contain absolute URLs pointing at 127.0.0.1 (stream/proxy/addon
// links). When a LAN client requests them, rewrite to the host it used, so
// the links work on that device too.
function rewriteLocalUrls(str, req) {
    const host = ((req.headers && req.headers.host) || "").split(":")[0];
    if (!host || host === "127.0.0.1" || host === "localhost") return str;
    return str.split("127.0.0.1").join(host);
}

// Re-bind both servers after the LAN mode toggle (delayed so the HTTP
// response for the toggle itself is delivered first).
function rebindServers() {
    const host = currentBindHost();
    const rebind = (srv, port, name) => new Promise((resolve) => {
        if (!srv) return resolve();
        try { if (srv.closeAllConnections) srv.closeAllConnections(); } catch (e) {}
        srv.close(() => {
            srv.listen(port, host, () => {
                console.log(`[${name}] Re-bound to ${host}:${port}`);
                resolve();
            });
        });
    });
    return Promise.all([rebind(proxyServer, PROXY_PORT, "PROXY"), rebind(addonServer, ADDON_PORT, "ADDON")]);
}

// ============ PROXY ============

function startProxyServer() {
    const proxy = http.createServer(async (req, res) => {
        // "Zastaviť server" in the UI now stops streaming too, not just the addon handlers
        const isStreamReq = /^\/(proxy|fsproxy|ptproxy|wsproxy)\//.test(req.url);
        if (isStreamReq && !serverRunning) { res.writeHead(503); res.end("Server stopped"); return; }

        // Webshare lazy resolve: /wsproxy/{ident} -> 302 redirect to the direct link.
        // The link is resolved only at playback time instead of resolving every
        // search result up front (which risked Stremio timeouts).
        const wsMatch = req.url.match(/^\/wsproxy\/([^/?]+)/);
        if (wsMatch) {
            try {
                const link = await wsGetLink(decodeURIComponent(wsMatch[1]));
                if (!link) { res.writeHead(502); res.end("No link"); return; }
                res.writeHead(302, { Location: link });
                res.end();
            } catch (e) { if (!res.headersSent) { res.writeHead(502); res.end("Error"); } }
            return;
        }

        // SledujTeTo proxy: /proxy/{videoId}
        const stMatch = req.url.match(/^\/proxy\/(\d+)/);
        if (stMatch) {
            const videoId = stMatch[1];
            try {
                const info = await getStreamInfo(videoId);
                if (!info) { res.writeHead(502); res.end("No stream"); return; }
                const headers = {
                    "User-Agent": "Mozilla/5.0", "Referer": `${BASE_URL}/`, Cookie: sessionCookie,
                };
                if (req.headers.range) headers.Range = req.headers.range;
                const vidResp = await axios.get(info.videoUrl, { headers, responseType: "stream", validateStatus: () => true, timeout: 30000 });
                const fwd = { "Content-Type": vidResp.headers["content-type"] || "video/mp4", "Access-Control-Allow-Origin": "*" };
                if (vidResp.headers["content-length"]) fwd["Content-Length"] = vidResp.headers["content-length"];
                if (vidResp.headers["content-range"]) fwd["Content-Range"] = vidResp.headers["content-range"];
                if (vidResp.headers["accept-ranges"]) fwd["Accept-Ranges"] = vidResp.headers["accept-ranges"];
                res.writeHead(vidResp.status, fwd);
                vidResp.data.pipe(res);
                vidResp.data.on("error", () => res.end());
                res.on("close", () => vidResp.data.destroy());
            } catch (e) { if (!res.headersSent) { res.writeHead(502); res.end("Error"); } }
            return;
        }

        // Fastshare proxy: /fsproxy/{fsId}
        const fsMatch = req.url.match(/^\/fsproxy\/(.+)/);
        if (fsMatch) {
            const fsId = fsMatch[1];
            const file = fsFileCache[fsId];
            if (!file) { res.writeHead(404); res.end("Not found"); return; }
            try {
                const headers = {
                    "User-Agent": "Mozilla/5.0", ...(fsCookie ? { Cookie: fsCookie } : {}),
                };
                if (req.headers.range) headers.Range = req.headers.range;
                const vidResp = await axios.get(file.downloadUrl, { headers, responseType: "stream", validateStatus: () => true, timeout: 30000 });
                const fwd = { "Content-Type": vidResp.headers["content-type"] || "video/mp4", "Access-Control-Allow-Origin": "*" };
                if (vidResp.headers["content-length"]) fwd["Content-Length"] = vidResp.headers["content-length"];
                if (vidResp.headers["content-range"]) fwd["Content-Range"] = vidResp.headers["content-range"];
                if (vidResp.headers["accept-ranges"]) fwd["Accept-Ranges"] = vidResp.headers["accept-ranges"];
                res.writeHead(vidResp.status, fwd);
                vidResp.data.pipe(res);
                vidResp.data.on("error", () => res.end());
                res.on("close", () => vidResp.data.destroy());
            } catch (e) { if (!res.headersSent) { res.writeHead(502); res.end("Error"); } }
            return;
        }

        // PrehrajTo proxy: /ptproxy/{slug}/{ptId}
        const ptMatch = req.url.match(/^\/ptproxy\/([^/]+)\/([^/?]+)/);
        if (ptMatch) {
            const ptSlug = ptMatch[1];
            const ptId = ptMatch[2];
            try {
                const streamUrl = await ptGetStreamUrl(ptSlug, ptId);
                if (!streamUrl) { res.writeHead(502); res.end("No stream URL"); return; }
                const headers = {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                    "Referer": "https://prehraj.to/",
                };
                if (req.headers.range) headers.Range = req.headers.range;
                const vidResp = await axios.get(streamUrl, { headers, responseType: "stream", validateStatus: () => true, timeout: 30000 });
                const fwd = { "Content-Type": vidResp.headers["content-type"] || "video/mp4", "Access-Control-Allow-Origin": "*" };
                if (vidResp.headers["content-length"]) fwd["Content-Length"] = vidResp.headers["content-length"];
                if (vidResp.headers["content-range"]) fwd["Content-Range"] = vidResp.headers["content-range"];
                if (vidResp.headers["accept-ranges"]) fwd["Accept-Ranges"] = vidResp.headers["accept-ranges"];
                res.writeHead(vidResp.status, fwd);
                vidResp.data.pipe(res);
                vidResp.data.on("error", () => res.end());
                res.on("close", () => vidResp.data.destroy());
            } catch (e) { if (!res.headersSent) { res.writeHead(502); res.end("Error"); } }
            return;
        }

        // ---- CONFIG API ----
        if (req.url === "/api/status") {
            const status = {
                serverRunning,
                lanMode: !!config.lanMode,
                lanIps: getLanIps(),
                st: { loggedIn, premium: stPremium, user: config.stEmail || "" },
                fs: { loggedIn: fsLoggedIn, unlimited: fsUnlimited, user: fsUser },
                ws: { loggedIn: wsLoggedIn, vip: wsVip, user: wsUser },
                pt: { loggedIn: ptLoggedIn, user: ptUser },
                addons: {
                    st: `http://127.0.0.1:${ADDON_PORT}/st/manifest.json`,
                    fs: `http://127.0.0.1:${ADDON_PORT}/fs/manifest.json`,
                    hs: `http://127.0.0.1:${ADDON_PORT}/hs/manifest.json`,
                    ws: `http://127.0.0.1:${ADDON_PORT}/ws/manifest.json`,
                    pt: `http://127.0.0.1:${ADDON_PORT}/pt/manifest.json`,
                },
            };
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(rewriteLocalUrls(JSON.stringify(status), req));
            return;
        }

        // ---- LAN MODE TOGGLE ----
        if (req.url === "/api/lan" && req.method === "POST") {
            let body = "";
            req.on("data", c => body += c);
            req.on("end", () => {
                try {
                    const { enabled } = JSON.parse(body);
                    config.lanMode = !!enabled;
                    saveConfig(config);
                    console.log(`[LAN] Mode ${config.lanMode ? "ENABLED (0.0.0.0)" : "disabled (127.0.0.1)"}`);
                    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(JSON.stringify({ ok: true, lanMode: config.lanMode, lanIps: getLanIps() }));
                    // Re-bind after the response is delivered
                    setTimeout(() => rebindServers().catch(e => console.error("[LAN] Rebind error:", e.message)), 500);
                } catch (e) {
                    res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }

        // ---- OTA UPDATE ----
        if (req.url === "/api/update/check") {
            try {
                const r = await axios.get(UPDATE_MANIFEST_URL, {
                    timeout: 15000, validateStatus: () => true,
                    headers: { "Cache-Control": "no-cache" },
                });
                const m = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
                const latest = parseInt(m.version) || 0;
                const apkVersion = parseInt(m.apkVersion) || 0;
                res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                res.end(JSON.stringify({
                    ok: true,
                    current: APP_VERSION,
                    latest,
                    updateAvailable: latest > APP_VERSION,
                    notes: m.notes || "",
                    // Full APK update (Android only)
                    apkUrl: m.apkUrl || "",
                    apkVersion,
                    nativeVersion: NATIVE_VERSION,
                    appUpdateAvailable: NATIVE_VERSION > 0 && apkVersion > NATIVE_VERSION && !!m.apkUrl,
                }));
            } catch (e) {
                res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                res.end(JSON.stringify({ ok: false, error: e.message, current: APP_VERSION }));
            }
            return;
        }

        if (req.url === "/api/update/apply" && req.method === "POST") {
            try {
                const r = await axios.get(UPDATE_MANIFEST_URL, {
                    timeout: 15000, validateStatus: () => true,
                    headers: { "Cache-Control": "no-cache" },
                });
                const m = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
                const latest = parseInt(m.version) || 0;
                if (latest <= APP_VERSION) {
                    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(JSON.stringify({ ok: false, error: "Žiadna novšia verzia" }));
                    return;
                }
                if (!m.addonUrl) {
                    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(JSON.stringify({ ok: false, error: "update.json neobsahuje addonUrl" }));
                    return;
                }
                const dl = await axios.get(m.addonUrl, {
                    timeout: 30000, responseType: "text", validateStatus: () => true,
                    headers: { "Cache-Control": "no-cache" },
                });
                const newCode = typeof dl.data === "string" ? dl.data : String(dl.data);
                // Verify the downloaded file really is addon.js (not e.g. a 404 page)
                if (dl.status !== 200 || newCode.length < 5000 ||
                    !newCode.includes("startAddonServer") || !newCode.includes("APP_VERSION")) {
                    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(JSON.stringify({ ok: false, error: "Stiahnutý súbor nie je platný addon.js" }));
                    return;
                }
                // Back up the original file + write the new one
                try { fs.writeFileSync(__filename + ".bak", fs.readFileSync(__filename)); } catch (e) {}
                fs.writeFileSync(__filename, newCode, "utf8");
                console.log(`[UPDATE] Nainštalovaná verzia ${latest}, reštartujem...`);
                res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                res.end(JSON.stringify({ ok: true, version: latest }));
                // Exit the process - the wrapper restarts the app with the new code
                setTimeout(() => process.exit(UPDATE_EXIT_CODE), 1200);
            } catch (e) {
                res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
            return;
        }

        if (req.url === "/api/login/st" && req.method === "POST") {
            let body = "";
            req.on("data", c => body += c);
            req.on("end", async () => {
                try {
                    const { email, password } = JSON.parse(body);
                    const ok = await login(email, password);
                    if (ok) {
                        config.stEmail = email; config.stPassword = password; saveConfig(config);
                        await refreshPremium();
                    }
                    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(JSON.stringify({ ok, premium: stPremium }));
                } catch (e) {
                    res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }

        if (req.url === "/api/logout/st" && req.method === "POST") {
            sessionCookie = ""; loggedIn = false; stPremium = false;
            delete config.stEmail; delete config.stPassword; saveConfig(config);
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.url === "/api/login/fs" && req.method === "POST") {
            let body = "";
            req.on("data", c => body += c);
            req.on("end", async () => {
                try {
                    const { username, password } = JSON.parse(body);
                    const ok = await fsLogin(username, password);
                    if (ok) {
                        config.fsUsername = username; config.fsPassword = password; saveConfig(config);
                    }
                    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(JSON.stringify({ ok, unlimited: fsUnlimited }));
                } catch (e) {
                    res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }

        if (req.url === "/api/logout/fs" && req.method === "POST") {
            fsCookie = ""; fsLoggedIn = false; fsUnlimited = false; fsUser = "";
            delete config.fsUsername; delete config.fsPassword; saveConfig(config);
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.url === "/api/login/ws" && req.method === "POST") {
            let body = "";
            req.on("data", c => body += c);
            req.on("end", async () => {
                try {
                    const { username, password } = JSON.parse(body);
                    const ok = await wsLogin(username, password);
                    if (ok) {
                        config.wsUsername = username; config.wsPassword = password; saveConfig(config);
                    }
                    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(JSON.stringify({ ok, vip: wsVip }));
                } catch (e) {
                    res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }

        if (req.url === "/api/logout/ws" && req.method === "POST") {
            wsToken = ""; wsLoggedIn = false; wsVip = false; wsUser = "";
            delete config.wsUsername; delete config.wsPassword; saveConfig(config);
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.url === "/api/login/pt" && req.method === "POST") {
            let body = "";
            req.on("data", c => body += c);
            req.on("end", async () => {
                try {
                    const { email, password } = JSON.parse(body);
                    const ok = await ptLogin(email, password);
                    if (ok) {
                        config.ptEmail = email; config.ptPassword = password; saveConfig(config);
                    }
                    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(JSON.stringify({ ok }));
                } catch (e) {
                    res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }

        if (req.url === "/api/logout/pt" && req.method === "POST") {
            ptCookie = ""; ptLoggedIn = false; ptUser = "";
            delete config.ptEmail; delete config.ptPassword; saveConfig(config);
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.url === "/api/server/stop" && req.method === "POST") {
            serverRunning = false;
            console.log("[SERVER] Stopped by user");
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true, running: false }));
            return;
        }

        if (req.url === "/api/server/start" && req.method === "POST") {
            serverRunning = true;
            console.log("[SERVER] Started by user");
            res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: true, running: true }));
            return;
        }

        if (req.url === "/configure" || req.url === "/configure/") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(getConfigHTML());
            return;
        }

        res.writeHead(404); res.end("Not found");
    });
    proxyServer = proxy;
    // 127.0.0.1 by default; 0.0.0.0 when LAN mode is enabled
    proxy.listen(PROXY_PORT, currentBindHost(), () => console.log(`[PROXY] Running on ${currentBindHost()}:${PROXY_PORT}`));
}

function getConfigHTML() {
    return `<!DOCTYPE html>
<html lang="sk">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stream Hub - Konfigurácia</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #111827; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; min-height: 100vh; display: flex; justify-content: center; padding: 24px; }
.container { max-width: 560px; width: 100%; }
.header { text-align: center; margin-bottom: 24px; }
.header h1 { color: #ffffff; font-size: 28px; margin-bottom: 2px; letter-spacing: 0.5px; }
.header .subtitle { color: #6b7280; font-size: 13px; }
.server-bar { display: flex; align-items: center; gap: 10px; background: #1f2937; border-radius: 16px; padding: 12px 16px; margin-bottom: 20px; font-size: 13px; }
.server-bar .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.server-bar .label { flex: 1; }
.dot-green { background: #34d399; }
.dot-red { background: #6b7280; }
.server-toggle { background: #4a9c4f; border: none; color: #fff; font-size: 12px; font-weight: 600; padding: 6px 18px; border-radius: 12px; cursor: pointer; }
.server-toggle:hover { background: #3d8b40; }

/* Service cards */
.services-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
.service-card { background: #1f2937; border-radius: 16px; padding: 16px; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 12px; }
.service-card:hover { background: #253044; }
.service-card.active { background: #253044; box-shadow: inset 0 0 0 2px #4a9c4f; }
.service-card.no-login { cursor: default; }
.service-card.no-login:hover { background: #1f2937; }
.card-info { flex: 1; min-width: 0; }
.card-name-row { display: flex; align-items: center; gap: 8px; }
.card-name { font-weight: bold; font-size: 15px; color: #ffffff; }
.card-status { font-size: 11px; margin-top: 2px; color: #6b7280; }
.card-status .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
.card-actions { display: flex; gap: 6px; flex-shrink: 0; }
.card-actions .btn-add, .card-actions .btn-login-card { padding: 8px 16px; border: none; border-radius: 12px; font-size: 12px; cursor: pointer; font-weight: bold; color: #fff; background: #4a9c4f; transition: background 0.15s; }
.card-actions .btn-add:hover, .card-actions .btn-login-card:hover { background: #3d8b40; }
.card-badge { font-size: 14px; display: inline-block; line-height: 1; }
.card-badge:empty { display: none; }

/* Update panel */
.update-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: #1f2937; border-radius: 16px; padding: 12px 16px; margin-bottom: 10px; font-size: 13px; }
.update-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.update-title { font-weight: bold; font-size: 14px; color: #ffffff; }
.update-status { font-size: 11px; color: #9ca3af; }
.update-btn { padding: 8px 16px; border: none; border-radius: 12px; font-size: 12px; cursor: pointer; font-weight: bold; color: #fff; background: #4a9c4f; transition: background 0.15s; flex-shrink: 0; }
.update-btn:hover { background: #3d8b40; }
.update-btn:disabled { opacity: 0.5; cursor: default; }

/* Login panel */
.login-panel { background: #1a2233; border-radius: 16px; padding: 16px; margin-bottom: 12px; animation: slideDown 0.2s ease-out; display: none; }
.login-panel.open { display: block; }
@keyframes slideDown { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
.login-panel .panel-title { font-size: 13px; font-weight: bold; margin-bottom: 12px; color: #d1d5db; }
.login-panel input { width: 100%; padding: 12px 14px; margin-bottom: 8px; background: #111827; border: 1px solid #374151; border-radius: 12px; color: #fff; font-size: 14px; outline: none; transition: border-color 0.15s; }
.login-panel input::placeholder { color: #6b7280; }
.login-panel input:focus { border-color: #4a9c4f; }
.panel-actions { display: flex; gap: 8px; }
.btn-login { flex: 1; padding: 10px; border: none; border-radius: 12px; font-size: 13px; cursor: pointer; font-weight: bold; color: #fff; background: #4a9c4f; transition: background 0.15s; }
.btn-login:hover { background: #3d8b40; }
.btn-login:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-logout-sm { padding: 10px 16px; background: #dc2626; border: none; border-radius: 12px; color: #fff; font-size: 13px; cursor: pointer; transition: all 0.15s; }
.btn-logout-sm:hover { background: #b91c1c; color: #fff; }
.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #374151; border-top-color: #4a9c4f; border-radius: 50%; animation: spin 0.6s linear infinite; margin-left: 6px; vertical-align: middle; }
@keyframes spin { to { transform: rotate(360deg); } }
.hidden { display: none; }

/* Language switcher */
.lang-switcher { display: flex; justify-content: center; gap: 8px; margin-top: 10px; margin-bottom: 16px; }
.lang-btn { font-size: 24px; padding: 4px 10px; border-radius: 8px; cursor: pointer; background: #1f2937; border: none; line-height: 1; transition: background 0.15s; }
.lang-btn.active { background: #4a9c4f; }
.lang-btn:hover { background: #253044; }
.lang-btn.active:hover { background: #3d8b40; }

/* Top bar + hamburger side menu */
.topbar { display: flex; justify-content: flex-end; margin-bottom: 16px; }
.hamburger { background: #1f2937; border: none; color: #e5e7eb; font-size: 22px; line-height: 1; width: 44px; height: 44px; border-radius: 12px; cursor: pointer; transition: background 0.15s; }
.hamburger:hover, .hamburger:focus { background: #2b3a4f; outline: none; }
.menu-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); opacity: 0; visibility: hidden; transition: opacity 0.2s; z-index: 40; }
.menu-overlay.open { opacity: 1; visibility: visible; }
.side-menu { position: fixed; top: 0; right: 0; height: 100%; width: 300px; max-width: 85vw; background: #0b0f19; box-shadow: -8px 0 24px rgba(0,0,0,0.5); padding: 20px; box-sizing: border-box; transform: translateX(100%); transition: transform 0.25s ease; z-index: 50; overflow-y: auto; }
.side-menu.open { transform: translateX(0); }
.menu-close { background: none; border: none; color: #9ca3af; font-size: 20px; cursor: pointer; position: absolute; top: 12px; right: 12px; width: 36px; height: 36px; border-radius: 8px; }
.menu-close:hover, .menu-close:focus { background: #1f2937; color: #fff; outline: none; }
.menu-brand { display: flex; align-items: center; justify-content: center; gap: 12px; margin: 10px 0 22px; }
.brand-icon { width: 54px; height: 54px; flex-shrink: 0; }
.brand-text { line-height: 1.15; }
.brand-title { font-size: 22px; font-weight: 700; color: #4a9c4f; }
.brand-sub { font-size: 15px; color: #9ca3af; }

</style>
</head>
<body>
<div class="container">
    <div class="topbar">
        <button class="hamburger" onclick="toggleMenu()" aria-label="Menu">&#9776;</button>
    </div>

    <!-- Server bar -->
    <div class="server-bar">
        <span id="serverDot" class="dot dot-red"></span>
        <span id="serverLabel" class="label" style="color:#f87171">Server zastavený</span>
        <button class="server-toggle" id="serverToggle" onclick="toggleServer()">Spustiť</button>
    </div>

    <!-- Service cards + login panels inline -->
    <div class="services-list">
        <div class="service-card" id="card-hs">
            <div class="card-info">
                <div class="card-name-row">
                    <div class="card-name">Hellspy.to</div>
                    <span class="card-badge" style="color:#4a9c4f">✓</span>
                </div>
                <div class="card-status" id="status-hs" style="color:#34d399">Bez prihlásenia</div>
            </div>
            <div class="card-actions">
                <button class="btn-add" onclick="event.stopPropagation();installOne('hs')">Pridať</button>
            </div>
        </div>

        <div class="service-card" id="card-pt" onclick="togglePanel('pt')">
            <div class="card-info">
                <div class="card-name-row">
                    <div class="card-name">Prehraj.to</div>
                    <span class="card-badge" id="badge-pt" style="color:#4a9c4f">✓</span>
                </div>
                <div class="card-status" id="status-pt" style="color:#34d399">Bez prihlásenia</div>
            </div>
            <div class="card-actions">
                <button class="btn-login-card" onclick="event.stopPropagation();togglePanel('pt')">Prihlásiť</button>
                <button class="btn-add" onclick="event.stopPropagation();installOne('pt')">Pridať</button>
            </div>
        </div>
        <div class="login-panel" id="panel-pt">
            <div class="panel-title">Prihlásenie Prehraj.to</div>
            <input type="text" id="ptEmail" placeholder="Meno/Email">
            <input type="password" id="ptPassword" placeholder="Heslo">
            <div class="panel-actions">
                <button class="btn-login" id="ptLoginBtn" onclick="ptLoginAction()">Prihlásiť</button>
                <button class="btn-logout-sm hidden" id="ptLogoutBtn" onclick="ptLogoutAction()">Odhlásiť</button>
            </div>
            <span id="ptSpinner" class="spinner hidden"></span>
        </div>

        <div class="service-card" id="card-st" onclick="togglePanel('st')">
            <div class="card-info">
                <div class="card-name-row">
                    <div class="card-name">SledujTeTo.cz</div>
                    <span class="card-badge" id="badge-st" style="color:#f87171">🔒</span>
                </div>
                <div class="card-status" id="status-st"><span class="dot dot-red"></span>Načítavam</div>
            </div>
            <div class="card-actions">
                <button class="btn-login-card" onclick="event.stopPropagation();togglePanel('st')">Prihlásiť</button>
                <button class="btn-add" onclick="event.stopPropagation();installOne('st')">Pridať</button>
            </div>
        </div>
        <div class="login-panel" id="panel-st">
            <div class="panel-title">Prihlásenie SledujTeTo.cz</div>
            <input type="text" id="stEmail" placeholder="Meno/Email">
            <input type="password" id="stPassword" placeholder="Heslo">
            <div class="panel-actions">
                <button class="btn-login" id="stLoginBtn" onclick="stLogin()">Prihlásiť</button>
                <button class="btn-logout-sm hidden" id="stLogoutBtn" onclick="stLogout()">Odhlásiť</button>
            </div>
            <span id="stSpinner" class="spinner hidden"></span>
        </div>

        <div class="service-card" id="card-fs" onclick="togglePanel('fs')">
            <div class="card-info">
                <div class="card-name-row">
                    <div class="card-name">Fastshare.cz</div>
                    <span class="card-badge" id="badge-fs" style="color:#f87171">🔒</span>
                </div>
                <div class="card-status" id="status-fs"><span class="dot dot-red"></span>Načítavam</div>
            </div>
            <div class="card-actions">
                <button class="btn-login-card" onclick="event.stopPropagation();togglePanel('fs')">Prihlásiť</button>
                <button class="btn-add" onclick="event.stopPropagation();installOne('fs')">Pridať</button>
            </div>
        </div>
        <div class="login-panel" id="panel-fs">
            <div class="panel-title">Prihlásenie Fastshare.cz</div>
            <input type="text" id="fsUsername" placeholder="Meno/Email">
            <input type="password" id="fsPassword" placeholder="Heslo">
            <div class="panel-actions">
                <button class="btn-login" id="fsLoginBtn" onclick="fsLoginAction()">Prihlásiť</button>
                <button class="btn-logout-sm hidden" id="fsLogoutBtn" onclick="fsLogout()">Odhlásiť</button>
            </div>
            <span id="fsSpinner" class="spinner hidden"></span>
        </div>

        <div class="service-card" id="card-ws" onclick="togglePanel('ws')">
            <div class="card-info">
                <div class="card-name-row">
                    <div class="card-name">Webshare.cz</div>
                    <span class="card-badge" id="badge-ws" style="color:#f87171">🔒</span>
                </div>
                <div class="card-status" id="status-ws"><span class="dot dot-red"></span>Načítavam</div>
            </div>
            <div class="card-actions">
                <button class="btn-login-card" onclick="event.stopPropagation();togglePanel('ws')">Prihlásiť</button>
                <button class="btn-add" onclick="event.stopPropagation();installOne('ws')">Pridať</button>
            </div>
        </div>
        <div class="login-panel" id="panel-ws">
            <div class="panel-title">Prihlásenie Webshare.cz</div>
            <input type="text" id="wsUsername" placeholder="Meno/Email">
            <input type="password" id="wsPassword" placeholder="Heslo">
            <div class="panel-actions">
                <button class="btn-login" id="wsLoginBtn" onclick="wsLoginAction()">Prihlásiť</button>
                <button class="btn-logout-sm hidden" id="wsLogoutBtn" onclick="wsLogoutAction()">Odhlásiť</button>
            </div>
            <span id="wsSpinner" class="spinner hidden"></span>
        </div>
    </div>

</div>

<!-- Hamburger side menu -->
<div class="menu-overlay" id="menuOverlay" onclick="toggleMenu()"></div>
<div class="side-menu" id="sideMenu">
    <button class="menu-close" onclick="toggleMenu()" aria-label="Zavrieť">&#10005;</button>
    <div class="menu-brand">
        <svg class="brand-icon" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
            <rect x="18" y="18" width="64" height="64" rx="14" transform="rotate(45 50 50)" fill="#4a9c4f"/>
            <path d="M43 35 L43 65 L68 50 Z" fill="#ffffff"/>
        </svg>
        <div class="brand-text">
            <div class="brand-title">Stream Hub</div>
            <div class="brand-sub">for Stremio</div>
        </div>
    </div>
    <div class="lang-switcher">
        <button class="lang-btn active" id="lang-sk" onclick="switchLang('sk')">🇸🇰</button>
        <button class="lang-btn" id="lang-cz" onclick="switchLang('cz')">🇨🇿</button>
        <button class="lang-btn" id="lang-en" onclick="switchLang('en')">🇬🇧</button>
    </div>
    <div class="update-bar">
        <div class="update-info">
            <span class="update-title" id="updTitle">Aktualizácia</span>
            <span class="update-status" id="updStatus">v${APP_VERSION}</span>
        </div>
        <button class="update-btn" id="updBtn" onclick="updateAction()">Skontrolovať</button>
    </div>
    <div class="update-bar">
        <div class="update-info">
            <span class="update-title" id="lanTitle">Prístup zo siete</span>
            <span class="update-status" id="lanStatus">...</span>
        </div>
        <button class="update-btn" id="lanBtn" onclick="lanToggle()">...</button>
    </div>
    <div id="lanUrls" style="font-size:11px; color:#9ca3af; padding:0 6px 10px; word-break:break-all; line-height:1.6;"></div>
</div>

<script>
const API = window.location.origin;
let addonUrls = {};
let openPanel = null;
let updateState = "idle"; // idle | available
const APP_VER = ${APP_VERSION};
const NATIVE_VER = ${NATIVE_VERSION};
const NATIVE_VER_NAME = "${NATIVE_VERSION_NAME}";
const isAndroid = NATIVE_VER > 0; // Android wrapper passes its versionCode
let lastCheck = null; // last /api/update/check result (for re-render on language switch)
let pendingApkUrl = null;

// ---- Hamburger side menu ----
function toggleMenu() {
    const menu = document.getElementById("sideMenu");
    const overlay = document.getElementById("menuOverlay");
    const open = !menu.classList.contains("open");
    menu.classList.toggle("open", open);
    overlay.classList.toggle("open", open);
    if (open) {
        const f = menu.querySelector(".menu-close");
        if (f) f.focus();
    }
}

// ---- Translations ----
const T = {
    sk: {
        serverStopped: "Server zastavený", serverRunning: "Server beží", serverUnavailable: "Server nedostupný",
        start: "Spustiť", stop: "Zastaviť",
        noLoginRequired: "Bez prihlásenia", notLoggedIn: "Neprihlásený",
        add: "Pridať", login: "Login", signIn: "Prihlásiť", signOut: "Odhlásiť",
        hintUsernameEmail: "Meno/Email", hintPassword: "Heslo",
        fillUsernamePassword: "Vyplňte meno a heslo", fillEmailPassword: "Vyplňte email a heslo",
        loginFailed: "Prihlásenie zlyhalo", error: "Chyba",
        panelSt: "Prihlásenie SledujTeTo.cz", panelFs: "Prihlásenie Fastshare.cz",
        panelWs: "Prihlásenie Webshare.cz", panelPt: "Prihlásenie Prehraj.to",
        updTitle: "Aktualizácia", updCheck: "Skontrolovať", updInstall: "Stiahnuť a nainštalovať",
        updChecking: "Kontrolujem...", updDownloading: "Sťahujem aktualizáciu...",
        updRestarting: "Nainštalované, reštartujem...", updUpToDate: "Máte najnovšiu verziu",
        updAvailable: "Dostupná nová verzia", updError: "Kontrola zlyhala",
        updAppAvailable: "Dostupná nová verzia aplikácie",
        appUpdTitle: "Nová verzia aplikácie", appUpdBtn: "Stiahnuť APK",
        lanTitle: "Prístup zo siete (LAN)", lanOn: "Zapnutý", lanOff: "Vypnutý",
        lanEnable: "Zapnúť", lanDisable: "Vypnúť",
        lanHintAdd: "Tlačidlo „Pridať“ teraz pridáva adresu doplnku dostupnú v celej sieti (iPhone, TV...).",
        lanWarn: "Pozor: server bude dostupný pre všetky zariadenia v domácej sieti.",
        serverRunningAt: "Server beží na",
    },
    cz: {
        serverStopped: "Server zastaven", serverRunning: "Server běží", serverUnavailable: "Server nedostupný",
        start: "Spustit", stop: "Zastavit",
        noLoginRequired: "Bez přihlášení", notLoggedIn: "Nepřihlášen",
        add: "Přidat", login: "Login", signIn: "Přihlásit", signOut: "Odhlásit",
        hintUsernameEmail: "Jméno/Email", hintPassword: "Heslo",
        fillUsernamePassword: "Vyplňte jméno a heslo", fillEmailPassword: "Vyplňte email a heslo",
        loginFailed: "Přihlášení selhalo", error: "Chyba",
        panelSt: "Přihlášení SledujTeTo.cz", panelFs: "Přihlášení Fastshare.cz",
        panelWs: "Přihlášení Webshare.cz", panelPt: "Přihlášení Prehraj.to",
        updTitle: "Aktualizace", updCheck: "Zkontrolovat", updInstall: "Stáhnout a nainstalovat",
        updChecking: "Kontroluji...", updDownloading: "Stahuji aktualizaci...",
        updRestarting: "Nainstalováno, restartuji...", updUpToDate: "Máte nejnovější verzi",
        updAvailable: "Dostupná nová verze", updError: "Kontrola selhala",
        updAppAvailable: "Dostupná nová verze aplikace",
        appUpdTitle: "Nová verze aplikace", appUpdBtn: "Stáhnout APK",
        lanTitle: "Přístup ze sítě (LAN)", lanOn: "Zapnutý", lanOff: "Vypnutý",
        lanEnable: "Zapnout", lanDisable: "Vypnout",
        lanHintAdd: "Tlačítko „Přidat“ nyní přidává adresu doplňku dostupnou v celé síti (iPhone, TV...).",
        lanWarn: "Pozor: server bude dostupný pro všechna zařízení v domácí síti.",
        serverRunningAt: "Server běží na",
    },
    en: {
        serverStopped: "Server stopped", serverRunning: "Server running", serverUnavailable: "Server unavailable",
        start: "Start", stop: "Stop",
        noLoginRequired: "No login required", notLoggedIn: "Not logged in",
        add: "Add", login: "Login", signIn: "Sign in", signOut: "Sign out",
        hintUsernameEmail: "Username/Email", hintPassword: "Password",
        fillUsernamePassword: "Enter username and password", fillEmailPassword: "Enter email and password",
        loginFailed: "Login failed", error: "Error",
        panelSt: "Login SledujTeTo.cz", panelFs: "Login Fastshare.cz",
        panelWs: "Login Webshare.cz", panelPt: "Login Prehraj.to",
        updTitle: "Update", updCheck: "Check", updInstall: "Download & install",
        updChecking: "Checking...", updDownloading: "Downloading update...",
        updRestarting: "Installed, restarting...", updUpToDate: "You have the latest version",
        updAvailable: "New version available", updError: "Check failed",
        updAppAvailable: "New app version available",
        appUpdTitle: "New app version", appUpdBtn: "Download APK",
        lanTitle: "Network access (LAN)", lanOn: "Enabled", lanOff: "Disabled",
        lanEnable: "Enable", lanDisable: "Disable",
        lanHintAdd: "The Add button now hands out the network-wide addon address (iPhone, TV...).",
        lanWarn: "Warning: the server will be reachable by every device on your home network.",
        serverRunningAt: "Server running on",
    }
};
let lang = localStorage.getItem("lang") || "sk";

function t(key) { return (T[lang] || T.sk)[key] || T.sk[key] || key; }

function switchLang(l) {
    lang = l;
    localStorage.setItem("lang", l);
    document.querySelectorAll(".lang-btn").forEach(b => b.classList.remove("active"));
    document.getElementById("lang-" + l).classList.add("active");
    applyStrings();
    loadStatus();
}

function applyStrings() {
    // Placeholders
    document.getElementById("stEmail").placeholder = t("hintUsernameEmail");
    document.getElementById("stPassword").placeholder = t("hintPassword");
    document.getElementById("fsUsername").placeholder = t("hintUsernameEmail");
    document.getElementById("fsPassword").placeholder = t("hintPassword");
    document.getElementById("wsUsername").placeholder = t("hintUsernameEmail");
    document.getElementById("wsPassword").placeholder = t("hintPassword");
    document.getElementById("ptEmail").placeholder = t("hintUsernameEmail");
    document.getElementById("ptPassword").placeholder = t("hintPassword");

    // Buttons
    document.getElementById("stLoginBtn").textContent = t("signIn");
    document.getElementById("stLogoutBtn").textContent = t("signOut");
    document.getElementById("fsLoginBtn").textContent = t("signIn");
    document.getElementById("fsLogoutBtn").textContent = t("signOut");
    document.getElementById("wsLoginBtn").textContent = t("signIn");
    document.getElementById("wsLogoutBtn").textContent = t("signOut");
    document.getElementById("ptLoginBtn").textContent = t("signIn");
    document.getElementById("ptLogoutBtn").textContent = t("signOut");

    // Panel titles
    document.querySelector("#panel-st .panel-title").textContent = t("panelSt");
    document.querySelector("#panel-fs .panel-title").textContent = t("panelFs");
    document.querySelector("#panel-ws .panel-title").textContent = t("panelWs");
    document.querySelector("#panel-pt .panel-title").textContent = t("panelPt");

    // Add buttons
    document.querySelectorAll(".btn-add").forEach(b => b.textContent = t("add"));

    // Login buttons on cards
    document.querySelectorAll(".btn-login-card").forEach(b => b.textContent = t("signIn"));

    // Hellspy status
    document.getElementById("status-hs").textContent = t("noLoginRequired");

    // Update panel
    document.getElementById("updTitle").textContent = t("updTitle");
    renderUpdateUI(); // re-render status + button in the current language

    // LAN panel
    document.getElementById("lanTitle").textContent = t("lanTitle");
    renderLanUI();
}

// ---- LAN mode ----
let lanMode = false;
let lanIps = [];

function renderLanUI() {
    document.getElementById("lanStatus").textContent = lanMode ? t("lanOn") : t("lanOff");
    document.getElementById("lanStatus").style.color = lanMode ? "#34d399" : "#9ca3af";
    document.getElementById("lanBtn").textContent = lanMode ? t("lanDisable") : t("lanEnable");
    const urls = document.getElementById("lanUrls");
    if (lanMode && lanIps.length) {
        urls.innerHTML = t("lanHintAdd") + "<br>" + t("lanWarn");
    } else {
        urls.textContent = "";
    }
}

async function lanToggle() {
    const btn = document.getElementById("lanBtn");
    btn.disabled = true;
    try {
        await fetch(API + "/api/lan", { method: "POST", body: JSON.stringify({ enabled: !lanMode }) });
    } catch (e) {}
    // the server re-binds itself - refresh the status shortly after
    setTimeout(async () => { await loadStatus(); btn.disabled = false; }, 1500);
}

function togglePanel(key) {
    document.querySelectorAll(".login-panel").forEach(p => { if (p.id !== "panel-" + key) p.classList.remove("open"); });
    document.querySelectorAll(".service-card").forEach(c => { if (c.id !== "card-" + key) c.classList.remove("active"); });
    const panel = document.getElementById("panel-" + key);
    const card = document.getElementById("card-" + key);
    if (panel.classList.contains("open")) { panel.classList.remove("open"); card.classList.remove("active"); openPanel = null; }
    else { panel.classList.add("open"); card.classList.add("active"); openPanel = key; }
}

function closePanel(key) {
    const panel = document.getElementById("panel-" + key);
    const card = document.getElementById("card-" + key);
    if (panel && panel.classList.contains("open")) {
        panel.classList.remove("open");
        if (card) card.classList.remove("active");
        if (openPanel === key) openPanel = null;
    }
}

async function loadStatus() {
    try {
        const r = await fetch(API + "/api/status");
        const s = await r.json();
        addonUrls = s.addons || {};

        lanMode = !!s.lanMode;
        lanIps = s.lanIps || [];
        renderLanUI();

        const running = s.serverRunning;
        document.getElementById("serverDot").className = "dot " + (running ? "dot-green" : "dot-red");
        let runLabel = t("serverRunning");
        if (running && lanMode && lanIps.length) runLabel = t("serverRunningAt") + " " + lanIps[0];
        document.getElementById("serverLabel").textContent = running ? runLabel : t("serverStopped");
        document.getElementById("serverLabel").style.color = running ? "#34d399" : "#f87171";
        document.getElementById("serverToggle").textContent = running ? t("stop") : t("start");

        // ST
        const stStatus = document.getElementById("status-st");
        const stBadge = document.getElementById("badge-st");
        if (s.st.loggedIn) {
            stStatus.innerHTML = '✓ ' + s.st.user; stStatus.style.color = "#34d399";
            stBadge.textContent = s.st.premium ? "✓" : "🔒"; stBadge.style.color = s.st.premium ? "#4a9c4f" : "#f87171";
            document.getElementById("stEmail").value = s.st.user;
            document.getElementById("stLogoutBtn").classList.remove("hidden");
        } else {
            stStatus.textContent = t("notLoggedIn"); stStatus.style.color = "#6b7280";
            stBadge.textContent = "🔒"; stBadge.style.color = "#f87171";
            document.getElementById("stLogoutBtn").classList.add("hidden");
        }

        // FS
        const fsStatus = document.getElementById("status-fs");
        const fsBadge = document.getElementById("badge-fs");
        if (s.fs.loggedIn) {
            fsStatus.innerHTML = '✓ ' + s.fs.user; fsStatus.style.color = "#34d399";
            fsBadge.textContent = s.fs.unlimited ? "✓" : "🔒"; fsBadge.style.color = s.fs.unlimited ? "#4a9c4f" : "#f87171";
            document.getElementById("fsUsername").value = s.fs.user;
            document.getElementById("fsLogoutBtn").classList.remove("hidden");
        } else {
            fsStatus.textContent = t("notLoggedIn"); fsStatus.style.color = "#6b7280";
            fsBadge.textContent = "🔒"; fsBadge.style.color = "#f87171";
            document.getElementById("fsLogoutBtn").classList.add("hidden");
        }

        // WS
        const wsStatus = document.getElementById("status-ws");
        const wsBadge = document.getElementById("badge-ws");
        if (s.ws.loggedIn) {
            wsStatus.innerHTML = '✓ ' + s.ws.user; wsStatus.style.color = "#34d399";
            wsBadge.textContent = s.ws.vip ? "✓" : "🔒"; wsBadge.style.color = s.ws.vip ? "#4a9c4f" : "#f87171";
            document.getElementById("wsUsername").value = s.ws.user;
            document.getElementById("wsLogoutBtn").classList.remove("hidden");
        } else {
            wsStatus.textContent = t("notLoggedIn"); wsStatus.style.color = "#6b7280";
            wsBadge.textContent = "🔒"; wsBadge.style.color = "#f87171";
            document.getElementById("wsLogoutBtn").classList.add("hidden");
        }

        // PT
        const ptStatus = document.getElementById("status-pt");
        const ptBadge = document.getElementById("badge-pt");
        if (s.pt.loggedIn) {
            ptStatus.innerHTML = '✓ ' + s.pt.user; ptStatus.style.color = "#34d399";
            ptBadge.textContent = "✓"; ptBadge.style.color = "#4a9c4f";
            document.getElementById("ptEmail").value = s.pt.user;
            document.getElementById("ptLogoutBtn").classList.remove("hidden");
        } else {
            ptStatus.textContent = t("noLoginRequired"); ptStatus.style.color = "#34d399";
            ptBadge.textContent = "✓"; ptBadge.style.color = "#4a9c4f";
            document.getElementById("ptLogoutBtn").classList.add("hidden");
        }

    } catch (e) {
        document.getElementById("serverDot").className = "dot dot-red";
        document.getElementById("serverLabel").textContent = t("serverUnavailable");
        document.getElementById("serverLabel").style.color = "#f87171";
    }
}

async function stLogin() {
    const email = document.getElementById("stEmail").value.trim();
    const pw = document.getElementById("stPassword").value.trim();
    if (!email || !pw) return alert(t("fillEmailPassword"));
    document.getElementById("stSpinner").classList.remove("hidden");
    document.getElementById("stLoginBtn").disabled = true;
    try {
        const r = await fetch(API + "/api/login/st", { method: "POST", body: JSON.stringify({ email, password: pw }) });
        const j = await r.json();
        if (j.ok) { document.getElementById("stPassword").value = ""; closePanel("st"); await loadStatus(); }
        else alert(t("loginFailed"));
    } catch (e) { alert(t("error") + ": " + e.message); }
    document.getElementById("stSpinner").classList.add("hidden");
    document.getElementById("stLoginBtn").disabled = false;
}
async function stLogout() { await fetch(API + "/api/logout/st", { method: "POST" }); document.getElementById("stEmail").value = ""; document.getElementById("stPassword").value = ""; await loadStatus(); }

async function fsLoginAction() {
    const user = document.getElementById("fsUsername").value.trim();
    const pw = document.getElementById("fsPassword").value.trim();
    if (!user || !pw) return alert(t("fillUsernamePassword"));
    document.getElementById("fsSpinner").classList.remove("hidden");
    document.getElementById("fsLoginBtn").disabled = true;
    try {
        const r = await fetch(API + "/api/login/fs", { method: "POST", body: JSON.stringify({ username: user, password: pw }) });
        const j = await r.json();
        if (j.ok) { document.getElementById("fsPassword").value = ""; closePanel("fs"); await loadStatus(); }
        else alert(t("loginFailed"));
    } catch (e) { alert(t("error") + ": " + e.message); }
    document.getElementById("fsSpinner").classList.add("hidden");
    document.getElementById("fsLoginBtn").disabled = false;
}
async function fsLogout() { await fetch(API + "/api/logout/fs", { method: "POST" }); document.getElementById("fsUsername").value = ""; document.getElementById("fsPassword").value = ""; await loadStatus(); }

async function wsLoginAction() {
    const user = document.getElementById("wsUsername").value.trim();
    const pw = document.getElementById("wsPassword").value.trim();
    if (!user || !pw) return alert(t("fillUsernamePassword"));
    document.getElementById("wsSpinner").classList.remove("hidden");
    document.getElementById("wsLoginBtn").disabled = true;
    try {
        const r = await fetch(API + "/api/login/ws", { method: "POST", body: JSON.stringify({ username: user, password: pw }) });
        const j = await r.json();
        if (j.ok) { document.getElementById("wsPassword").value = ""; closePanel("ws"); await loadStatus(); }
        else alert(t("loginFailed"));
    } catch (e) { alert(t("error") + ": " + e.message); }
    document.getElementById("wsSpinner").classList.add("hidden");
    document.getElementById("wsLoginBtn").disabled = false;
}
async function wsLogoutAction() { await fetch(API + "/api/logout/ws", { method: "POST" }); document.getElementById("wsUsername").value = ""; document.getElementById("wsPassword").value = ""; await loadStatus(); }

async function ptLoginAction() {
    const email = document.getElementById("ptEmail").value.trim();
    const pw = document.getElementById("ptPassword").value.trim();
    if (!email || !pw) return alert(t("fillEmailPassword"));
    document.getElementById("ptSpinner").classList.remove("hidden");
    document.getElementById("ptLoginBtn").disabled = true;
    try {
        const r = await fetch(API + "/api/login/pt", { method: "POST", body: JSON.stringify({ email, password: pw }) });
        const j = await r.json();
        if (j.ok) { document.getElementById("ptPassword").value = ""; closePanel("pt"); await loadStatus(); }
        else alert(t("loginFailed"));
    } catch (e) { alert(t("error") + ": " + e.message); }
    document.getElementById("ptSpinner").classList.add("hidden");
    document.getElementById("ptLoginBtn").disabled = false;
}
async function ptLogoutAction() { await fetch(API + "/api/logout/pt", { method: "POST" }); document.getElementById("ptEmail").value = ""; document.getElementById("ptPassword").value = ""; await loadStatus(); }

async function toggleServer() {
    const btn = document.getElementById("serverToggle");
    const isRunning = btn.textContent === t("stop");
    btn.disabled = true;
    await fetch(API + "/api/server/" + (isRunning ? "stop" : "start"), { method: "POST" });
    await loadStatus();
    btn.disabled = false;
}

function installOne(key) {
    let url = addonUrls[key];
    if (!url) return;
    // In LAN mode the Add button hands out the network-wide address,
    // so the addon works in Stremio on any device in the LAN.
    if (lanMode && lanIps.length) url = url.replace("127.0.0.1", lanIps[0]);
    navigator.clipboard.writeText(url).then(() => {
        window.open("stremio://" + url.replace(/^https?:\\/\\//, ""), "_blank");
    });
}

// ---- Update ----
// On Android the update panel checks the full APK; on PC it checks addon.js.
async function updateAction() {
    const btn = document.getElementById("updBtn");
    const st = document.getElementById("updStatus");

    if (updateState === "available") {
        if (isAndroid) {
            // Download the new APK - the Android wrapper intercepts the .apk
            // link in the WebView and starts the download + installation.
            if (pendingApkUrl) {
                st.textContent = t("updDownloading");
                window.open(pendingApkUrl, "_blank");
            }
        } else {
            // PC: download and apply the new addon.js
            btn.disabled = true;
            st.textContent = t("updDownloading");
            try {
                const r = await fetch(API + "/api/update/apply", { method: "POST" });
                const d = await r.json();
                if (d.ok) {
                    st.textContent = t("updRestarting");
                    // the app restarts itself with the new code
                } else {
                    st.textContent = (d.error || t("updError"));
                    btn.disabled = false;
                }
            } catch (e) {
                st.textContent = (e.message || t("updError"));
                btn.disabled = false;
            }
        }
        return;
    }

    // Check
    btn.disabled = true;
    st.textContent = t("updChecking");
    try {
        const r = await fetch(API + "/api/update/check");
        const d = await r.json();
        btn.disabled = false;
        if (!d.ok) {
            lastCheck = null;
            st.textContent = t("updError");
            return;
        }
        lastCheck = d;
        if (isAndroid) {
            updateState = d.appUpdateAvailable ? "available" : "idle";
            pendingApkUrl = d.appUpdateAvailable ? d.apkUrl : null;
        } else {
            updateState = d.updateAvailable ? "available" : "idle";
        }
        renderUpdateUI();
    } catch (e) {
        lastCheck = null;
        st.textContent = (e.message || t("updError"));
        btn.disabled = false;
    }
}

// Renders the update section (status text + button) from the last
// check result, in the currently selected language. Called after a
// check and on every language switch (from applyStrings).
function renderUpdateUI() {
    const st = document.getElementById("updStatus");
    const btn = document.getElementById("updBtn");
    const d = lastCheck;

    // Version shown to the user - the version NAME (e.g. "1.3"), not the
    // internal counter. Falls back to the addon.js version if unknown.
    const shownVer = NATIVE_VER_NAME ? ("v" + NATIVE_VER_NAME) : ("v" + APP_VER);

    if (!d) {
        st.textContent = shownVer;
        btn.textContent = t("updCheck");
        return;
    }

    if (isAndroid) {
        // Android - only the full APK update
        if (d.appUpdateAvailable) {
            st.textContent = t("updAppAvailable");
            btn.textContent = t("appUpdBtn");
        } else {
            st.textContent = t("updUpToDate") + " (" + shownVer + ")";
            btn.textContent = t("updCheck");
        }
    } else {
        // PC - only the addon.js update
        if (d.updateAvailable) {
            st.textContent = t("updAvailable");
            btn.textContent = t("updInstall");
        } else {
            st.textContent = t("updUpToDate") + " (" + shownVer + ")";
            btn.textContent = t("updCheck");
        }
    }
}

// Init
document.getElementById("lang-" + lang).classList.add("active");
document.querySelectorAll(".lang-btn").forEach(b => { if (b.id !== "lang-" + lang) b.classList.remove("active"); });
applyStrings();
loadStatus();
// Background logins finish after page load - keep the status fresh
setInterval(loadStatus, 10000);
</script>
</body>
</html>`;
}

// ============ STREMIO ADDONS (separate per server) ============

function parseImdbId(id) {
    const parts = id.split(":");
    return {
        imdbId: parts[0],
        season: parts.length > 1 ? parseInt(parts[1]) : null,
        episode: parts.length > 2 ? parseInt(parts[2]) : null,
    };
}

// --- SledujTeTo addon ---
const stManifest = {
    id: "cz.sledujteto.stremio",
    version: "2.4.0",
    name: "SledujTeTo.cz",
    description: "SledujTeTo.cz pre Stremio",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "sledujteto-main", name: "SledujTeTo.cz", extra: [{ name: "search", isRequired: false }] },
    ],
    idPrefixes: ["sleduj:", "tt"],
    behaviorHints: { adult: false, configurable: false },
};
const stBuilder = new addonBuilder(stManifest);

stBuilder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (!serverRunning) return { metas: [] };
    const query = extra?.search || "2025";
    return { metas: await fetchVideos(query) };
});

stBuilder.defineMetaHandler(async ({ type, id }) => {
    if (id.startsWith("sleduj:")) {
        const vid = id.replace("sleduj:", "");
        if (metaCache[vid]) return { meta: metaCache[vid] };
    }
    return { meta: { id, type: "movie", name: `Video ${id}` } };
});

stBuilder.defineStreamHandler(async ({ type, id }) => {
    if (!serverRunning) return { streams: [] };
    await refreshPremium();
    if (id.startsWith("sleduj:")) {
        const vid = id.replace("sleduj:", "");
        const info = await getStreamInfo(vid);
        if (info) {
            const fd = fileDataCache[vid];
            const name = fd?.name || "";
            return { streams: [{ url: `http://127.0.0.1:${PROXY_PORT}/proxy/${vid}`, name: `${stLabel()}\n${stFormatName(name, fd)}`, description: stFormatDesc(name, fd), behaviorHints: { notWebReady: true } }] };
        }
        return { streams: [{ externalUrl: urlCache[vid] || `${BASE_URL}/file/${vid}/`, title: "Otvoriť v prehliadači", name: stLabel() }] };
    }
    if (id.startsWith("tt")) {
        const { imdbId, season, episode } = parseImdbId(id);
        // Cap + parallel resolve - serial resolution of every result used to
        // risk Stremio timeouts on titles with many hits.
        const results = (await searchStForImdb(imdbId, season, episode)).slice(0, 30);
        const resolved = await Promise.all(results.map(async item => {
            const vid = item.id.replace("sleduj:", "");
            const info = await getStreamInfo(vid);
            if (!info) return null;
            const fd = fileDataCache[vid];
            const name = fd?.name || "";
            return { url: `http://127.0.0.1:${PROXY_PORT}/proxy/${vid}`, name: `${stLabel()}\n${stFormatName(name, fd, imdbId)}`, description: stFormatDesc(name, fd), behaviorHints: { notWebReady: true } };
        }));
        const streams = resolved.filter(Boolean);
        console.log(`[STREAM] ST ${id}: ${streams.length} streams`);
        return { streams };
    }
    return { streams: [] };
});

// --- Fastshare addon ---
const fsManifest = {
    id: "cz.fastshare.stremio",
    version: "2.4.0",
    name: "Fastshare.cz",
    description: "Fastshare.cz pre Stremio",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "fastshare-main", name: "Fastshare.cz", extra: [{ name: "search", isRequired: true }] },
    ],
    idPrefixes: ["fs:", "tt"],
    behaviorHints: { adult: false, configurable: false },
};
const fsBuilder = new addonBuilder(fsManifest);

fsBuilder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (!serverRunning || !extra?.search || !fsLoggedIn) return { metas: [] };
    const files = await fsSearch(extra.search);
    return { metas: files.map(f => ({ id: `fs:${f.fsId}`, type: "movie", name: f.name, description: [f.audioTracks, f.resolution, f.duration, f.size].filter(Boolean).join(" | ") })) };
});

fsBuilder.defineMetaHandler(async ({ type, id }) => {
    if (id.startsWith("fs:")) {
        const f = fsFileCache[id.replace("fs:", "")];
        if (f) return { meta: { id, type: "movie", name: f.name, description: [f.audioTracks, f.resolution, f.duration, f.size].filter(Boolean).join(" | ") } };
    }
    return { meta: { id, type: "movie", name: `Fastshare ${id}` } };
});

fsBuilder.defineStreamHandler(async ({ type, id }) => {
    if (!serverRunning) return { streams: [] };
    if (id.startsWith("fs:")) {
        const f = fsFileCache[id.replace("fs:", "")];
        if (f) return { streams: [{ url: `http://127.0.0.1:${PROXY_PORT}/fsproxy/${f.fsId}`, name: `${fsLabel()}\n${fsFormatName(f)}`, description: fsFormatDesc(f), behaviorHints: { notWebReady: true } }] };
        return { streams: [] };
    }
    if (id.startsWith("tt")) {
        const { imdbId, season, episode } = parseImdbId(id);
        const results = await searchFsForImdb(imdbId, season, episode);
        enhanceAudioByTitle(results, "name", imdbId);
        const streams = [];
        for (const f of results) {
            streams.push({ url: `http://127.0.0.1:${PROXY_PORT}/fsproxy/${f.fsId}`, name: `${fsLabel()}\n${fsFormatName(f)}`, description: fsFormatDesc(f), behaviorHints: { notWebReady: true } });
        }
        console.log(`[STREAM] FS ${id}: ${streams.length} streams`);
        return { streams };
    }
    return { streams: [] };
});

// --- Hellspy addon ---
const hsManifest = {
    id: "cz.hellspy.stremio",
    version: "2.4.0",
    name: "Hellspy.to",
    description: "Hellspy.to pre Stremio",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "hellspy-main", name: "Hellspy.to", extra: [{ name: "search", isRequired: true }] },
    ],
    idPrefixes: ["hs:", "tt"],
    behaviorHints: { adult: false, configurable: false },
};
const hsBuilder = new addonBuilder(hsManifest);

hsBuilder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (!serverRunning || !extra?.search) return { metas: [] };
    const files = await hsSearch(extra.search);
    return { metas: files.map(f => ({ id: `hs:${f.hsId}`, type: "movie", name: f.name, poster: f.thumbnail, description: [f.audioTracks, f.duration, f.size].filter(Boolean).join(" | ") })) };
});

hsBuilder.defineMetaHandler(async ({ type, id }) => {
    if (id.startsWith("hs:")) {
        const f = hsFileCache[id.replace("hs:", "")];
        if (f) return { meta: { id, type: "movie", name: f.name, poster: f.thumbnail, background: f.thumbnail, description: [f.audioTracks, f.duration, f.size].filter(Boolean).join(" | ") } };
    }
    return { meta: { id, type: "movie", name: `Hellspy ${id}` } };
});

hsBuilder.defineStreamHandler(async ({ type, id }) => {
    if (!serverRunning) return { streams: [] };
    if (id.startsWith("hs:")) {
        const f = hsFileCache[id.replace("hs:", "")];
        if (f) return { streams: [{ url: f.downloadUrl, name: `Hellspy.to\n${hsFormatName(f)}`, description: hsFormatDesc(f) }] };
        return { streams: [] };
    }
    if (id.startsWith("tt")) {
        const { imdbId, season, episode } = parseImdbId(id);
        const results = await searchHsForImdb(imdbId, season, episode);
        enhanceAudioByTitle(results, "name", imdbId);
        const streams = [];
        for (const f of results) {
            streams.push({ url: f.downloadUrl, name: `Hellspy.to\n${hsFormatName(f)}`, description: hsFormatDesc(f) });
        }
        console.log(`[STREAM] HS ${id}: ${streams.length} streams`);
        return { streams };
    }
    return { streams: [] };
});

// --- Webshare addon ---
const wsManifest = {
    id: "cz.webshare.stremio",
    version: "2.4.0",
    name: "Webshare.cz",
    description: "Webshare.cz pre Stremio",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "webshare-main", name: "Webshare.cz", extra: [{ name: "search", isRequired: true }] },
    ],
    idPrefixes: ["ws:", "tt"],
    behaviorHints: { adult: false, configurable: false },
};
const wsBuilder = new addonBuilder(wsManifest);

wsBuilder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (!serverRunning || !extra?.search || !wsLoggedIn) return { metas: [] };
    const files = await wsSearch(extra.search);
    return { metas: files.map(f => ({ id: `ws:${f.wsId}`, type: "movie", name: f.name, description: [f.audioTracks, f.size].filter(Boolean).join(" | ") })) };
});

wsBuilder.defineMetaHandler(async ({ type, id }) => {
    if (id.startsWith("ws:")) {
        const f = wsFileCache[id.replace("ws:", "")];
        if (f) return { meta: { id, type: "movie", name: f.name, description: [f.audioTracks, f.size].filter(Boolean).join(" | ") } };
    }
    return { meta: { id, type: "movie", name: `Webshare ${id}` } };
});

wsBuilder.defineStreamHandler(async ({ type, id }) => {
    if (!serverRunning) return { streams: [] };
    if (id.startsWith("ws:")) {
        const f = wsFileCache[id.replace("ws:", "")];
        if (f) return { streams: [{ url: `http://127.0.0.1:${PROXY_PORT}/wsproxy/${encodeURIComponent(f.wsId)}`, name: `${wsLabel()}\n${wsFormatName(f)}`, description: wsFormatDesc(f), behaviorHints: { notWebReady: true } }] };
        return { streams: [] };
    }
    if (id.startsWith("tt")) {
        const { imdbId, season, episode } = parseImdbId(id);
        const results = await searchWsForImdb(imdbId, season, episode);
        enhanceAudioByTitle(results, "name", imdbId);
        // Direct link is resolved lazily via /wsproxy at playback time -
        // no N sequential file_link calls before returning the list.
        const streams = results.map(f => ({
            url: `http://127.0.0.1:${PROXY_PORT}/wsproxy/${encodeURIComponent(f.wsId)}`,
            name: `${wsLabel()}\n${wsFormatName(f)}`, description: wsFormatDesc(f),
            behaviorHints: { notWebReady: true },
        }));
        console.log(`[STREAM] WS ${id}: ${streams.length} streams`);
        return { streams };
    }
    return { streams: [] };
});

// --- PrehrajTo addon ---
const ptManifest = {
    id: "cz.prehrajto.stremio",
    version: "2.4.0",
    name: "Prehraj.to",
    description: "Prehraj.to pre Stremio",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "prehrajto-main", name: "Prehraj.to", extra: [{ name: "search", isRequired: true }] },
    ],
    idPrefixes: ["pt:", "tt"],
    behaviorHints: { adult: false, configurable: false },
};
const ptBuilder = new addonBuilder(ptManifest);

ptBuilder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (!serverRunning || !extra?.search) return { metas: [] };
    const files = await ptSearch(extra.search);
    return { metas: files.map(f => ({ id: `pt:${f.ptId}`, type: "movie", name: f.name, poster: f.thumbnail, description: [f.audioTracks, f.quality, f.duration, f.size].filter(Boolean).join(" | ") })) };
});

ptBuilder.defineMetaHandler(async ({ type, id }) => {
    if (id.startsWith("pt:")) {
        const f = ptFileCache[id.replace("pt:", "")];
        if (f) return { meta: { id, type: "movie", name: f.name, poster: f.thumbnail, background: f.thumbnail, description: [f.audioTracks, f.quality, f.duration, f.size].filter(Boolean).join(" | ") } };
    }
    return { meta: { id, type: "movie", name: `Prehraj.to ${id}` } };
});

ptBuilder.defineStreamHandler(async ({ type, id }) => {
    if (!serverRunning) return { streams: [] };
    if (id.startsWith("pt:")) {
        const f = ptFileCache[id.replace("pt:", "")];
        if (f) return { streams: [{ url: `http://127.0.0.1:${PROXY_PORT}/ptproxy/${f.ptSlug}/${f.ptId}`, name: `Prehraj.to\n${ptFormatName(f)}`, description: ptFormatDesc(f), behaviorHints: { notWebReady: true } }] };
        return { streams: [] };
    }
    if (id.startsWith("tt")) {
        const { imdbId, season, episode } = parseImdbId(id);
        const results = await searchPtForImdb(imdbId, season, episode);
        enhanceAudioByTitle(results, "name", imdbId);
        const streams = [];
        for (const f of results) {
            streams.push({ url: `http://127.0.0.1:${PROXY_PORT}/ptproxy/${f.ptSlug}/${f.ptId}`, name: `Prehraj.to\n${ptFormatName(f)}`, description: ptFormatDesc(f), behaviorHints: { notWebReady: true } });
        }
        console.log(`[STREAM] PT ${id}: ${streams.length} streams`);
        return { streams };
    }
    return { streams: [] };
});

// --- Custom HTTP server for all 5 addons ---
const addonInterfaces = {
    st: stBuilder.getInterface(),
    fs: fsBuilder.getInterface(),
    hs: hsBuilder.getInterface(),
    ws: wsBuilder.getInterface(),
    pt: ptBuilder.getInterface(),
};

function startAddonServer() {
    const server = http.createServer(async (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "*");
        if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

        const url = req.url.replace(/\?.*$/, "");

        // Route: /{prefix}/manifest.json or /{prefix}/{resource}/{type}/{id}.json
        // /configure on main port
        if (url === "/configure" || url === "/configure/" || url === "/" || url === "") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(getConfigHTML());
            return;
        }

        // Forward API endpoints on main port (same as proxy port)
        if (url.startsWith("/api/")) {
            // Forward to proxy handler by making internal HTTP request
            const proxyUrl = `http://127.0.0.1:${PROXY_PORT}${req.url}`;
            try {
                if (req.method === "POST") {
                    let body = "";
                    req.on("data", c => body += c);
                    req.on("end", async () => {
                        try {
                            const proxyResp = await axios.post(proxyUrl, body, {
                                headers: { "Content-Type": req.headers["content-type"] || "application/json" },
                                timeout: 30000, validateStatus: () => true,
                            });
                            res.writeHead(proxyResp.status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                            res.end(rewriteLocalUrls(typeof proxyResp.data === "string" ? proxyResp.data : JSON.stringify(proxyResp.data), req));
                        } catch (e) {
                            res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                            res.end(JSON.stringify({ error: e.message }));
                        }
                    });
                } else {
                    const proxyResp = await axios.get(proxyUrl, { timeout: 30000, validateStatus: () => true });
                    res.writeHead(proxyResp.status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                    res.end(rewriteLocalUrls(typeof proxyResp.data === "string" ? proxyResp.data : JSON.stringify(proxyResp.data), req));
                }
            } catch (e) {
                res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        const prefixMatch = url.match(/^\/(st|fs|hs|ws|pt)\/(.*)/);
        if (!prefixMatch) {
            res.writeHead(302, { "Location": "/configure" });
            res.end();
            return;
        }

        const prefix = prefixMatch[1];
        const subPath = "/" + prefixMatch[2];
        const iface = addonInterfaces[prefix];
        if (!iface) { res.writeHead(404); res.end("Unknown addon"); return; }

        // /manifest.json
        if (subPath === "/manifest.json") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(iface.manifest));
            return;
        }

        // /{resource}/{type}/{id}.json
        const match2 = subPath.match(/^\/([^/]+)\/([^/]+)\/([^/]+?)\.json$/);
        if (match2) {
            const [, resource, type, rawId] = match2;
            try {
                const result = await iface.get(resource, type, decodeURIComponent(rawId));
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(rewriteLocalUrls(JSON.stringify(result), req));
            } catch (e) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // /{resource}/{type}/{id}/{extra}.json
        const match3 = subPath.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+?)\.json$/);
        if (match3) {
            const [, resource, type, id, extraStr] = match3;
            const extra = {};
            for (const part of decodeURIComponent(extraStr).split("&")) {
                const eq = part.indexOf("=");
                if (eq > 0) extra[part.substring(0, eq)] = part.substring(eq + 1);
            }
            try {
                const result = await iface.get(resource, type, decodeURIComponent(id), extra);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(rewriteLocalUrls(JSON.stringify(result), req));
            } catch (e) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        res.writeHead(404); res.end("Not found");
    });

    addonServer = server;
    // 127.0.0.1 by default; 0.0.0.0 when LAN mode is enabled
    server.listen(ADDON_PORT, currentBindHost(), () => {
        console.log(`HTTP addon accessible at: http://${currentBindHost()}:${ADDON_PORT}/`);
    });
}

// ============ START ============

// Log in to all services using saved credentials (in parallel).
// Also used by the periodic re-login timer to refresh expired sessions.
async function loginAllFromConfig() {
    const jobs = [];
    if (config.stEmail && config.stPassword) jobs.push(login(config.stEmail, config.stPassword));
    else console.log("[LOGIN] SledujTeTo: žiadne uložené údaje - otvorte /configure");
    if (config.fsUsername && config.fsPassword) jobs.push(fsLogin(config.fsUsername, config.fsPassword));
    else console.log("[LOGIN] Fastshare: žiadne uložené údaje - otvorte /configure");
    if (config.wsUsername && config.wsPassword) jobs.push(wsLogin(config.wsUsername, config.wsPassword));
    else console.log("[LOGIN] Webshare: žiadne uložené údaje - otvorte /configure");
    if (config.ptEmail && config.ptPassword) jobs.push(ptLogin(config.ptEmail, config.ptPassword));
    else console.log("[LOGIN] Prehraj.to: žiadne uložené údaje - otvorte /configure");
    await Promise.allSettled(jobs);
}

async function start() {
    // Servers start FIRST so /configure is available immediately -
    // logins and catalog preload run in the background.
    startProxyServer();
    startAddonServer();

    (async () => {
        await loginAllFromConfig();

        // Preload (in parallel)
        console.log("[PRELOAD] Loading catalog...");
        const preloads = [];
        for (const q of ["2025", "2024", "CZ", "SK"]) {
            for (let p = 1; p <= 2; p++) preloads.push(fetchVideos(q, p));
        }
        await Promise.allSettled(preloads);
        console.log(`[PRELOAD] Cached ${Object.keys(urlCache).length} URLs`);
        console.log(`SledujTeTo premium: ${stPremium ? "✓" : "✗"}`);
        console.log(`Fastshare unlimited: ${fsUnlimited ? "✓" : "✗"}`);
        console.log(`Webshare VIP: ${wsVip ? "✓" : "✗"}`);
    })().catch(e => console.error("[START] Background init error:", e.message));

    // Sessions/tokens expire over time - refresh them every 6 hours
    setInterval(() => {
        console.log("[RELOGIN] Periodic session refresh...");
        loginAllFromConfig().catch(e => console.error("[RELOGIN] Error:", e.message));
    }, 6 * 3600 * 1000);

    console.log(`\n========================================`);
    console.log(`SledujTeTo:  http://127.0.0.1:${ADDON_PORT}/st/manifest.json`);
    console.log(`Fastshare:   http://127.0.0.1:${ADDON_PORT}/fs/manifest.json`);
    console.log(`Hellspy:     http://127.0.0.1:${ADDON_PORT}/hs/manifest.json`);
    console.log(`Webshare:    http://127.0.0.1:${ADDON_PORT}/ws/manifest.json`);
    console.log(`Prehraj.to:  http://127.0.0.1:${ADDON_PORT}/pt/manifest.json`);
    console.log(`========================================`);
}

start();
