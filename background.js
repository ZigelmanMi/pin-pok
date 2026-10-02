// Background service worker
// Handles poker solver logic and communication with content script
// iframe injection is handled by content.js via direct DOM access

importScripts(
  'gigachat_adapter.js',
  'poker_skill_prompts.js',
  'gto_preflop.js',
  'monte_carlo.js'
);

var GIGACHAT_API_KEY = '';
try { importScripts('secrets.js'); } catch (e) { /* optional, see secrets.example.js */ }
const gigachat = new GigaChatAdapter(GIGACHAT_API_KEY);
gigachat.model = 'GigaChat';
gigachat.maxTokens = 1024;
gigachat.temperature = 0.3;
let gigachatDown = false;

// Hand counter for unique hand IDs
let handCounter = 0;
let lastShot = { dataUrl: null, at: 0, cards: null };
const PY_VISION = 'http://127.0.0.1:8765/read';

// Domains hosting the poker game iframe
const IFRAME_URL_PATTERNS = ['pu-web2.e5t.online', '.e5t.online'];

// ===== AUTO-INJECTION (fallback if manifest content_scripts fail) =====

// Hostnames where the poker game appears
const GAME_FRAME_RE = /e5t\.online|pu-web2/i;

function isHttpTab(url) {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch (e) {
    return false;
  }
}

function hostMatches(url) {
  return isHttpTab(url);
}

function isGameFrameUrl(url) {
  return GAME_FRAME_RE.test(url || '');
}

function broadcastToTab(tabId, message) {
  chrome.webNavigation.getAllFrames({ tabId: tabId }).then((frames) => {
    (frames || []).forEach((f) => {
      try {
        chrome.tabs.sendMessage(tabId, message, { frameId: f.frameId }, function () {
          void chrome.runtime.lastError;
        });
      } catch (e) { /* ignore */ }
    });
  }).catch(() => {});
}

function broadcastShot(tabId, dataUrl) {
  broadcastToTab(tabId, { action: 'tableShot', dataUrl: dataUrl });
}

function broadcastCards(tabId, cards) {
  broadcastToTab(tabId, { action: 'shotCards', data: cards });
}

let hudWindowId = null;
let hudDismissed = false;
let lastHud = { state: null, extra: {}, response: null, dead: false };

function findHudWindow() {
  return chrome.windows.getAll({ populate: true, windowTypes: ['popup'] }).then((wins) => {
    for (const w of wins || []) {
      const tab = (w.tabs || [])[0];
      if (tab && tab.url && tab.url.indexOf('hud.html') !== -1) return w.id;
    }
    return null;
  }).catch(() => null);
}

function fanoutHud() {
  chrome.runtime.sendMessage({ action: 'hudRender', hud: lastHud }, function () {
    void chrome.runtime.lastError;
  });
}

function applyHud(partial) {
  if (!partial) return;
  if (partial.state) lastHud.state = partial.state;
  if (partial.extra) lastHud.extra = partial.extra;
  if (partial.response !== undefined) lastHud.response = partial.response;
  if (partial.dead) lastHud.dead = true;
  else if (partial.state) lastHud.dead = false;
  fanoutHud();
}

async function openHudWindow(focus) {
  if (hudDismissed && !focus) return;
  if (focus) hudDismissed = false;
  const existing = hudWindowId || await findHudWindow();
  if (existing) {
    hudWindowId = existing;
    if (focus) {
      try { await chrome.windows.update(existing, { focused: true }); } catch (e) { /* ignore */ }
    }
    fanoutHud();
    return;
  }
  let left = 40;
  let top = 80;
  try {
    const win = await chrome.windows.getLastFocused();
    if (win) {
      left = (win.left || 0) + (win.width || 0) + 12;
      top = (win.top || 0) + 48;
      if (left > 1500) left = Math.max(8, (win.left || 0) - 372);
    }
  } catch (e) { /* ignore */ }
  try {
    const created = await chrome.windows.create({
      url: chrome.runtime.getURL('hud.html'),
      type: 'popup',
      focused: !!focus,
      width: 360,
      height: 580,
      left: left,
      top: top
    });
    hudWindowId = created && created.id;
  } catch (e) {
    console.warn('[PokerAssistant] hud window:', (e && e.message) || e);
  }
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === hudWindowId) {
    hudWindowId = null;
    hudDismissed = true;
  }
});

