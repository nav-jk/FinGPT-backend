import { query } from './index.js';
import { randomUUID } from 'crypto';

// Users

export async function createUser() {
    const id = randomUUID();
    await query(
        `INSERT INTO users (id) VALUES ($1)`,
        [id]
    );
    return id;
}

export async function userExists(userId) {
    const result = await query(
        `SELECT id FROM users WHERE id = $1`,
        [userId]
    );
    return result.rows.length > 0;
}

// Conversations

export async function createConversation(userId, title) {
    const id = randomUUID();
    const result = await query(
        `INSERT INTO conversations (id, user_id, title)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [id, userId, title || 'New Conversation']
    );
    return result.rows[0];
}

export async function getConversation(conversationId) {
    const result = await query(
        `SELECT * FROM conversations WHERE id = $1`,
        [conversationId]
    );
    return result.rows[0] || null;
}

export async function getUserConversations(userId) {
    const result = await query(
        `SELECT id, title, message_count, created_at, updated_at
         FROM conversations
         WHERE user_id = $1
         ORDER BY updated_at DESC
         LIMIT 50`,
        [userId]
    );
    return result.rows;
}

export async function updateConversationTitle(conversationId, title) {
    await query(
        `UPDATE conversations SET title = $1, updated_at = NOW()
         WHERE id = $2`,
        [title, conversationId]
    );
}

// Messages

export async function saveMessages(conversationId, userContent, assistantContent) {
    // Save both in one transaction
    await query('BEGIN');
    try {
        await query(
            `INSERT INTO messages (conversation_id, role, content)
             VALUES ($1, 'user', $2), ($1, 'assistant', $3)`,
            [conversationId, userContent, assistantContent]
        );

        // Increment message count (counts pairs, so +2)
        const result = await query(
            `UPDATE conversations
             SET message_count = message_count + 2,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING message_count`,
            [conversationId]
        );

        await query('COMMIT');
        return result.rows[0].message_count;
    } catch (err) {
        await query('ROLLBACK');
        throw err;
    }
}

export async function getConversationHistory(conversationId, limit = 20) {
    const result = await query(
        `SELECT role, content, created_at
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at ASC
         LIMIT $2`,
        [conversationId, limit]
    );
    return result.rows;
}

// Returns history formatted for LLM (role + content only)
export async function getHistoryForLLM(conversationId, limit = 20) {
    const rows = await getConversationHistory(conversationId, limit);
    return rows.map(row => ({
        role: row.role,
        content: row.content
    }));
}

// Summary

export async function updateSummary(conversationId, summary) {
    await query(
        `UPDATE conversations SET summary = $1, updated_at = NOW()
         WHERE id = $2`,
        [summary, conversationId]
    );
}

export async function getSummary(conversationId) {
    const result = await query(
        `SELECT summary, message_count FROM conversations WHERE id = $1`,
        [conversationId]
    );
    return result.rows[0] || null;
}