import { callRobloxApi } from '../../core/api.js';
import {
    getPlaceIdFromUrl,
    getUniverseIdFromUrl,
    getUserIdFromUrl,
} from '../../core/idExtractor.js';
import { getPlaceDetails, getUniversesDetails } from '../../core/apis/games.js';
import { getUserFullData } from '../../core/apis/users.js';

let isInitialized = false;
// Last payload sent per entity, so unchanged values are not re-reported but
// genuine changes on later visits are.
const sentPayloads = new Map();

// Adaptive transport: reports go out immediately with no cap. Only when the
// backend signals trouble (rate limits, repeated errors) do we back off and
// temporarily cap feed batches. Identical payloads are still sent once, so a
// page that re-renders the same listing does not spam the backend.
const transport = {
    failures: 0,
    cooldownUntil: 0,
    capped: false,
    warnedOutdated: false,
};
const DEGRADED_FEED_CAP = 25;

function isOptedIn() {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get(
                { MetadataSharingEnabled: false },
                (settings) => resolve(settings.MetadataSharingEnabled === true),
            );
        } catch (error) {
            resolve(false);
        }
    });
}

function cleanTitle() {
    return (document.title || '').replace(/\s*[-|]\s*Roblox\s*$/i, '').trim();
}

function pick(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'string' && value.trim() === '') return fallback;
    return value;
}

import { DIGEST_ID_CAP, canonicalMetadataHash } from './metadataDigest.js';

function entityIdOf(item) {
    return String(item.metadata.universe_id || item.metadata.user_id || '');
}

// Drops items whose sighting already matches the backend's verified record.
// Items without a digest (never verified) and anything we cannot prove
// unchanged are kept. Digest misses only cost an upload.
async function filterUnchanged(fresh) {
    const gameIds = [];
    const userIds = [];
    for (const entry of fresh) {
        const id = entityIdOf(entry);
        if (!id) continue;
        if (entry.report.entity_type === 'game') {
            if (gameIds.length < DIGEST_ID_CAP) gameIds.push(id);
        } else if (entry.report.entity_type === 'user') {
            if (userIds.length < DIGEST_ID_CAP) userIds.push(id);
        }
    }
    if (!gameIds.length && !userIds.length) return fresh;
    let digests = null;
    try {
        const qs = new URLSearchParams();
        if (gameIds.length) qs.set('game_ids', gameIds.join(','));
        if (userIds.length) qs.set('user_ids', userIds.join(','));
        const response = await callRobloxApi({
            isRovalraApi: true,
            subdomain: 'apis',
            endpoint: `/v1/metadata/digests?${qs.toString()}`,
            method: 'GET',
            skipAutoAuth: true,
            credentials: 'omit',
            noCache: true,
        });
        if (!response.ok) return fresh;
        digests = await response.json();
    } catch {
        return fresh;
    }
    const keep = [];
    for (const entry of fresh) {
        const id = entityIdOf(entry);
        const table =
            entry.report.entity_type === 'game'
                ? digests?.games
                : digests?.users;
        const known = table ? table[id] : null;
        if (!known || !known.hash) {
            keep.push(entry);
            continue;
        }
        try {
            const local = await canonicalMetadataHash(
                entry.report.entity_type,
                entry.report.metadata,
            );
            if (local !== known.hash) keep.push(entry);
        } catch {
            keep.push(entry);
        }
    }
    return keep;
}

