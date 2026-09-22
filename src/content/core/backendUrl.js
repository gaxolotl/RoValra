// Resolves the base URLs used for RoValra backend requests.
//
// By default the extension talks to the official RoValra hosts. Users running a
// self-hosted backend can override them via the "Custom backend URL" setting
// (`CustomBackend`), which is stored flat in chrome.storage.local together with
// its child settings `customBackendApiUrl` and `customBackendWwwUrl`.
//
// If only the API URL is set, it is reused for the www/static host too, so a
// single unified backend (serving both `apis` and `www` routes) only needs one
// field filled in.

const ENABLED_KEY = 'CustomBackend';
const API_URL_KEY = 'customBackendApiUrl';
const WWW_URL_KEY = 'customBackendWwwUrl';

export const DEFAULT_API_BASE_URL = 'https://apis.rovalra.com';
export const DEFAULT_WWW_BASE_URL = 'https://www.rovalra.com';

let cache = null;

function normalizeBaseUrl(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(trimmed)) return '';
    try {
        // Base URLs must be origins; any path/query/fragment is dropped.
        return new URL(trimmed).origin;
    } catch {
        return '';
    }
}

function readStorage() {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
        return Promise.resolve({});
    }
    return chrome.storage.local.get([
        ENABLED_KEY,
        API_URL_KEY,
        WWW_URL_KEY,
    ]);
}

async function load() {
    if (cache) return cache;

    try {
        const stored = await readStorage();
        if (stored?.[ENABLED_KEY] !== true) {
            cache = { api: DEFAULT_API_BASE_URL, www: DEFAULT_WWW_BASE_URL };
            return cache;
        }

        const apiOverride = normalizeBaseUrl(stored?.[API_URL_KEY]);
        const wwwOverride =
            normalizeBaseUrl(stored?.[WWW_URL_KEY]) || apiOverride;

        cache = {
            api: apiOverride || DEFAULT_API_BASE_URL,
            www: wwwOverride || DEFAULT_WWW_BASE_URL,
        };
    } catch {
        cache = { api: DEFAULT_API_BASE_URL, www: DEFAULT_WWW_BASE_URL };
    }

    return cache;
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        if (
            changes[ENABLED_KEY] ||
            changes[API_URL_KEY] ||
            changes[WWW_URL_KEY]
        ) {
            cache = null;
        }
    });
}

export async function getBackendApiBaseUrl() {
    return (await load()).api;
}

export async function getBackendWwwBaseUrl() {
    return (await load()).www;
}

// `subdomain` is the RoValra subdomain the client would normally use: `apis`
// (default) or `www`. Roblox subdomains never reach this function.
export async function getBackendBaseUrlForSubdomain(subdomain) {
    const urls = await load();
    return subdomain === 'www' ? urls.www : urls.api;
}
