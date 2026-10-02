(function () {
  'use strict';

  var ACTION_COLORS = {
    RAISE: '#ff5252',
    CALL: '#4caf50',
    CHECK: '#40c4ff',
    FOLD: '#ff9800'
  };

  function formatCards(cards) {
    if (!cards || !cards.length) return '—';
    return cards.map(function (c) { return (c.rank || '') + (c.suit || ''); }).join(' ');
  }

  function parseCards(raw) {
    if (!raw) return [];
    var cards = [];
    var text = String(raw).replace(/10/gi, 'T').toUpperCase();
    var re = /([AKQJT2-9])([HDCS])/g;
    var m;
    while ((m = re.exec(text)) && cards.length < 5) {
      cards.push({ rank: m[1], suit: m[2].toLowerCase() });
    }
    return cards;
  }

  function renderLive(state, extra) {
    extra = extra || {};
    var live = document.getElementById('pa-live');
    if (!live) return;
    state = state || {};
    var stackTxt = state.heroStack != null && Number(state.heroStack) > 0
      ? '$' + Number(state.heroStack).toFixed(2) : '—';
    var nameTxt = state.heroName ? ' (' + state.heroName + ')' : '';
    live.innerHTML =
      '<div class="pa-state-title">📡 Прочитано из игры</div>' +
      '<div class="pa-state-row">🂡 Мои карты: <b>' + formatCards(state.myCards) + '</b></div>' +
      '<div class="pa-state-row">🃏 Доска: <b>' + formatCards(state.communityCards) + '</b></div>' +
      '<div class="pa-state-row">💰 Банк: <b>$' + Number(state.pot || 0).toFixed(2) +
      '</b> · Ставка: <b>$' + Number(state.betToCall || 0).toFixed(2) + '</b></div>' +
      '<div class="pa-state-row">👛 Стек' + nameTxt + ': <b>' + stackTxt + '</b></div>' +
      '<div class="pa-state-row">👥 Игроков: <b>' + (state.numPlayers || '—') +
      '</b> · Улица: <b>' + (state.stage || extra.street || '?') + '</b>' +
      (state._raw && state._raw.source ? ' · src: ' + state._raw.source : '') +
      (state._raw && state._raw.shotBoxes != null ? ' · boxes: ' + state._raw.shotBoxes : '') +
      (state._raw && state._raw.shotReads != null ? ' · reads: ' + state._raw.shotReads : '') +
      '</div>' +
      (extra.warning ? '<div class="pa-warning">⚠️ ' + extra.warning + '</div>' : '') +
      '<div class="pa-hint">Окно можно перетащить с стола — на край экрана или второй монитор.</div>';
  }

  function renderDecision(response) {
    var rec = document.getElementById('pa-rec');
    if (!rec) return;
    if (response && response.state) {
      renderLive(response.state, {
        street: response.street,
        warning: response.readingWarning || response.error
      });
    }
    var decision = (response && response.decision) || {};
    if (!decision.action) {
      rec.className = 'pa-rec-wait';
      rec.innerHTML = response && response.error
        ? '⚠️ ' + response.error + ' — считаю по GTO…'
        : 'Считаю рекомендацию…';
      return;
    }
    var color = ACTION_COLORS[decision.action] || '#ffffff';
    var sourceBadge = decision.source === 'fallback'
      ? '<span class="pa-badge pa-badge-fallback">⚙️ GTO/Monte Carlo</span>'
      : '<span class="pa-badge pa-badge-llm">🤖 GigaChat</span>';
    rec.className = 'pa-rec';
    rec.innerHTML =
      '<div class="pa-street">Улица: ' + (response.street || '?') + ' ' + sourceBadge + '</div>' +
      '<div class="pa-recommendation" style="color:' + color + ';">' + decision.action + '</div>' +
      '<div class="pa-details">' +
        '<div>📊 Эквити (шанс выиграть): ~' + (decision.winRate != null ? decision.winRate : '—') + '%</div>' +
        '<div>💰 Pot Odds (цена колла): ' + (decision.potOdds != null ? decision.potOdds : '—') + '%</div>' +
        '<div>📈 ' + (decision.reason || '') + '</div>' +
      '</div>';
  }

  function applyHud(hud) {
    if (!hud) return;
    if (hud.dead) {
      var rec = document.getElementById('pa-rec');
      if (rec) {
        rec.className = 'pa-rec-wait';
        rec.innerHTML = '⚠️ Расширение перезагрузилось. chrome://extensions → Обновить, затем F5 на Pinco.';
      }
      return;
    }
    if (hud.response) renderDecision(hud.response);
    else if (hud.state) renderLive(hud.state, hud.extra || {});
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.action === 'hudRender') applyHud(msg.hud);
  });

  chrome.runtime.sendMessage({ action: 'hudHello' }, function (hud) {
    if (chrome.runtime.lastError) return;
    applyHud(hud);
  });

  document.getElementById('pa-man-go').addEventListener('click', function () {
    var status = document.getElementById('pa-man-status');
    var hole = parseCards(document.getElementById('pa-man-hole').value);
    var board = parseCards(document.getElementById('pa-man-board').value);
    if (hole.length !== 2) {
      status.textContent = 'Нужны две карты, например Ah Kd';
      return;
    }
    status.textContent = 'Считаю…';
    chrome.runtime.sendMessage({
      action: 'analyzeHand',
      hand: {
        myCards: hole,
        communityCards: board,
        pot: 0,
        betToCall: 0,
        numPlayers: 6,
        stage: board.length >= 5 ? 'river' : board.length === 4 ? 'turn' : board.length >= 3 ? 'flop' : 'preflop'
      }
    }, function (response) {
      if (chrome.runtime.lastError) {
        status.textContent = chrome.runtime.lastError.message;
        return;
      }
      status.textContent = response && response.decision ? 'Готово' : 'Нет ответа';
      if (response) renderDecision(response);
    });
  });
})();
