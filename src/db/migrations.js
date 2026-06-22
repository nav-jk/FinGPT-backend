import { query } from './index.js';

export async function runMigrations() {
    console.log('Running migrations...');

    // Users table - anonymous UUID-based users
    await query(`
        CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);

    // Conversations table
    await query(`
        CREATE TABLE IF NOT EXISTS conversations (
            id UUID PRIMARY KEY,
            user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            title TEXT,
            summary TEXT,
            message_count INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )
    `);

    // Messages table - stores only text content, not full JSON blobs
    await query(`
        CREATE TABLE IF NOT EXISTS messages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
            role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);

    // Search cache with TTL support
    // normalized_query = cleaned lowercase version for exact match
    await query(`
        CREATE TABLE IF NOT EXISTS search_cache (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            original_query TEXT NOT NULL,
            normalized_query TEXT NOT NULL,
            results JSONB NOT NULL,
            query_type VARCHAR(30) DEFAULT 'market_news',
            created_at TIMESTAMP DEFAULT NOW(),
            expires_at TIMESTAMP NOT NULL
        )
    `);

    // Index for fast cache lookups
    await query(`
        CREATE INDEX IF NOT EXISTS idx_search_cache_normalized
        ON search_cache(normalized_query, expires_at)
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversation_id, created_at ASC)
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_conversations_user
        ON conversations(user_id, updated_at DESC)
    `);

    console.log('Migrations complete.');
}