// Sends a whole listing in one request: items are { entity_type, metadata }.
// Identical payloads are still sent once, so a page that re-renders the same
// listing does not spam the backend.
async function reportBatch(items) {
    if (!Array.isArray(items) || !items.length) return;
    const fresh = [];
    for (const item of items) {
        if (!item || !item.metadata) continue;
        const key = `${item.entity_type}:${item.metadata.universe_id || item.metadata.user_id || ''}`;
        const payload = JSON.stringify({
            schema_version: 1,
            entity_type: item.entity_type,
            metadata: item.metadata,
        });
        if (sentPayloads.get(key) === payload) continue;
        sentPayloads.set(key, payload);
        fresh.push({
            key,
            report: { entity_type: item.entity_type, metadata: item.metadata },
        });
    }
    if (!fresh.length) return;

    const toSend = await filterUnchanged(fresh);
    if (!toSend.length) return;

    const wait =
        Date.now() < transport.cooldownUntil
            ? transport.cooldownUntil - Date.now()
            : 0;
    if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
    }

    let response = null;
    try {
        response = await callRobloxApi({
            isRovalraApi: true,
            subdomain: 'apis',
            endpoint: '/v1/metadata/report-batch',
            method: 'POST',
            body: {
                schema_version: 1,
                reports: toSend.map((entry) => entry.report),
            },
            skipAutoAuth: true,
            credentials: 'omit',
            noCache: true,
        });
    } catch (networkError) {
        // Never delivered: allow a later sighting to retry, and back off.
        for (const entry of toSend) sentPayloads.delete(entry.key);
        noteTransportFailure(0);
        console.error(networkError);
        return;
    }

    if (response.ok) {
        noteTransportSuccess();
        return;
    }
    if (response.status === 400) {
        // Backend rejected the batch itself; resending identical bytes is
        // pointless, so keep it deduped.
        console.error('RoValra: metadata batch rejected (400).');
        return;
    }
    // Anything else may be transient (or an outdated backend): allow a later
    // sighting to retry, and back off.
    for (const entry of toSend) sentPayloads.delete(entry.key);
    noteTransportFailure(response.status);
    if (response.status === 404 && !transport.warnedOutdated) {
        transport.warnedOutdated = true;
        console.warn(
            'RoValra: backend rejected metadata reports (404). Rebuild and restart the backend so POST /v1/metadata/report-batch exists.',
        );
    }
}

function noteTransportSuccess() {
    transport.failures = 0;
    transport.capped = false;
    transport.cooldownUntil = 0;
}

function noteTransportFailure(status) {
    transport.failures += 1;
    if (status === 429 || transport.failures >= 3) {
        transport.capped = true;
    }
    const backoff = Math.min(
        5 * 60 * 1000,
        5000 * 2 ** Math.min(transport.failures, 6),
    );
    transport.cooldownUntil = Date.now() + backoff;
}

function numId(value) {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return /^\d+$/.test(trimmed) && Number(trimmed) > 0 ? trimmed : null;
    }
    return null;
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== ''
        ? value.trim()
        : null;
}

// Walks an intercepted discovery payload and pulls public game listings
// (universe id plus whatever name/counts travel with it). Viewer-specific
// fields such as votes, favorites and presence are never read.
function collectFeedGames(node, out, seen) {
    if (!node) return;
    if (Array.isArray(node)) {
        for (const item of node) {
            collectFeedGames(item, out, seen);
        }
        return;
    }
    if (typeof node !== 'object') return;
    const universeId = numId(node.universeId ?? node.universe_id);
    if (universeId && !seen.has(universeId)) {
        seen.add(universeId);
        const game = { universe_id: universeId };
        const name = nonEmptyString(node.name);
        if (name) game.name = name;
        const rootPlace = numId(
            node.rootPlaceId ??
                node.root_place_id ??
                node.placeId ??
                node.place_id,
        );
        if (rootPlace) game.root_place_id = rootPlace;
        const playing = Number(node.playing ?? node.playerCount);
        if (Number.isSafeInteger(playing) && playing >= 0) {
            game.playing = playing;
        }
        out.push(game);
    }
    for (const value of Object.values(node)) {
        collectFeedGames(value, out, seen);
    }
}

// A user-like object carries a user id without any game id. The id+name pair
// alone is not enough (sorts and treatments look like that), so a bare id
// only counts when a username/display name travels with it. User search
// answers carry the id in contentId.
function isFeedUser(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    if ('universeId' in node || 'universe_id' in node) return false;
    if (numId(node.userId ?? node.user_id ?? node.contentId)) return true;
    return (
        numId(node.id) !== null &&
        (typeof node.displayName === 'string' ||
            typeof node.username === 'string')
    );
}

function feedUserMetadata(node) {
    const metadata = {
        user_id: numId(
            node.userId ?? node.user_id ?? node.contentId ?? node.id,
        ),
    };
    // previousUsernames and any other history are skipped.
    const username = nonEmptyString(node.username ?? node.name);
    if (username) metadata.username = username;
    const displayName = nonEmptyString(node.displayName);
    if (displayName) metadata.display_name = displayName;
    if (typeof node.hasVerifiedBadge === 'boolean') {
        metadata.has_verified_badge = node.hasVerifiedBadge;
    }
    return metadata;
}

function collectFeedUsers(node, out, seen) {
    if (!node) return;
    if (Array.isArray(node)) {
        for (const item of node) {
            collectFeedUsers(item, out, seen);
        }
        return;
    }
    if (typeof node !== 'object') return;
    if (isFeedUser(node)) {
        const metadata = feedUserMetadata(node);
        if (!seen.has(metadata.user_id)) {
            seen.add(metadata.user_id);
            out.push(metadata);
        }
    }
    for (const value of Object.values(node)) {
        collectFeedUsers(value, out, seen);
    }
}

