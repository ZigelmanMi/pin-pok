// Monte Carlo Poker Simulator
// Simulates remaining cards to calculate win probability

class MonteCarloSimulator {
  constructor() {
    this.suits = ['h', 'd', 'c', 's'];
    this.ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  }

  // Generate full deck
  createDeck() {
    const deck = [];
    for (const suit of this.suits) {
      for (const rank of this.ranks) {
        deck.push({rank, suit});
      }
    }
    return deck;
  }

  // Remove known cards from deck
  removeKnownCards(deck, knownCards) {
    return deck.filter(card => {
      return !knownCards.some(known => known.rank === card.rank && known.suit === card.suit);
    });
  }

  // Shuffle array (Fisher-Yates)
  shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Evaluate poker hand strength (simplified)
  evaluateHandStrength(holeCards, communityCards) {
    const allCards = [...holeCards, ...communityCards];
    if (allCards.length < 5) return 0;
    
    // Get best 5-card combination
    const combinations = this.getCombinations(allCards, 5);
    let bestScore = 0;
    
    for (const combo of combinations) {
      const score = this.scoreHand(combo);
      if (score > bestScore) bestScore = score;
    }
    
    return bestScore;
  }

  // Get all combinations of n cards
  getCombinations(cards, n) {
    if (n === 0) return [[]];
    if (cards.length === 0) return [];
    
    const [first, ...rest] = cards;
    const withFirst = this.getCombinations(rest, n - 1).map(c => [first, ...c]);
    const withoutFirst = this.getCombinations(rest, n);
    
    return [...withFirst, ...withoutFirst];
  }

  // Score a 5-card hand (higher = better)
  scoreHand(cards) {
    const ranks = cards.map(c => this.ranks.indexOf(c.rank)).sort((a, b) => b - a);
    const suits = cards.map(c => c.suit);
    
    const isFlush = suits.every(s => s === suits[0]);
    const isStraight = this.isStraight(ranks);
    
    const counts = {};
    ranks.forEach(r => counts[r] = (counts[r] || 0) + 1);
    const countValues = Object.values(counts).sort((a, b) => b - a);
    
    // Royal flush
    if (isFlush && isStraight && ranks[0] === 12) return 9000000 + ranks[1];
    // Straight flush
    if (isFlush && isStraight) return 8000000 + ranks[1];
    // Four of a kind
    if (countValues[0] === 4) return 7000000 + ranks[0];
    // Full house
    if (countValues[0] === 3 && countValues[1] >= 2) return 6000000 + ranks[0];
    // Flush
    if (isFlush) return 5000000 + ranks.reduce((a, b) => a + b, 0);
    // Straight
    if (isStraight) return 4000000 + ranks[1];
    // Three of a kind
    if (countValues[0] === 3) return 3000000 + ranks[0];
    // Two pair
    if (countValues[0] === 2 && countValues[1] === 2) return 2000000 + ranks[0];
    // Pair
    if (countValues[0] === 2) return 1000000 + ranks[0];
    // High card
    return ranks.reduce((a, b) => a + b, 0);
  }

  isStraight(ranks) {
    const unique = [...new Set(ranks)].sort((a, b) => b - a);
    if (unique.length < 5) return false;
    // Check normal straight
    for (let i = 0; i <= unique.length - 5; i++) {
      if (unique[i] - unique[i + 4] === 4) return true;
    }
    // Check wheel (A-2-3-4-5)
    if (unique.includes(12) && unique.includes(0) && unique.includes(1) && 
        unique.includes(2) && unique.includes(3)) return true;
    return false;
  }

  // Run Monte Carlo simulation (1 vs 1 with known opponent hand)
  simulate(holeCards, communityCards, opponentCards, iterations = 1000) {
    const deck = this.createDeck();
    const known = [...holeCards, ...communityCards, ...opponentCards];
    const available = this.removeKnownCards(deck, known);
    
    let wins = 0;
    let ties = 0;
    
    for (let i = 0; i < iterations; i++) {
      const shuffled = this.shuffle(available);
      
      // Fill community cards
      const board = [...communityCards, ...shuffled.slice(0, 5 - communityCards.length)];
      
      // Evaluate
      const myScore = this.evaluateHandStrength(holeCards, board);
      const oppScore = this.evaluateHandStrength(opponentCards, board);
      
      if (myScore > oppScore) wins++;
      else if (myScore === oppScore) ties++;
    }
    
    return {
      winRate: (wins / iterations * 100).toFixed(1),
      tieRate: (ties / iterations * 100).toFixed(1),
      loseRate: ((1 - (wins + ties) / iterations) * 100).toFixed(1)
    };
  }

  /**
   * Compute win rate vs N random opponents (unknown hands).
   * Used to get real equity for post-flop decisions.
   */
  computeWinRate(holeCards, communityCards, numOpponents, iterations = 4000) {
    const deck = this.createDeck();
    const known = [...holeCards, ...communityCards];
    const available = this.removeKnownCards(deck, known);
    const boardNeed = 5 - (communityCards || []).length;
    const oppCount = Math.max(0, numOpponents || 1);
    const need = 2 * oppCount + boardNeed;

    if (available.length < need) {
      return { winRate: 0, tieRate: 0, loseRate: 100 };
    }

    let wins = 0;
    let ties = 0;
    const ITER = iterations;

    for (let i = 0; i < ITER; i++) {
      const shuffled = this.shuffle(available);
      let idx = 0;

      const board = [...(communityCards || []), ...shuffled.slice(idx, idx + boardNeed)];
      idx += boardNeed;

      const myScore = this.evaluateHandStrength(holeCards, board);
      let bestOppScore = -1;
      let oppTie = false;

      for (let o = 0; o < oppCount; o++) {
        const oppHand = [shuffled[idx], shuffled[idx + 1]];
        idx += 2;
        const s = this.evaluateHandStrength(oppHand, board);
        if (s > bestOppScore) { bestOppScore = s; oppTie = false; }
        else if (s === bestOppScore) { oppTie = true; }
      }

      if (myScore > bestOppScore) wins++;
      else if (myScore === bestOppScore) ties++;
    }

    return {
      winRate: (wins / ITER * 100).toFixed(1),
      tieRate: (ties / ITER * 100).toFixed(1),
      loseRate: ((1 - (wins + ties) / ITER) * 100).toFixed(1)
    };
  }
}
