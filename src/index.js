import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { tavily } from '@tavily/core';
import { OpenRouter } from '@openrouter/sdk';
import { randomUUID } from 'crypto';
import cors from 'cors';

import { getCompanyChart } from './services/chart.js';
import { SYSTEM_PROMPT, PROMPT_TEMPLATE } from './prompts/prompt.js';
import { CLEAN_QUERY_SYSTEM_PROMPT } from './prompts/clean.js';

import { runMigrations } from './db/migrations.js';
import {
    createUser,
    userExists,
    createConversation,
    getConversation,
    getUserConversations,
    saveMessages,
    getHistoryForLLM,
    getSummary,
    updateSummary
} from './db/conversations.js';
import {
    getCachedResults,
    cacheResults,
    normalizeQuery,
    deleteExpiredCache
} from './db/cache.js';
import {
    generateSummary,
    rewriteFollowUpQuery,
    classifyQuery
} from './services/llm.js';

const app = express();
const PORT = 3001;

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

app.use(express.json());
app.use(cors());  

//Startup 

await runMigrations();

// Clean expired cache entries every hour
setInterval(async () => {
    try {
        const deleted = await deleteExpiredCache();
        if (deleted > 0) console.log(`Cleaned ${deleted} expired cache entries`);
    } catch (err) {
        console.error('Cache cleanup error:', err.message);
    }
}, 60 * 60 * 1000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Search with cache: check cache first, fall back to Tavily, then save
async function searchWithCache(rawQuery, cleanedQuery) {
    const normalized = normalizeQuery(cleanedQuery);

    // 1. Cache hit?
    const cached = await getCachedResults(normalized);
    if (cached) {
        console.log(`Cache hit for: "${normalized}"`);
        return { results: cached.results, fromCache: true };
    }

    // 2. Tavily search
    console.log(`Cache miss — searching Tavily for: "${cleanedQuery}"`);
    const webres = await tvly.search(cleanedQuery);
    const topResults = webres.results.slice(0, 7);

    // 3. Classify for TTL, then cache
    const queryType = await classifyQuery(client, rawQuery);
    await cacheResults(rawQuery, normalized, topResults, queryType);

    return { results: topResults, fromCache: false };
}

// Build compact context string from search results
function buildContext(results) {
    return results
        .map((r, i) => `Result ${i + 1}\nTitle: ${r.title}\nURL: ${r.url}\nContent: ${r.content}`)
        .join('\n\n');
}

// Parse LLM JSON response safely
function parseResponse(text) {
    try {
        const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(clean);
    } catch {
        return { companyName: null, ticker: null, answer: text, followUps: [] };
    }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ message: 'Alive' }));

