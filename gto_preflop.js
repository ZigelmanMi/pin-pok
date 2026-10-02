// GTO Preflop Hand Rankings (win probability vs N players)
// Based on standard GTO charts
const PREFLOP_GTO = {
  // Pairs
  'AA': {2: 85, 3: 82, 4: 80, 5: 78, 6: 76},
  'KK': {2: 82, 3: 78, 4: 75, 5: 73, 6: 71},
  'QQ': {2: 80, 3: 75, 4: 72, 5: 70, 6: 68},
  'JJ': {2: 77, 3: 72, 4: 69, 5: 67, 6: 65},
  'TT': {2: 75, 3: 70, 4: 67, 5: 65, 6: 63},
  '99': {2: 72, 3: 67, 4: 64, 5: 62, 6: 60},
  '88': {2: 69, 3: 64, 4: 61, 5: 59, 6: 57},
  '77': {2: 66, 3: 61, 4: 58, 5: 56, 6: 54},
  '66': {2: 63, 3: 58, 4: 55, 5: 53, 6: 51},
  '55': {2: 60, 3: 55, 4: 52, 5: 50, 6: 48},
  '44': {2: 57, 3: 52, 4: 49, 5: 47, 6: 45},
  '33': {2: 54, 3: 49, 4: 46, 5: 44, 6: 42},
  '22': {2: 51, 3: 46, 4: 43, 5: 41, 6: 39},
  // Suited connectors & broadway
  'AKs': {2: 67, 3: 63, 4: 60, 5: 58, 6: 56},
  'AQs': {2: 66, 3: 62, 4: 59, 5: 57, 6: 55},
  'AJs': {2: 65, 3: 61, 4: 58, 5: 56, 6: 54},
  'ATs': {2: 63, 3: 59, 4: 56, 5: 54, 6: 52},
  'A9s': {2: 60, 3: 56, 4: 53, 5: 51, 6: 49},
  'KQs': {2: 63, 3: 59, 4: 56, 5: 54, 6: 52},
  'KJs': {2: 62, 3: 58, 4: 55, 5: 53, 6: 51},
  'QJs': {2: 63, 3: 59, 4: 56, 5: 54, 6: 52},
  'JTs': {2: 60, 3: 56, 4: 53, 5: 51, 6: 49},
  'T9s': {2: 58, 3: 54, 4: 51, 5: 49, 6: 47},
  // Offsuit
  'AK': {2: 65, 3: 61, 4: 58, 5: 56, 6: 54},
  'AQ': {2: 63, 3: 59, 4: 56, 5: 54, 6: 52},
  'AJ': {2: 62, 3: 58, 4: 55, 5: 53, 6: 51},
  'A10o': {2: 60, 3: 56, 4: 53, 5: 51, 6: 49},
  'KQ': {2: 61, 3: 57, 4: 54, 5: 52, 6: 50},
  'KJ': {2: 59, 3: 55, 4: 52, 5: 50, 6: 48},
  'QT': {2: 57, 3: 53, 4: 50, 5: 48, 6: 46},
  // Fold hands
  'default': {2: 35, 3: 30, 4: 27, 5: 25, 6: 23}
};

// Pre-flop action recommendations based on win rate
function getPreflopAction(hand, numPlayers) {
  const key = hand;
  const data = PREFLOP_GTO[key] || PREFLOP_GTO['default'];
  const winRate = data[numPlayers] || data[2];
  
  if (winRate >= 70) return {action: 'RAISE', sizing: '3x', winRate};
  if (winRate >= 55) return {action: 'RAISE', sizing: '2.5x', winRate};
  if (winRate >= 40) return {action: 'CALL', sizing: null, winRate};
  return {action: 'FOLD', sizing: null, winRate};
}

// Normalize hand notation
function normalizeHand(card1, card2) {
  const ranks = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const r1 = ranks.indexOf(card1.rank);
  const r2 = ranks.indexOf(card2.rank);
  const suited = card1.suit === card2.suit;
  
  let high, low;
  if (r1 >= r2) { high = card1.rank; low = card2.rank; }
  else { high = card2.rank; low = card1.rank; }
  
  if (high === low) return high + low;
  return high + low + (suited ? 's' : 'o');
}