function pyCardsUseful(cards) {
  if (!cards) return false;
  return (cards.myCards && cards.myCards.length >= 2) ||
    (cards.communityCards && cards.communityCards.length > 0);
}

function readWithPython(dataUrl) {
  return fetch(PY_VISION, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl })
  }).then((res) => {
    if (!res.ok) throw new Error('py vision ' + res.status);
    return res.json();
  }).then((data) => {
    if (data && data.error && !pyCardsUseful(data)) throw new Error(data.error);
    if (data) data.source = 'py';
    return data;
  });
}

// Inject assistant scripts into every frame when a casino page finishes loading.
// Does not depend on manifest content_scripts — works even if they are blocked.
// Retries with delays because game iframes can appear/navigate after page load.
// Set a badge on the toolbar icon to show assistant status for a tab
function setBadge(tabId, text, color) {
  try {
    if (chrome.action && chrome.action.setBadgeText) {
      chrome.action.setBadgeText({ tabId: tabId, text: text });
    }
    if (chrome.action && chrome.action.setBadgeBackgroundColor) {
      chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: color });
    }
  } catch (e) {
    /* ignore badge errors */
  }
}

function scheduleInjection(tabId) {
  const run = () => {
    injectIntoMatchingFrames(tabId).then((n) => {
      if (n) {
        console.log(`[PokerAssistant] Injected into ${n} game frame(s) of tab ${tabId}`);
        setBadge(tabId, 'ON', '#4caf50');
        openHudWindow(false);
      }
    }).catch((err) => {
      console.error(`[PokerAssistant] Injection failed for tab ${tabId}:`, (err && err.message) || err);
      setBadge(tabId, '!', '#f44336');
    });
  };
  run();
  setTimeout(run, 2500);
  setTimeout(run, 7000);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab || !tab.url || !isHttpTab(tab.url)) return;
  scheduleInjection(tabId);
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (isGameFrameUrl(details.url) || (details.frameId === 0 && isHttpTab(details.url))) {
    scheduleInjection(details.tabId);
  }
});

// Manual trigger: clicking the extension icon grants activeTab access to the
// current page — works even if the site access setting blocks host permissions.
// Guarded: chrome.action may be undefined when the manifest has no "action" key.
if (typeof chrome.action !== 'undefined' && chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    console.log(`[PokerAssistant] Extension icon clicked on: ${tab && tab.url}`);
    if (tab && tab.id) {
      scheduleInjection(tab.id);
      openHudWindow(true);
    }
  });
} else {
  console.log('[PokerAssistant] chrome.action unavailable — icon click trigger disabled');
}