// Create or verify a user — call this when user first opens the app
app.post('/users', async (req, res) => {
    try {
        const { userId } = req.body;

        // If client sends existing userId, verify it exists
        if (userId) {
            const exists = await userExists(userId);
            if (exists) return res.json({ userId });
        }

        // Create new user
        const newUserId = await createUser();
        res.json({ userId: newUserId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Get all conversations for a user
app.get('/conversations', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ error: 'userId required' });

        const conversations = await getUserConversations(userId);
        res.json({ conversations });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Start a new conversation
app.post('/conversations', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId required' });

        const exists = await userExists(userId);
        if (!exists) return res.status(404).json({ error: 'User not found' });

        const conversation = await createConversation(userId);
        res.json({ conversation });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Main chat endpoint — first message in a conversation
app.post('/chat', async (req, res) => {
    try {
        const { userId, conversationId, query } = req.body;

        if (!userId || !query) {
            return res.status(400).json({ error: 'userId and query required' });
        }

        // Resolve or create conversation
        let convId = conversationId;
        if (!convId) {
            const conv = await createConversation(userId, query.slice(0, 60));
            convId = conv.id;
        }

        // 1. Clean query
        const cleanedQueryResponse = await client.chat.send({
            chatRequest: {
                model: 'openrouter/free',
                max_tokens: 100,
                messages: [
                    { role: 'system', content: CLEAN_QUERY_SYSTEM_PROMPT },
                    { role: 'user', content: query }
                ]
            }
        });
        const cleanedQuery = cleanedQueryResponse.choices[0].message.content.trim();
        console.log('Cleaned Query:', cleanedQuery);

        // 2. Search (with cache)
        const { results, fromCache } = await searchWithCache(query, cleanedQuery);
        const context = buildContext(results);

        // 3. Generate answer
        const prompt = PROMPT_TEMPLATE
            .replace('{{USER_QUERY}}', query)
            .replace('{{WEB_SEARCH_RESULTS}}', context);

        const completion = await client.chat.send({
            chatRequest: {
                model: 'openrouter/free',
                max_tokens: 1000,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: prompt }
                ]
            }
        });

        const parsedResponse = parseResponse(completion.choices[0].message.content);

        // 4. Save messages — store only the answer text, not the full JSON blob
        const messageCount = await saveMessages(convId, query, parsedResponse.answer);

        // 5. Summarize every 10 messages to keep context lean
        if (messageCount % 10 === 0) {
            const { summary: existingSummary } = await getSummary(convId) || {};
            const history = await getHistoryForLLM(convId, 10);
            const newSummary = await generateSummary(client, existingSummary, history);
            await updateSummary(convId, newSummary);
        }

        // 6. Chart
        const chartData = await getCompanyChart(parsedResponse.companyName);

        res.json({
            conversationId: convId,
            query,
            fromCache,
            companyName: parsedResponse.companyName,
            ticker: parsedResponse.ticker,
            answer: parsedResponse.answer,
            followUps: parsedResponse.followUps,
            chart: chartData,
            sources: results.map(r => ({ title: r.title, url: r.url }))
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Search failed', message: err.message });
    }
});

// Follow-up endpoint — uses conversation history for context
app.post('/chat/follow_up', async (req, res) => {
    try {
        const { conversationId, query } = req.body;

        if (!conversationId || !query) {
            return res.status(400).json({ error: 'conversationId and query required' });
        }

        const conv = await getConversation(conversationId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        // 1. Load history and summary
        const history = await getHistoryForLLM(conversationId, 20);
        const { summary } = await getSummary(conversationId) || {};

        // 2. Rewrite vague follow-up into a standalone search query
        const standaloneQuery = await rewriteFollowUpQuery(client, summary, history, query);
        console.log('Follow-up rewritten to:', standaloneQuery);

        // 3. Clean the rewritten query
        const cleanedQueryResponse = await client.chat.send({
            chatRequest: {
                model: 'openrouter/free',
                max_tokens: 100,
                messages: [
                    { role: 'system', content: CLEAN_QUERY_SYSTEM_PROMPT },
                    { role: 'user', content: standaloneQuery }
                ]
            }
        });
        const cleanedQuery = cleanedQueryResponse.choices[0].message.content.trim();

        // 4. Search with cache
        const { results, fromCache } = await searchWithCache(standaloneQuery, cleanedQuery);
        const context = buildContext(results);

        // 5. Build messages array:
        //    - If summary exists, use it as compact context instead of raw history
        //    - Append fresh search results + follow-up
        const systemContext = summary
            ? `You have the following context from earlier in the conversation:\n${summary}`
            : null;

        // Only send last 6 raw messages if no summary (avoids token bloat)
        const historyToSend = summary ? [] : history.slice(-6);

        const followUpPrompt = PROMPT_TEMPLATE
            .replace('{{USER_QUERY}}', query)
            .replace('{{WEB_SEARCH_RESULTS}}', context);

        const messages = [
            ...(systemContext ? [{ role: 'user', content: systemContext }, { role: 'assistant', content: 'Understood, I have the context.' }] : []),
            ...historyToSend,
            { role: 'user', content: followUpPrompt }
        ];

        const completion = await client.chat.send({
            chatRequest: {
                model: 'openrouter/free',
                max_tokens: 1000,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    ...messages
                ]
            }
        });

        const parsedResponse = parseResponse(completion.choices[0].message.content);

        // 6. Save follow-up exchange
        const messageCount = await saveMessages(conversationId, query, parsedResponse.answer);

        // 7. Summarize if needed
        if (messageCount % 10 === 0) {
            const { summary: existingSummary } = await getSummary(conversationId) || {};
            const fullHistory = await getHistoryForLLM(conversationId, 10);
            const newSummary = await generateSummary(client, existingSummary, fullHistory);
            await updateSummary(conversationId, newSummary);
        }

        const chartData = await getCompanyChart(parsedResponse.companyName);

        res.json({
            conversationId,
            query,
            standaloneQuery,
            fromCache,
            companyName: parsedResponse.companyName,
            ticker: parsedResponse.ticker,
            answer: parsedResponse.answer,
            followUps: parsedResponse.followUps,
            chart: chartData,
            sources: results.map(r => ({ title: r.title, url: r.url }))
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Follow-up failed', message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});