// PokerSkill 5-Layer Prompt Builder (JavaScript port)
// Implements the same skill system as Python PokerSkill agent
// P1: Rules, P2: Pre-flop GTO, P3: Post-flop hand strength, P4: Post-flop budget, P5: River bluffing

const SYSTEM_PROMPT = `You are an expert Heads-Up No-Limit Texas Hold'em (HUNL) poker AI playing with 200BB deep stacks.

You must respond with a JSON object containing:
{
  "action": "f" | "k" | "c" | "b",
  "amount": number (only for action="b", in BB),
  "reasoning": "string"
}

Action codes:
- "f" = fold
- "k" = check
- "c" = call
- "b" = bet/raise (amount required in BB)

Play optimally using GTO principles combined with practical adjustments. Consider:
1. Positional advantage
2. Range advantage
3. Board texture
4. Pot odds and implied odds
5. Opponent tendencies (if known)
6. Stack depths
7. Bet sizing optimization

Be concise in your reasoning. Always provide a clear action.`;

class PokerSkillPromptBuilder {
  /**
   * Generate a structured HUNL poker prompt from game state
   */
  static generatePrompt(state) {
    if (state.street === 'preflop') {
      const userPrompt = this.buildPreflopPrompt(state);
      return { system_prompt: SYSTEM_PROMPT, user_prompt: userPrompt };
    } else {
      const userPrompt = this.buildPostflopPrompt(state);
      return { system_prompt: SYSTEM_PROMPT, user_prompt: userPrompt };
    }
  }

  /**
   * P2: Pre-flop GTO prompt
   */
  static buildPreflopPrompt(state) {
    const {
      hero_hole_cards,
      hero_position,
      hero_stack,
      villain_stack,
      pot,
      total_pot,
      legal_actions,
      raise_min,
      raise_max,
      action_history,
      pot_odds,
      equity,
      equity_source
    } = state;

    // Normalize hole cards for display
    const heroCards = this.formatCards(hero_hole_cards);
    
    // Calculate effective stack in BB
    const effectiveStack = Math.min(hero_stack, villain_stack);
    
    // Build action history summary
    const historySummary = action_history.length > 0 
      ? `Action history: ${action_history.join(', ')}` 
      : 'No prior action.';

    // P2 Pre-flop GTO knowledge injection
    const preflopGTO = this.getPreflopGTOGuidelines(hero_hole_cards, hero_position);

    return `=== HUNL Pre-flop Analysis ===
Stack depths: Hero ${hero_stack}BB, Villain ${villain_stack}BB (Effective: ${effectiveStack}BB)
Position: Hero ${hero_position}
Pot: ${pot}BB, Total pot: ${total_pot}BB
Pot odds: ${pot_odds != null ? pot_odds + '%' : 'n/a'} | Estimated equity: ${equity != null ? equity + '%' : 'n/a'} (${equity_source || 'unknown'})

Hero hole cards: ${heroCards}
Legal actions: ${legal_actions.join(', ')}
${raise_min !== undefined && raise_min !== null ? `Min raise: ${raise_min}BB` : ''}
${raise_max !== undefined && raise_max !== null ? `Max raise: ${raise_max}BB` : ''}
${historySummary}

=== P2: Pre-flop GTO Guidelines ===
${preflopGTO}

Based on GTO principles and your position, what is the optimal action?
Respond with JSON: {"action": "...", "amount": ..., "reasoning": "..."}`;
  }

  /**
   * P3+P4: Post-flop prompt with hand strength and budget analysis
   */
  static buildPostflopPrompt(state) {
    const {
      hero_hole_cards,
      board_cards,
      street,
      pot,
      total_pot,
      hero_stack,
      villain_stack,
      hero_position,
      legal_actions,
      raise_min,
      raise_max,
      action_history,
      pot_odds,
      equity,
      equity_source
    } = state;

    const heroCards = this.formatCards(hero_hole_cards);
    const board = this.formatCards(board_cards);
    const effectiveStack = Math.min(hero_stack, villain_stack);
    
    // P3: Hand strength assessment
    const handStrength = this.assessHandStrength(hero_hole_cards, board_cards, street);
    
    // P4: Budget analysis (optimal bet sizing)
    const budgetAnalysis = this.calculateBudget(pot, effectiveStack, handStrength);

    // P5: Bluffing considerations (river only)
    const bluffingNotes = street === 'river' ? this.getBluffingNotes(state) : '';

    const historySummary = action_history.length > 0 
      ? `Action history: ${action_history.join(', ')}` 
      : 'No prior action.';

    return `=== HUNL ${street.charAt(0).toUpperCase() + street.slice(1)} Analysis ===
Stack depths: Hero ${hero_stack}BB, Villain ${villain_stack}BB (Effective: ${effectiveStack}BB)
Position: Hero ${hero_position}
Pot: ${pot}BB, Total pot: ${total_pot}BB
Pot odds: ${pot_odds != null ? pot_odds + '%' : 'n/a'} | Estimated equity: ${equity != null ? equity + '%' : 'n/a'} (${equity_source || 'unknown'})

Hero hole cards: ${heroCards}
Board: ${board}
Street: ${street}
Legal actions: ${legal_actions.join(', ')}
${raise_min !== undefined && raise_min !== null ? `Min raise: ${raise_min}BB` : ''}
${raise_max !== undefined && raise_max !== null ? `Max raise: ${raise_max}BB` : ''}
${historySummary}

=== P3: Hand Strength Assessment ===
${handStrength}

=== P4: Bet Sizing Budget ===
${budgetAnalysis}

${bluffingNotes}

Based on all factors, what is the optimal action?
Respond with JSON: {"action": "...", "amount": ..., "reasoning": "..."}`;
  }