// ===== MESSAGING =====

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Content script requests injection into iframes
  if (request.action === 'injectIntoIframes' && sender.tab) {
    console.log('[PokerAssistant] Received inject request from content script');
    injectIntoMatchingFrames(sender.tab.id).then(() => {
      openHudWindow(false);
      sendResponse({ injected: true });
    }).catch((err) => {
      console.error('[PokerAssistant] Frame injection failed:', err);
      sendResponse({ injected: false, error: String((err && err.message) || err) });
    });
    return true; // Keep message channel open for async
  }

  if (request.action === 'captureTable') {
    const tabId = sender.tab && sender.tab.id;
    const windowId = sender.tab ? sender.tab.windowId : undefined;
    const now = Date.now();
    if (lastShot.dataUrl && now - lastShot.at < 1400) {
      sendResponse({ dataUrl: lastShot.dataUrl, cached: true, cards: lastShot.cards || null, py: pyCardsUseful(lastShot.cards) });
      if (tabId != null) {
        if (pyCardsUseful(lastShot.cards)) broadcastCards(tabId, lastShot.cards);
        else broadcastShot(tabId, lastShot.dataUrl);
      }
      return true;
    }
    try {
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message || 'capture failed' });
          return;
        }
        lastShot = { dataUrl: dataUrl, at: Date.now(), cards: null };
        readWithPython(dataUrl).then((cards) => {
          lastShot.cards = cards;
          const good = pyCardsUseful(cards);
          sendResponse({ dataUrl: dataUrl, cards: cards || null, py: good });
          if (tabId == null) return;
          if (good) broadcastCards(tabId, cards);
          else broadcastShot(tabId, dataUrl);
        }).catch((err) => {
          sendResponse({ dataUrl: dataUrl, cards: null, py: false, pyError: String((err && err.message) || err) });
          if (tabId != null) broadcastShot(tabId, dataUrl);
        });
      });
    } catch (e) {
      sendResponse({ error: String((e && e.message) || e) });
    }
    return true;
  }

  if (request.action === 'publishShot' && sender.tab) {
    broadcastCards(sender.tab.id, request.cards || {});
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'hudHello') {
    sendResponse(lastHud);
    return true;
  }

  if (request.action === 'hudFocus') {
    openHudWindow(true);
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'hudUpdate') {
    applyHud(request.data || {});
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'analyzeHand') {
    const handState = request.hand || {};
    analyzeHandWithPokerSkill(handState).then((result) => {
      applyHud({
        state: (result && result.state) || responseState(handState),
        extra: { street: result && result.street, warning: result && result.readingWarning },
        response: result
      });
      openHudWindow(false);
      sendResponse(result);
    }).catch((error) => {
      console.error('Analysis error:', error);
      const street = detectStreet(handState);
      const decision = buildFallbackDecision(handState);
      const result = {
        error: (error && error.message) || 'Failed to analyze hand',
        street,
        decision,
        state: responseState(handState),
        readingWarning: cardsWarning(handState)
      };
      applyHud({ state: result.state, extra: { street, warning: result.error }, response: result });
      sendResponse(result);
    });

    return true;
  }

  return true;
});

// ===== FRAME INJECTION =====

/**
 * Inject assistant scripts into every frame of the tab.
 * Scripts self-guard against double initialization.
 * Content scripts from the manifest may already run — safe to re-inject.
 */
async function injectIntoMatchingFrames(tabId) {
  let frames = [];
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId: tabId }) || [];
  } catch (e) {
    return 0;
  }
  const game = frames.filter(f => isGameFrameUrl(f.url));
  if (!game.length) return 0;
  const frameIds = game.map(f => f.frameId);
  const target = { tabId: tabId, frameIds: frameIds };

  try {
    await chrome.scripting.executeScript({
      target: target,
      world: 'MAIN',
      files: ['page_bridge.js']
    });
  } catch (e) {
    console.warn('[PokerAssistant] page_bridge:', (e && e.message) || e);
  }
  const results = await chrome.scripting.executeScript({
    target: target,
    files: ['vision.js', 'card_parser.js', 'content_iframe.js']
  });
  const ok = (results || []).filter(r => !r.error).length;
  return ok;
}

// ===== HELPERS =====

function detectStreet(handState) {
  const cc = (handState.communityCards || []).length;
  if (cc >= 5) return 'river';
  if (cc === 4) return 'turn';
  if (cc === 3) return 'flop';
  const stage = handState.stage || '';
  if (stage === 'river' || stage === 'showdown') return 'river';
  if (stage === 'turn') return 'turn';
  if (stage === 'flop') return 'flop';
  return 'preflop';
}

function cardsWarning(handState) {
  const my = (handState.myCards || []).filter(c => c && c.rank);
  if (my.length < 2) return 'Карты не прочитаны — нажмите Tab для ручного ввода';
  return null;
}

function responseState(handState) {
  return {
    myCards: (handState.myCards || []).filter(c => c && c.rank).slice(0, 2),
    communityCards: (handState.communityCards || []).filter(c => c && c.rank).slice(0, 5),
    pot: handState.pot,
    betToCall: handState.betToCall,
    numPlayers: handState.numPlayers,
    numSeated: handState.numSeated,
    heroStack: handState.heroStack,
    heroName: handState.heroName,
    bigBlind: handState.bigBlind
  };
}

