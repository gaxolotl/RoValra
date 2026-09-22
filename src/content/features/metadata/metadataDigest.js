// Canonical change hashes for verified metadata (digest v1).
//
// The backend publishes SHA-256 hashes of its verified game/user records at
// GET /v1/metadata/digests. Hashing our own sighting with byte-identical
// rules lets us skip uploads the backend would only discard, so bots never
// spend a Roblox call on data they already hold.
//
// Canonical form: `rovalra-meta-v1\n<entity_type>\n` followed by one
// `name=value\n` line per field in the order below, SHA-256 hex-encoded.
// Normalization mirrors the backend exactly:
//   - strings: trimmed, cut to the byte limit, missing -> ""
//   - integers: truncated toward zero, negatives clamped to 0, missing -> 0
//   - booleans: true/1/"1"/"true"/"yes" (case-insensitive) -> 1, else 0
//   - timestamps: ISO-8601 strings -> UTC epoch seconds, missing/unparseable -> ""
// When in doubt the caller uploads: a hash mismatch only ever costs
// bandwidth, never accuracy.

export const DIGEST_ID_CAP = 100;

function digestStr(value, limit) {
    if (value === undefined || value === null) return '';
    let text = String(value).trim();
    if (!text) return '';
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > limit) {
        text = new TextDecoder('utf-8', { fatal: false }).decode(
            bytes.slice(0, limit),
        );
    }
    return text;
}

function digestInt(value) {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? Math.max(0, value) : 0;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^[+-]?\d+$/.test(trimmed)) {
            const n = Number(trimmed);
            return Number.isSafeInteger(n) ? Math.max(0, n) : 0;
        }
        return 0;
    }
    return 0;
}

function digestBool(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        return /^(1|true|yes)$/i.test(value.trim());
    }
    return false;
}

function digestTime(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed || !/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return '';
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) return '';
    return String(Math.floor(ms / 1000));
}

function digestFields(entityType, meta) {
    const str = digestStr;
    const int = digestInt;
    const flag = (v) => (digestBool(v) ? '1' : '0');
    if (entityType === 'game') {
        return [
            ['universe_id', str(meta.universe_id, 32)],
            ['root_place_id', str(meta.root_place_id ?? meta.place_id, 32)],
            ['name', str(meta.name, 200)],
            ['description', str(meta.description, 2000)],
            ['creator_id', String(int(meta.creator_id ?? meta.creator?.id))],
            ['creator_name', str(meta.creator_name ?? meta.creator?.name, 100)],
            ['creator_type', str(meta.creator_type ?? meta.creator?.type, 24)],
            [
                'creator_verified',
                flag(
                    meta.creator_verified ??
                        meta.creator?.hasVerifiedBadge ??
                        false,
                ),
            ],
            ['created', digestTime(meta.created)],
            ['updated', digestTime(meta.updated)],
            ['playing', String(int(meta.playing))],
            ['visits', String(int(meta.visits))],
            ['favorites', String(int(meta.favorites ?? meta.favorited_count))],
            ['up_votes', String(int(meta.up_votes ?? meta.upVotes))],
            ['down_votes', String(int(meta.down_votes ?? meta.downVotes))],
            ['max_players', String(int(meta.max_players ?? meta.maxPlayers))],
            ['genre', str(meta.genre ?? meta.genre_l1, 100)],
        ];
    }
    return [
        ['user_id', str(meta.user_id, 32)],
        ['username', str(meta.username ?? meta.name, 100)],
        ['display_name', str(meta.display_name ?? meta.displayName, 100)],
        ['description', str(meta.description ?? meta.bio, 1000)],
        ['created', digestTime(meta.created)],
        ['is_banned', flag(meta.is_banned)],
        [
            'has_verified_badge',
            flag(meta.has_verified_badge ?? meta.hasVerifiedBadge),
        ],
        [
            'followers_count',
            String(int(meta.followers_count ?? meta.followersCount)),
        ],
        [
            'followings_count',
            String(int(meta.followings_count ?? meta.followingsCount)),
        ],
        ['friends_count', String(int(meta.friends_count ?? meta.friendsCount))],
    ];
}

export async function canonicalMetadataHash(entityType, meta) {
    let canonical = `rovalra-meta-v1\n${entityType}\n`;
    for (const [name, value] of digestFields(entityType, meta)) {
        canonical += `${name}=${value}\n`;
    }
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonical),
    );
    return [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}