  /**
   * P2: Pre-flop GTO guidelines based on hand and position
   */
  static getPreflopGTOGuidelines(holeCards, position) {
    const normalized = this.normalizeHand(holeCards[0], holeCards[1]);
    
    // GTO pre-flop ranges (simplified but accurate)
    const premiumHands = ['AA', 'KK', 'QQ', 'JJ', 'AKs'];
    const strongHands = ['TT', 'AJs', 'AQs', 'KTs', 'QJs', 'ATs', 'KQs'];
    const speculators = ['77+', ' suited connectors', 'gapped connectors', 'Axs'];
    
    let recommendation = '';
    
    if (premiumHands.includes(normalized)) {
      recommendation = `PREMIUM HAND (${normalized}): Always raise. Standard open to 2-2.2BB from early, 1.8-2BB from late position. 3-bet to 2.2-2.5x if facing a raise.`;
    } else if (strongHands.includes(normalized)) {
      recommendation = `STRONG HAND (${normalized}): Raise to 2-2.2BB from any position. Consider 3-betting if in position against a late position open.`;
    } else if (/^\d{2}$/.test(normalized) && parseInt(normalized[0]) >= 7) {
      recommendation = `MEDIUM PAIR (${normalized}): Raise to 2-2.2BB. Play cautiously post-flop. Consider folding to 3-bet out of position.`;
    } else if (normalized.includes('s')) {
      recommendation = `SUITED HAND (${normalized}): Can open from late position (BTN, CO) at 2BB. Prefer calling from early position to see flop and realize equity.`;
    } else {
      recommendation = `OFFSUIT HAND (${normalized}): ${position === 'BB' ? 'Defend with a call if pot odds are favorable.' : 'Consider folding from early position. Can open from late position if suited or connected.'}`;
    }

    // Positional adjustment
    if (position === 'BTN') {
      recommendation += '\n[Positional bonus: BTN allows wider ranges]';
    } else if (position === 'BB') {
      recommendation += '\n[Positional note: BB has good pot odds to defend (typically 3:1 or better)]';
    }

    return recommendation;
  }