/** Convert money value to big blinds */
function toBB(value, bigBlind) {
  const bb = Number(bigBlind) || 0;
  const v = Number(value) || 0;
  if (bb > 0 && v > 0) return +(v / bb).toFixed(2);
  return v;
}

/** Normalize two hole cards to hand key: "AKs", "AJo", "TT" */
function normalizeHandCards(c1, c2) {
  if (!c1 || !c2 || !c1.rank || !c2.rank) return '';
  const rankOrder = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const r1 = rankOrder.indexOf(String(c1.rank).toUpperCase());
  const r2 = rankOrder.indexOf(String(c2.rank).toUpperCase());
  const suited = String(c1.suit).toLowerCase() === String(c2.suit).toLowerCase();
  let high, low;
  if (r1 >= r2) { high = String(c1.rank).toUpperCase(); low = String(c2.rank).toUpperCase(); }
  else { high = String(c2.rank).toUpperCase(); low = String(c1.rank).toUpperCase(); }
  if (high === low) return high + low;
  return high + low + (suited ? 's' : 'o');
}

/** Find GTO table row for a normalized hand key (handles T/10 and o-suffix) */
function lookupGtoHand(hand) {
  if (!hand) return 'default';
  // 1) Exact key: pairs ('AA'), suited ('AKs', 'ATs'), offsuit without suffix ('AK')
  if (PREFLOP_GTO[hand]) return hand;
  // 2) Strip 'o' suffix: 'AKo' -> 'AK', 'QTo' -> 'QT'
  const offsuit = hand.replace(/o$/, '');
  if (PREFLOP_GTO[offsuit]) return offsuit;
  // 3) Convert 'T' -> '10' for table entries like 'A10o'
  const with10 = hand.replace(/^([AKQJ2-9])T/, '$110');
  if (PREFLOP_GTO[with10]) return with10;
  return 'default';
}

/**
 * Compute real equity:
 *  - Preflop: static GTO win-rate table by number of players
 *  - Postflop: Monte Carlo simulation vs N random opponents
 */
function computeEquity(handState) {
  const hole = (handState.myCards || []).filter(c => c && c.rank).slice(0, 2);
  const board = (handState.communityCards || []).filter(c => c && c.rank).slice(0, 5);
  const n = Math.min(Math.max(parseInt(handState.numPlayers, 10) || 2, 2), 6);

  if (hole.length < 2) return { equity: 0, source: 'none' };

  if (board.length === 0) {
    // ---- PREFLOP: GTO table ----
    const norm = normalizeHandCards(hole[0], hole[1]);
    const gtoKey = lookupGtoHand(norm);
    const row = PREFLOP_GTO[gtoKey] || PREFLOP_GTO['default'];
    const winRate = row[n] || row[2];
    return { equity: winRate, source: 'GTO', hand: norm, gtoKey };
  }

  // ---- POSTFLOP: Monte Carlo ----
  try {
    const mc = new MonteCarloSimulator();
    const res = mc.computeWinRate(hole, board, n - 1, 4000);
    return { equity: parseFloat(res.winRate), source: 'MonteCarlo' };
  } catch (e) {
    console.warn('[PokerAssistant] Monte Carlo failed:', e);
    return { equity: 40, source: 'estimate' };
  }
}

function buildLegalActions(street, betToCall) {
  const actions = [];
  if (betToCall > 0) {
    actions.push('c', 'f', 'b');
  } else {
    actions.push('k', 'b');
  }
  return actions;
}

function detectActionHistory(handState) {
  if (handState.action_history && Array.isArray(handState.action_history) && handState.action_history.length > 0) {
    return handState.action_history;
  }
  if (Number(handState.betToCall) > 0) return ['bet'];
  return [];
}

function formatCardsForPokerSkill(cards) {
  if (!cards || !Array.isArray(cards) || cards.length === 0) return '';
  return cards.map(card => {
    if (!card || !card.rank) return '';
    const rank = String(card.rank).toUpperCase();
    const suit = card.suit ? String(card.suit).toLowerCase() : '';
    return rank + suit;
  }).join('');
}

// ===== MAIN ANALYSIS =====

