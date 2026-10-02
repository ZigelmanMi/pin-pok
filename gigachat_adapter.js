// GigaChat API adapter for PokerSkill
// Uses Sber GigaChat LLM with token-based authentication

const GIGACHAT_API_BASE = 'https://gigachat.devices.sberbank.ru/api/';
const GIGACHAT_AUTH_URL = 'https://ngw.devices.sber.ai:9443/api/v2/auth';
const GIGACHAT_CHAT_URL = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';

// Token scope for GigaChat authentication
const GIGACHAT_SCOPE = 'GIGACHAT_API_PERS';

class GigaChatAdapter {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.accessToken = null;
    this.tokenExpiry = 0;
    this.model = 'GigaChat'; // Default model, can be overridden
    this.maxTokens = 1024;
    this.temperature = 0.3;
    this.conversations = new Map();
    this.maxConversations = 5;
  }

  /**
   * Get or refresh GigaChat access token
   */
  async getAccessToken() {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiry - 60000) {
      return this.accessToken;
    }

    try {
      const response = await fetch(GIGACHAT_AUTH_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'RqUID': this.generateRqUID(),
        },
        body: JSON.stringify({ scope: GIGACHAT_SCOPE })
      });

      if (!response.ok) {
        throw new Error(`Auth failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      this.accessToken = data.access_token;
      // Token typically valid for 60 minutes, refresh 5 min early
      this.tokenExpiry = now + (data.expires_in * 1000) - 60000;
      return this.accessToken;
  } catch (error) {
    console.error('GigaChat auth error:', error);
    this.accessToken = null;
    this.tokenExpiry = 0;
    throw error;
  }
  }

  generateRqUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  /**
   * Get conversation history for a hand
   */
  getConversation(handId) {
    if (!this.conversations.has(handId)) {
      if (this.conversations.size >= this.maxConversations) {
        const oldestKey = this.conversations.keys().next().value;
        this.conversations.delete(oldestKey);
      }
      this.conversations.set(handId, []);
    }
    return this.conversations.get(handId);
  }

  /**
   * Call GigaChat API with system and user prompts
   * Returns the LLM response as a string
   */
  async chat(handId, systemPrompt, userPrompt, maxRetries = 2) {
    const conversation = this.getConversation(handId);
    
    // Add user message to history
    conversation.push({ role: 'user', content: userPrompt });

    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversation
    ];

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const accessToken = await this.getAccessToken();
        
        const response = await fetch(GIGACHAT_CHAT_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-RqUID': this.generateRqUID(),
          },
          body: JSON.stringify({
            model: this.model,
            messages: messages,
            max_tokens: this.maxTokens,
            temperature: this.temperature,
            stream: false,
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          // Check if retriable error
          if (this.isRetriableError(response.status, errorText)) {
            const waitTime = Math.min(2 ** attempt, 30) * 1000;
            console.warn(`GigaChat retry ${attempt + 1}/${maxRetries} in ${waitTime}ms: ${errorText.substring(0, 120)}`);
            await this.sleep(waitTime);
            continue;
          }
          throw new Error(`Chat failed: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        
        // Extract assistant response
        let assistantContent = '';
        if (data.result && data.result.choices && data.result.choices.length > 0) {
          const choice = data.result.choices[0];
          assistantContent = choice.message?.content || choice.text || '';
        }

        // Add assistant response to conversation history
        conversation.push({ role: 'assistant', content: assistantContent });

        return assistantContent;

      } catch (error) {
        // Remove user message if retrying
        if (conversation.length && conversation[conversation.length - 1].role === 'user') {
          conversation.pop();
        }
        const msg = String((error && error.message) || error);
        if (/failed to fetch|networkerror|err_cert|err_connection|err_name_not_resolved/i.test(msg)) {
          throw error;
        }
        if (attempt === maxRetries - 1) {
          console.error(`GigaChat final retry failed for hand#${handId}:`, error);
          throw error;
        }

        const waitTime = Math.min(2 ** attempt, 8) * 1000;
        console.warn(`GigaChat retry ${attempt + 1}/${maxRetries} for hand#${handId} in ${waitTime}ms`);
        await this.sleep(waitTime);
      }
    }
  }

  /**
   * Check if error is retriable
   */
  isRetriableError(status, errorText) {
    const retriableStatuses = [429, 502, 503, 504, 524];
    const retriableKeywords = ['Connection error', 'timed out', 'overloaded'];
    
    if (retriableStatuses.includes(status)) return true;
    return retriableKeywords.some(kw => errorText.toLowerCase().includes(kw.toLowerCase()));
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * End a hand conversation (cleanup)
   */
  endHand(handId) {
    this.conversations.delete(handId);
  }

  /**
   * Parse LLM response for poker action
   * Expects JSON with action field: f/fold, k/check, c/call, b/bet/raise
   */
  parseAction(response) {
    try {
      // Try to parse as JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        if (data.action) {
          return {
            action: this.normalizeAction(data.action),
            amount: data.amount || null,
            reasoning: data.reasoning || data.explanation || ''
          };
        }
      }

      // Fallback: try to detect action from text
      const lower = response.toLowerCase();
      if (lower.includes('fold') || lower.includes('f') || lower.includes('пас')) {
        return { action: 'FOLD', amount: 0, reasoning: response.substring(0, 100) };
      }
      if (lower.includes('check') || lower.includes('k') || lower.includes('чек') || lower.includes('пас')) {
        return { action: 'CHECK', amount: 0, reasoning: response.substring(0, 100) };
      }
      if (lower.includes('call') || lower.includes('c') || lower.includes('колл') || lower.includes('кол')) {
        return { action: 'CALL', amount: null, reasoning: response.substring(0, 100) };
      }
      if (lower.includes('bet') || lower.includes('raise') || lower.includes('b') || lower.includes('бет') || lower.includes('рейз')) {
        return { action: 'RAISE', amount: null, reasoning: response.substring(0, 100) };
      }

      // Default: return raw response
      return { action: 'UNKNOWN', amount: null, reasoning: response };
    } catch (error) {
      console.error('Error parsing poker action:', error);
      return { action: 'UNKNOWN', amount: null, reasoning: response.substring(0, 200) };
    }
  }

  normalizeAction(action) {
    const map = {
      'f': 'FOLD', 'fold': 'FOLD', 'пас': 'FOLD',
      'k': 'CHECK', 'check': 'CHECK', 'чек': 'CHECK',
      'c': 'CALL', 'call': 'CALL', 'колл': 'CALL', 'кол': 'CALL',
      'b': 'RAISE', 'bet': 'RAISE', 'raise': 'RAISE', 'бет': 'RAISE', 'рейз': 'RAISE'
    };
    return map[action.toLowerCase()] || action.toUpperCase();
  }

  /**
   * Close all connections
   */
  async close() {
    this.conversations.clear();
  }
}
