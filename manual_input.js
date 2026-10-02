// Manual card input popup for Poker Assistant
(function () {
  'use strict';
  if (window._pokerManualInput) return;

  class PokerManualInput {
    constructor() {
      this.isVisible = false;
    }

    toggle() {
      if (this.isVisible) this.hide();
      else this.show();
    }

    show() {
      if (this.isVisible) return;
      this.isVisible = true;
      const existing = document.getElementById('poker-manual-input');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'poker-manual-input';
      overlay.innerHTML = `
      <div class="pmi-panel">
        <div class="pmi-header">
          🃏 Poker Assistant — Manual Input
          <button class="pmi-close" onclick="window._pokerManualInput.hide()">✕</button>
        </div>
        <div class="pmi-body">
          <div class="pmi-row">
            <label>Your Cards:</label>
            <input type="text" id="pmi-hero-cards" placeholder="e.g. AhKs, AKs, A2" value="" />
          </div>
          <div class="pmi-row">
            <label>Board (community):</label>
            <input type="text" id="pmi-board" placeholder="e.g. 7h2h4d (empty for preflop)" value="" />
          </div>
          <div class="pmi-row">
            <label>Pot (BB):</label>
            <input type="number" id="pmi-pot" placeholder="2.5" value="2.5" step="0.5" />
          </div>
          <div class="pmi-row">
            <label>Bet to Call (BB):</label>
            <input type="number" id="pmi-bet" placeholder="0" value="0" step="0.5" />
          </div>
          <div class="pmi-row">
            <label>Players:</label>
            <input type="number" id="pmi-players" placeholder="2" value="2" min="2" max="6" />
          </div>
          <button class="pmi-analyze" onclick="window._pokerManualInput.analyze()">
            Analyze
          </button>
        </div>
        <div class="pmi-status" id="pmi-status"></div>
      </div>`;
      document.body.appendChild(overlay);
      setTimeout(() => {
        const el = document.getElementById('pmi-hero-cards');
        if (el) el.focus();
      }, 100);
    }

    hide() {
      this.isVisible = false;
      const el = document.getElementById('poker-manual-input');
      if (el) el.remove();
    }

    async analyze() {
      const statusEl = document.getElementById('pmi-status');
      statusEl.textContent = '⏳ Analyzing...';
      statusEl.className = 'pmi-status pmi-loading';

      const heroCardsRaw = document.getElementById('pmi-hero-cards').value.trim();
      const boardRaw = document.getElementById('pmi-board').value.trim();
      const pot = parseFloat(document.getElementById('pmi-pot').value) || 2.5;
      const betToCall = parseFloat(document.getElementById('pmi-bet').value) || 0;
      const numPlayers = parseInt(document.getElementById('pmi-players').value) || 2;

      const myCards = this.parseCards(heroCardsRaw);
      if (myCards.length !== 2) {
        statusEl.textContent = '❌ Enter exactly 2 cards, e.g. AhKs';
        statusEl.className = 'pmi-status pmi-error';
        return;
      }
      const communityCards = this.parseCards(boardRaw);
      let stage = 'preflop';
      if (communityCards.length >= 3) stage = 'flop';
      if (communityCards.length === 4) stage = 'turn';
      if (communityCards.length === 5) stage = 'river';

      const state = { myCards, communityCards, pot, betToCall, stage, numPlayers };

      try {
        if (!chrome.runtime || !chrome.runtime.id) {
          throw new Error('Расширение перезагрузилось — обновите страницу (F5)');
        }
        const response = await chrome.runtime.sendMessage({ action: 'analyzeHand', hand: state });
        if (response && response.decision) {
          statusEl.textContent = '✅ Готово';
          statusEl.className = 'pmi-status pmi-success';
          document.dispatchEvent(new CustomEvent('pokerAnalysisResult', { detail: response }));
          setTimeout(() => this.hide(), 2000);
        } else {
          statusEl.textContent = '❌ Нет ответа';
          statusEl.className = 'pmi-status pmi-error';
        }
      } catch (error) {
        statusEl.textContent = '❌ ' + (error.message || 'Failed');
        statusEl.className = 'pmi-status pmi-error';
      }
    }

    parseCards(raw) {
      if (!raw) return [];
      const cards = [];
      const ranks = { T: 'T', J: 'J', Q: 'Q', K: 'K', A: 'A', '10': 'T' };
      const tokens = raw.replace(/[,;\s]+/g, ' ').trim().split(/\s+/);
      for (const token of tokens) {
        if (cards.length >= 5) break;
        if (/^[AKQJT2-9][hdcs]$/i.test(token)) {
          cards.push({ rank: ranks[token[0]] || token[0], suit: token[1].toLowerCase() });
          continue;
        }
        if (/^[AKQJT2-9]{2}[so]$/i.test(token)) {
          const r1 = ranks[token[0]] || token[0];
          const r2 = ranks[token[1]] || token[1];
          const suited = token[2].toLowerCase() === 's';
          cards.push({ rank: r1, suit: 'h' });
          cards.push({ rank: r2, suit: suited ? 'h' : 's' });
        }
      }
      return cards;
    }
  }

  window._pokerManualInput = new PokerManualInput();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      if (document.activeElement.tagName !== 'INPUT' &&
          document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        window._pokerManualInput.toggle();
      }
    }
  });
})();