function handleDiscoveryFeed(event) {
    const { url, data } = event.detail || {};
    if (typeof url !== 'string' || !data) return;
    isOptedIn().then((optedIn) => {
        if (!optedIn) return;
        try {
            // User search answers on omni-search, not on users.roblox.com.
            const isUserFeed =
                url.includes('users.roblox.com') ||
                url.includes('verticalType=user');
            if (isUserFeed) {
                const users = [];
                collectFeedUsers(data, users, new Set());
                const batch = transport.capped
                    ? users.slice(0, DEGRADED_FEED_CAP)
                    : users;
                reportBatch(
                    batch.map((metadata) => ({
                        entity_type: 'user',
                        metadata,
                    })),
                );
            } else {
                const games = [];
                collectFeedGames(data, games, new Set());
                const batch = transport.capped
                    ? games.slice(0, DEGRADED_FEED_CAP)
                    : games;
                reportBatch(
                    batch.map((metadata) => ({
                        entity_type: 'game',
                        metadata,
                    })),
                );
            }
        } catch (error) {
            console.error(error);
        }
    });
}

async function reportCurrentGame() {
    const placeId = getPlaceIdFromUrl();
    if (!placeId || !/^\d+$/.test(placeId)) return;

    const meta = document.querySelector('#game-detail-meta-data');
    let universeId =
        meta?.dataset?.universeId || getUniverseIdFromUrl() || null;
    let rootPlaceId = meta?.dataset?.rootPlaceId || null;

    const place = await getPlaceDetails(placeId).catch(() => null);
    if (!universeId && place?.universeId) {
        universeId = String(place.universeId);
    }
    if (!universeId) return;
    if (!rootPlaceId) {
        rootPlaceId = place?.universeRootPlaceId
            ? String(place.universeRootPlaceId)
            : placeId;
    }

    const universes = await getUniversesDetails([universeId]).catch(() => []);
    const universe = Array.isArray(universes) ? universes[0] : null;
    const creator = universe?.creator || null;

    await reportBatch([
        {
            entity_type: 'game',
            metadata: {
                universe_id: String(universe?.id ?? universeId),
                root_place_id: String(
                    universe?.rootPlaceId ?? rootPlaceId ?? placeId,
                ),
                place_id: String(placeId),
                name: pick(universe?.name, pick(place?.name, cleanTitle())),
                creator_id: pick(creator?.id, place?.builderId),
                creator_name: pick(creator?.name, place?.builder),
                creator_type: pick(creator?.type, null),
                creator_verified: Boolean(
                    creator?.hasVerifiedBadge ??
                    place?.hasVerifiedBadge ??
                    false,
                ),
                created: pick(universe?.created, null),
                updated: pick(universe?.updated, null),
                playing: pick(universe?.playing, null),
                visits: pick(universe?.visits, null),
                favorites: pick(
                    universe?.favoritedCount,
                    universe?.favouriteCount,
                    null,
                ),
                max_players: pick(universe?.maxPlayers, null),
                genre: pick(universe?.genre, universe?.genre_l1, null),
            },
        },
    ]);
}

async function reportCurrentUser() {
    const userId = getUserIdFromUrl();
    if (!userId || !/^\d+$/.test(userId)) return;
    const data = await getUserFullData(userId).catch(() => null);
    if (!data || data.id === undefined) return;

    await reportBatch([
        {
            entity_type: 'user',
            metadata: {
                user_id: String(data.id),
                username: pick(data.name, null),
                display_name: pick(data.displayName, null),
                created: pick(data.created, null),
                is_banned: Boolean(data.isBanned ?? false),
                has_verified_badge: Boolean(data.hasVerifiedBadge ?? false),
            },
        },
    ]);
}

async function reportForPage() {
    if (!(await isOptedIn())) return;
    const path = window.location.pathname.toLowerCase();
    const normalized = path.replace(/^\/[a-z]{2}(?:-[a-z]{2})?\//, '/');
    try {
        if (normalized.startsWith('/games/')) {
            await reportCurrentGame();
        } else if (
            normalized.startsWith('/users/') ||
            normalized.startsWith('/banned-users/')
        ) {
            await reportCurrentUser();
        }
    } catch (error) {
        console.error(error);
    }
}

export function init() {
    if (isInitialized) return;
    isInitialized = true;
    document.addEventListener(
        'rovalra-discovery-feed-response',
        handleDiscoveryFeed,
    );
    reportForPage();
    window.addEventListener('rovalra:urlChanged', reportForPage);
}