/**
 * Main analysis function using PokerSkill + GigaChat
 * with real equity (GTO/Monte Carlo) and pot odds
 */
async function analyzeHandWithPokerSkill(handState) {
  const street = detectStreet(handState);

  const pot = Number(handState.pot) || 0;
  const betToCall = Number(handState.betToCall) || 0;
  const numPlayers = Math.min(Math.max(parseInt(handState.numPlayers, 10) || 2, 2), 6);
  const totalPot = pot + betToCall;
  const potOdds = totalPot > 0 ? (betToCall / totalPot * 100) : 0;

  const { equity, source, hand } = computeEquity(handState);

  if (!GIGACHAT_API_KEY || gigachatDown) {
    const decision = buildFallbackDecision(handState);
    return {
      hand_id: ++handCounter,
      street,
      decision,
      potOdds: potOdds.toFixed(1),
      equity: equity.toFixed(1),
      equity_source: source,
      hand: hand || '',
      state: responseState(handState),
      readingWarning: cardsWarning(handState)
    };
  }

  // Determine hero position
  const heroPosition = numPlayers >= 6 ? 'EP' : (numPlayers >= 4 ? 'MP' : 'BB');

  // Build legal actions
  const legalActions = buildLegalActions(street, betToCall);

  // Build action history
  const actionHistory = detectActionHistory(handState);

  const bigBlind = Number(handState.bigBlind) || 0;
  const heroStack = Number(handState.heroStack) > 0 ? Number(handState.heroStack) : 200;
  const villainStack = Number(handState.villainStack) > 0 ? Number(handState.villainStack) : 200;

  // Create PokerSkill game state (values in BB)
  const gameState = {
    hand_id: ++handCounter,
    street: street,
    hero_hole_cards: formatCardsForPokerSkill(handState.myCards),
    board_cards: formatCardsForPokerSkill(handState.communityCards),
    pot: toBB(totalPot, bigBlind) || 2.5,
    total_pot: toBB(totalPot, bigBlind) || 2.5,
    hero_stack: toBB(heroStack, bigBlind),
    villain_stack: toBB(villainStack, bigBlind),
    hero_position: heroPosition,
    legal_actions: legalActions,
    raise_min: legalActions.includes('b') ? toBB(betToCall * 2 || pot * 0.5, bigBlind) : null,
    raise_max: legalActions.includes('b') ? toBB(heroStack, bigBlind) : null,
    action_history: actionHistory,
    pot_odds: potOdds.toFixed(1),
    equity: equity.toFixed(1),
    equity_source: source,
    use_skills: true
  };

  // Generate PokerSkill prompt
  const prompt = PokerSkillPromptBuilder.generatePrompt(gameState);

  console.log(`[PokerSkill] Hand #${gameState.hand_id} (${street}) equity=${equity}% (${source}) potOdds=${potOdds.toFixed(1)}%`);

  let llmResponse;
  try {
    llmResponse = await gigachat.chat(
      gameState.hand_id,
      prompt.system_prompt,
      prompt.user_prompt
    );
  } catch (error) {
    const msg = String((error && error.message) || error);
    if (/failed to fetch|networkerror|err_cert|err_connection|err_name_not_resolved/i.test(msg)) {
      gigachatDown = true;
    }
    const fb = buildFallbackDecision(handState);
    return {
      hand_id: gameState.hand_id,
      street,
      decision: fb,
      potOdds: potOdds.toFixed(1),
      equity: equity.toFixed(1),
      equity_source: source,
      hand: hand || '',
      state: responseState(handState),
      readingWarning: cardsWarning(handState)
    };
  }

  // Parse LLM response
  let actionResult;
  try {
    actionResult = gigachat.parseAction(llmResponse);
  } catch (error) {
    console.warn('[PokerSkill] Action parse failed, using fallback:', error);
    const fb = buildFallbackDecision(handState);
    return {
      hand_id: gameState.hand_id,
      street,
      decision: fb,
      llm_response: llmResponse,
      potOdds: potOdds.toFixed(1),
      state: responseState(handState),
      readingWarning: cardsWarning(handState)
    };
  }

  // Determine decision with real equity
  const decision = buildDecision(actionResult, potOdds, street, equity, legalActions, betToCall);

  console.log(`[PokerSkill] Decision: ${JSON.stringify(decision)}`);

  return {
    hand_id: gameState.hand_id,
    street: street,
    decision: decision,
    llm_response: llmResponse,
    potOdds: potOdds.toFixed(1),
    equity: equity.toFixed(1),
    equity_source: source,
    hand: hand || '',
    state: responseState(handState),
    readingWarning: cardsWarning(handState)
  };
}

