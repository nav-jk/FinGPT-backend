// Rolling Summary
// Called every 10 messages to compress history into a summary.
// This prevents sending 100 raw messages to the LLM on every follow-up.

export async function generateSummary(client, existingSummary, recentMessages) {
    const messagesText = recentMessages
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n');

    const prompt = existingSummary
        ? `Previous summary:\n${existingSummary}\n\nNew messages:\n${messagesText}\n\nUpdate the summary to include the new messages. Keep it concise (max 200 words). Focus on: companies discussed, topics covered, key facts mentioned.`
        : `Summarize this conversation in max 150 words. Focus on: companies discussed, topics covered, key facts mentioned.\n\n${messagesText}`;

    const response = await client.chat.send({
        chatRequest: {
            model: 'openrouter/free',
            max_tokens: 300,
            messages: [
                {
                    role: 'system',
                    content: 'You are a concise summarizer for financial conversations. Extract key entities (companies, tickers), topics discussed, and important facts. Output plain text, no JSON.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ]
        }
    });

    return response.choices[0].message.content.trim();
}

// Follow-up Query Rewrite
// Turns vague follow-ups like "What about next quarter?" into
// standalone searchable queries like "Tata Motors Q4 FY27 outlook"

export async function rewriteFollowUpQuery(client, conversationSummary, recentHistory, followUpQuestion) {
    const context = conversationSummary
        ? `Conversation summary:\n${conversationSummary}`
        : `Recent conversation:\n${recentHistory.slice(-4).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')}`;

    const response = await client.chat.send({
        chatRequest: {
            model: 'openrouter/free',
            max_tokens: 80,
            messages: [
                {
                    role: 'system',
                    content: 'You rewrite follow-up questions into standalone search queries. Output ONLY the rewritten query, nothing else. No explanation, no punctuation at end.'
                },
                {
                    role: 'user',
                    content: `${context}\n\nFollow-up question: "${followUpQuestion}"\n\nRewrite as a standalone web search query:`
                }
            ]
        }
    });

    return response.choices[0].message.content.trim();
}

// Query Type Classification
// Used to assign appropriate cache TTL.

export async function classifyQuery(client, query) {
    const response = await client.chat.send({
        chatRequest: {
            model: 'openrouter/free',
            max_tokens: 20,
            messages: [
                {
                    role: 'system',
                    content: 'Classify the query into exactly one category. Reply with ONLY the category name, nothing else.\nCategories: breaking_news, market_news, company_info, educational'
                },
                {
                    role: 'user',
                    content: query
                }
            ]
        }
    });

    const raw = response.choices[0].message.content.trim().toLowerCase();
    const valid = ['breaking_news', 'market_news', 'company_info', 'educational'];
    return valid.includes(raw) ? raw : 'market_news';
}