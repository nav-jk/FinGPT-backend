import { query } from './index.js';

// TTL by query type
// Stock/breaking news expires fast; fundamentals and definitions live longer.

const TTL_MINUTES = {
    breaking_news:  60,          // 1 hour
    market_news:    60 * 4,      // 4 hours
    company_info:   60 * 24,     // 1 day
    educational:    60 * 24 * 30 // 30 days
};

function getExpiresAt(queryType) {
    const minutes = TTL_MINUTES[queryType] ?? TTL_MINUTES.market_news;
    const date = new Date();
    date.setMinutes(date.getMinutes() + minutes);
    return date;
}

// Normalize: lowercase, strip punctuation, collapse spaces
export function normalizeQuery(q) {
    return q
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Cache lookup

export async function getCachedResults(normalizedQuery) {
    const result = await query(
        `SELECT results, query_type, expires_at
         FROM search_cache
         WHERE normalized_query = $1
           AND expires_at > NOW()
         ORDER BY created_at DESC
         LIMIT 1`,
        [normalizedQuery]
    );
    return result.rows[0] || null;
}

// Cache save 

export async function cacheResults(originalQuery, normalizedQuery, results, queryType = 'market_news') {
    const expiresAt = getExpiresAt(queryType);

    // Upsert: if same normalized query exists and hasn't expired, replace it
    await query(
        `INSERT INTO search_cache (original_query, normalized_query, results, query_type, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [originalQuery, normalizedQuery, JSON.stringify(results), queryType, expiresAt]
    );
}

// Cleanup

export async function deleteExpiredCache() {
    const result = await query(
        `DELETE FROM search_cache WHERE expires_at <= NOW()`
    );
    return result.rowCount;
}