/**
 * Build decision from LLM result, validated with real equity/pot odds
 */
function buildDecision(actionResult, potOdds, street, equity, legalActions, betToCall) {
  const actionMap = {
    'FOLD': 'FOLD',
    'CHECK': 'CHECK',
    'CALL': 'CALL',
    'RAISE': 'RAISE'
  };

  let action = (actionResult && actionMap[actionResult.action]) || 'FOLD';
  let reason = (actionResult && actionResult.reasoning) || '';

  // Sanity check: don't call a bet when equity is far below pot odds
  if (betToCall > 0 && action === 'CALL' && equity < potOdds * 0.75 && equity < 25) {
    action = 'FOLD';
    reason = `[контроль] Эквити ${equity.toFixed(1)}% ниже pot odds ${potOdds.toFixed(1)}% — фолд вместо колла. ` + reason;
  }

  // Sanity check: don't raise with very weak equity unless bluffing opportunity
  if (betToCall > 0 && action === 'RAISE' && equity < potOdds * 0.5) {
    reason = `[внимание] Слабое эквити (${equity.toFixed(1)}%) для рейза против ставки. ` + reason;
  }

  let winRate = equity;
  if (action === 'FOLD') winRate = Math.min(equity, 30);

  if (reason && reason.length > 120) reason = reason.substring(0, 120) + '...';

  return {
    action: action,
    amount: (actionResult && actionResult.amount) || 0,
    reason: reason || `${action} on ${street}`,
    winRate: winRate.toFixed(1),
    potOdds: potOdds.toFixed(1),
    source: 'llm'
  };
}

/**
 * Fallback decision based purely on GTO/Monte Carlo math
 * Used when LLM is unavailable or fails
 */
function buildFallbackDecision(handState) {
  const street = detectStreet(handState);
  const pot = Number(handState.pot) || 0;
  const betToCall = Number(handState.betToCall) || 0;
  const numPlayers = Math.min(Math.max(parseInt(handState.numPlayers, 10) || 2, 2), 6);
  const totalPot = pot + betToCall;
  const potOdds = totalPot > 0 ? (betToCall / totalPot * 100) : 0;
  const { equity } = computeEquity(handState);

  let action, amount = 0, reason;

  if (betToCall === 0) {
    if (equity >= 60) {
      action = 'RAISE';
      amount = Math.max(pot * 0.75, 1);
      reason = `Сильная рука (${equity.toFixed(1)}%) — рейз для велью`;
    } else {
      action = 'CHECK';
      reason = `Эквити ${equity.toFixed(1)}% — чек, контроль банка`;
    }
  } else {
    if (equity >= potOdds + 20) {
      action = 'RAISE';
      amount = Math.max(betToCall * 2.5, 1);
      reason = `Эквити ${equity.toFixed(1)}% >> pot odds ${potOdds.toFixed(1)}% — рейз`;
    } else if (equity >= potOdds * 0.75) {
      action = 'CALL';
      reason = `Эквити ${equity.toFixed(1)}% vs pot odds ${potOdds.toFixed(1)}% — колл`;
    } else {
      action = 'FOLD';
      reason = `Эквити ${equity.toFixed(1)}% < pot odds ${potOdds.toFixed(1)}% — фолд`;
    }
  }

  return {
    action: action,
    amount: amount,
    reason: reason + ` (${numPlayers} игроков, ${street})`,
    winRate: equity.toFixed(1),
    potOdds: potOdds.toFixed(1),
    source: 'fallback'
  };
}

console.log('Poker Assistant: Background loaded with PokerSkill + GigaChat + GTO/Monte Carlo');