  /**
   * P3: Post-flop hand strength assessment
   */
  static assessHandStrength(holeCards, boardCards, street) {
    if (!boardCards || boardCards.length === 0) {
      return 'No board cards yet. Evaluate based on hole card strength alone.';
    }

    const heroRanks = [holeCards[0], holeCards[2]];
    const heroSuits = [holeCards[1], holeCards[3]];
    const boardRanks = [];
    const boardSuits = [];
    
    for (let i = 0; i < boardCards.length; i += 2) {
      boardRanks.push(boardCards[i]);
      boardSuits.push(boardCards[i + 1]);
    }

    let strength = '';
    
    // Check for pairs
    const heroPair = heroRanks[0] === heroRanks[1];
    const boardPair = boardRanks[0] === boardRanks[1] || boardRanks[1] === boardRanks[2] || boardRanks[0] === boardRanks[2];
    const madePair = heroRanks.some(r => boardRanks.includes(r));
    
    if (heroPair) {
      strength += `Made pair (pocket pair ${heroRanks[0]}${heroRanks[1]}). `;
      if (boardPair) strength += 'Board is paired. Be cautious of full houses. ';
    } else if (madePair) {
      strength += `Top pair or better. `;
    }
    
    // Check for flush draw
    const suitCounts = {};
    [...heroSuits, ...boardSuits].forEach(s => suitCounts[s] = (suitCounts[s] || 0) + 1);
    const flushDraw = Object.values(suitCounts).some(count => count >= 4);
    if (flushDraw) {
      const flushSuit = Object.entries(suitCounts).find(([_, c]) => c >= 4);
      strength += `Flush draw possible (${flushSuit[0]} suit). `;
    }
    
    // Check for straight draw
    const rankOrder = {'2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14};
    const allRanks = [...heroRanks.map(r => rankOrder[r]), ...boardRanks.map(r => rankOrder[r])].sort((a, b) => a - b);
    
    let straightDraw = false;
    for (let i = 0; i < allRanks.length - 3; i++) {
      const span = allRanks[i + 3] - allRanks[i];
      if (span <= 4 && span >= 3) {
        straightDraw = true;
        break;
      }
    }
    if (straightDraw) {
      strength += 'Straight draw possible. ';
    }
    
    // Equity estimate
    if (heroPair && !boardPair) {
      strength += `Estimated equity: ~80% vs random hand.`;
    } else if (madePair && !heroPair) {
      strength += `Estimated equity: ~60-70% vs random hand.`;
    } else if (flushDraw && straightDraw) {
      strength += `Estimated equity: ~55% with strong draw combo.`;
    } else if (flushDraw || straightDraw) {
      strength += `Estimated equity: ~35-45% with draw.`;
    } else {
      strength += `Estimated equity: ~25-35% (likely bluff candidate).`;
    }

    return strength;
  }

  /**
   * P4: Budget analysis (optimal bet sizing)
   */
  static calculateBudget(pot, effectiveStack, handStrength) {
    const stackToPot = effectiveStack / pot;
    
    // Determine bet sizing based on hand strength
    let minBet, maxBet, recommendedSizing;
    
    if (handStrength.includes('80%') || handStrength.includes('60-70%')) {
      // Strong hand: larger bets
      minBet = pot;
      maxBet = Math.min(pot * 2.5, effectiveStack);
      recommendedSizing = `Value bet range: ${minBet.toFixed(1)}-${maxBet.toFixed(1)}BB. Consider ${pot * 0.75 >= effectiveStack ? 'all-in' : pot * 0.75 + 'BB'}`;
    } else if (handStrength.includes('55%') || handStrength.includes('35-45%')) {
      // Medium hand / draw: medium bets
      minBet = pot * 0.5;
      maxBet = pot * 0.75;
      recommendedSizing = `Probe/semi-bluff range: ${minBet.toFixed(1)}-${maxBet.toFixed(1)}BB`;
    } else {
      // Weak hand: check or small bluff
      minBet = pot * 0.33;
      maxBet = pot * 0.5;
      recommendedSizing = `Bluff range: ${minBet.toFixed(1)}-${maxBet.toFixed(1)}BB or check behind`;
    }

    return `Pot: ${pot}BB | Stack/pot ratio: ${stackToPot.toFixed(1)}x | ${recommendedSizing}`;
  }

  /**
   * P5: River bluffing notes
   */
  static getBluffingNotes(state) {
    const { board_cards, hero_hole_cards, legal_actions, action_history } = state;
    
    // Dry board textures (less likely to hit hero's range)
    const dryBoards = ['K-7-2', 'Q-8-3', 'J-9-4', 'K-4-6', 'Q-5-7'];
    const boardStr = board_cards.substring(0, 6).replace(/[^A-K2-9]/g, '');
    
    let notes = '=== P5: River Bluffing Notes ===\n';
    
    if (legal_actions.includes('b') && action_history.some(a => a.includes('check') || a.includes('k'))) {
      notes += 'Opponent checked to you on the river - good bluffing opportunity.\n';
    }
    
    if (dryBoards.some(d => boardStr.includes(d.substring(0, 3)))) {
      notes += 'Dry board texture - villain likely missed. Good bluff candidate.\n';
    }
    
    notes += 'Consider bluffing with: missed draws, weak pairs, gutshots.';
    
    return notes;
  }

  /**
   * Format card string for display
   */
  static formatCards(cardStr) {
    if (!cardStr || cardStr.length === 0) return '(none)';
    if (cardStr.length === 4) {
      return `${cardStr[0]}${cardStr[1]} / ${cardStr[2]}${cardStr[3]}`;
    }
    // Format board cards (6-10 chars)
    const cards = [];
    for (let i = 0; i < cardStr.length; i += 2) {
      cards.push(cardStr[i] + cardStr[i + 1]);
    }
    return cards.join(' ');
  }

  /**
   * Normalize hand for comparison (e.g., AhKd -> AKs or AKo)
   */
  static normalizeHand(card1, card2) {
    const rank1 = card1[0].toUpperCase();
    const rank2 = card2[0].toUpperCase();
    const suit1 = card1[1].toLowerCase();
    const suit2 = card2[1].toLowerCase();
    
    // Order by rank strength
    const rankOrder = {'2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14};
    
    let highRank, lowRank;
    if (rankOrder[rank1] >= rankOrder[rank2]) {
      highRank = rank1;
      lowRank = rank2;
    } else {
      highRank = rank2;
      lowRank = rank1;
    }
    
    const isSuited = suit1 === suit2;
    const isPair = highRank === lowRank;
    
    if (isPair) return highRank + lowRank;
    return highRank + lowRank + (isSuited ? 's' : 'o');
  }
}
