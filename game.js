/**
 * 《AI 概念配对闯关》核心逻辑
 * ------------------------------------------------------------
 * 设计说明：
 *  - 无任何外部依赖与网络请求，双击 index.html 即可运行（离线可用）
 *  - 状态机：idle（待开始）→ playing（进行中）→ ended（结算）
 *  - 计分：每组配对 +100，连击每次额外 +20×连击数；配错 -15 并清零连击
 *  - 反馈：翻牌动画、正误配色、抖动、Web Audio 合成音效（无版权素材）
 *  - 存档：localStorage 保存最高分与错题本（错题本在下一局会被优先抽到）
 */

(function () {
  'use strict';

  // ============ DOM ============
  const el = {
    board:        document.getElementById('board'),
    timer:        document.getElementById('timer'),
    score:        document.getElementById('score'),
    combo:        document.getElementById('combo'),
    progress:     document.getElementById('progress'),
    overlay:      document.getElementById('overlay'),
    overlayTitle: document.getElementById('overlay-title'),
    overlayText:  document.getElementById('overlay-text'),
    overlayStats: document.getElementById('overlay-stats'),
    wrongList:    document.getElementById('wrong-list'),
    btnStart:     document.getElementById('btn-start'),
    btnRestart:   document.getElementById('btn-restart'),
    btnSound:     document.getElementById('btn-sound'),
    levelInputs:  document.querySelectorAll('input[name="level"]'),
    bestEasy:     document.getElementById('best-easy'),
    bestNormal:   document.getElementById('best-normal'),
    bestHard:     document.getElementById('best-hard')
  };

  // ============ 状态 ============
  const state = {
    phase: 'idle',        // idle | playing | ended
    level: 'easy',
    deck: [],             // [{id, pairId, type:'term'|'def', text}]
    firstPick: null,
    lock: false,          // 动画期间锁定点击
    matched: 0,
    totalPairs: 0,
    score: 0,
    combo: 0,
    maxCombo: 0,
    wrongCount: 0,
    secondsLeft: 0,
    timerId: null,
    soundOn: true
  };

  const STORE_KEY = 'ai-match-game-v1';

  // ============ 存档 ============
  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return { best: { easy: 0, normal: 0, hard: 0 }, wrong: [] };
      const obj = JSON.parse(raw);
      // 容错：字段缺失时补默认值
      return {
        best: Object.assign({ easy: 0, normal: 0, hard: 0 }, obj.best || {}),
        wrong: Array.isArray(obj.wrong) ? obj.wrong.slice(0, 30) : []
      };
    } catch (e) {
      console.warn('读取存档失败，使用默认值：', e);
      return { best: { easy: 0, normal: 0, hard: 0 }, wrong: [] };
    }
  }

  function saveStore(store) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (e) {
      console.warn('保存存档失败（可能是隐私模式）：', e);
    }
  }

  let store = loadStore();

  function renderBest() {
    el.bestEasy.textContent = store.best.easy || 0;
    el.bestNormal.textContent = store.best.normal || 0;
    el.bestHard.textContent = store.best.hard || 0;
  }

  // ============ 音效（Web Audio 合成，无需素材）============
  let audioCtx = null;
  function beep(freq, duration, type) {
    if (!state.soundOn) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch (e) {
      // 浏览器不支持或被策略拦截时静默降级
    }
  }
  const sfx = {
    flip:   () => beep(520, 0.08, 'triangle'),
    match:  () => { beep(740, 0.1, 'sine'); setTimeout(() => beep(980, 0.12, 'sine'), 90); },
    wrong:  () => beep(180, 0.18, 'sawtooth'),
    win:    () => { [660, 880, 1100].forEach((f, i) => setTimeout(() => beep(f, 0.15, 'sine'), i * 120)); },
    lose:   () => { [400, 300, 200].forEach((f, i) => setTimeout(() => beep(f, 0.2, 'sine'), i * 150)); }
  };

  // ============ 工具 ============
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** 抽题：一半名额给错题本里的术语，其余随机；不足时用随机补 */
  function pickQuestions(pairCount) {
    const wrongTerms = new Set(store.wrong.map(w => w.term));
    const wrongPool = QUESTION_BANK.filter(q => wrongTerms.has(q.term));
    const restPool  = QUESTION_BANK.filter(q => !wrongTerms.has(q.term));

    const fromWrong = shuffle(wrongPool).slice(0, Math.floor(pairCount / 2));
    const fromRest  = shuffle(restPool).slice(0, pairCount - fromWrong.length);

    let picked = fromWrong.concat(fromRest);
    if (picked.length < pairCount) {
      const extra = shuffle(QUESTION_BANK.filter(q => picked.indexOf(q) === -1))
        .slice(0, pairCount - picked.length);
      picked = picked.concat(extra);
    }
    return shuffle(picked);
  }

  // ============ 渲染 ============
  function buildDeck(pairCount) {
    const questions = pickQuestions(pairCount);
    const deck = [];
    questions.forEach((q, idx) => {
      deck.push({ uid: 't' + idx, pairId: idx, type: 'term', text: q.term, ch: q.ch });
      deck.push({ uid: 'd' + idx, pairId: idx, type: 'def',  text: q.def,  ch: q.ch });
    });
    return shuffle(deck);
  }

  function renderBoard() {
    el.board.innerHTML = '';
    const cols = state.deck.length <= 12 ? 4 : (state.deck.length <= 16 ? 4 : 5);
    el.board.style.setProperty('--cols', cols);

    state.deck.forEach(card => {
      const btn = document.createElement('button');
      btn.className = 'card card--' + card.type;
      btn.dataset.uid = card.uid;
      btn.dataset.pair = card.pairId;
      btn.type = 'button';
      btn.setAttribute('aria-label', (card.type === 'term' ? '术语卡片：' : '释义卡片：') + card.text);

      const inner = document.createElement('span');
      inner.className = 'card__text';
      inner.textContent = card.text;
      // 长文本自动缩小字号
      if (card.text.length > 18) inner.classList.add('is-long');
      if (card.text.length > 26) inner.classList.add('is-longer');

      btn.appendChild(inner);
      btn.addEventListener('click', onCardClick);
      el.board.appendChild(btn);
    });
  }

  // ============ 交互 ============
  function onCardClick(ev) {
    if (state.phase !== 'playing' || state.lock) return;
    const btn = ev.currentTarget;
    if (btn.classList.contains('is-matched') || btn === state.firstPick) return;

    btn.classList.add('is-open');
    sfx.flip();

    if (!state.firstPick) {
      state.firstPick = btn;
      return;
    }

    const a = state.firstPick;
    const b = btn;
    const samePair = a.dataset.pair === b.dataset.pair;
    const diffType = a.classList.contains('card--term') !== b.classList.contains('card--term');

    if (samePair && diffType) {
      // 配对成功
      state.lock = true;
      state.combo += 1;
      state.maxCombo = Math.max(state.maxCombo, state.combo);
      const gain = 100 + (state.combo - 1) * 20;
      state.score += gain;
      state.matched += 1;

      a.classList.add('is-matched');
      b.classList.add('is-matched');
      sfx.match();
      updateHud();
      showFloat(b, '+' + gain);

      state.firstPick = null;
      setTimeout(() => {
        state.lock = false;
        if (state.matched === state.totalPairs) endGame(true);
      }, 260);
    } else {
      // 配对失败
      state.lock = true;
      state.combo = 0;
      state.score = Math.max(0, state.score - 15);
      state.wrongCount += 1;
      a.classList.add('is-wrong');
      b.classList.add('is-wrong');
      sfx.wrong();
      updateHud();
      rememberWrong(a, b);

      setTimeout(() => {
        a.classList.remove('is-open', 'is-wrong');
        b.classList.remove('is-open', 'is-wrong');
        state.firstPick = null;
        state.lock = false;
      }, 620);
    }
  }

  /** 记录错题（取术语那一张） */
  function rememberWrong(a, b) {
    const termEl = a.classList.contains('card--term') ? a : b;
    const defEl  = a.classList.contains('card--term') ? b : a;
    const term = termEl.querySelector('.card__text').textContent;
    const def  = defEl.querySelector('.card__text').textContent;
    if (!store.wrong.some(w => w.term === term)) {
      store.wrong.unshift({ term: term, def: def });
      store.wrong = store.wrong.slice(0, 30);
      saveStore(store);
    }
  }

  function showFloat(node, text) {
    const tip = document.createElement('span');
    tip.className = 'float';
    tip.textContent = text;
    node.appendChild(tip);
    setTimeout(() => tip.remove(), 700);
  }

  function updateHud() {
    el.score.textContent = state.score;
    el.combo.textContent = state.combo > 1 ? ('×' + state.combo) : '—';
    el.progress.textContent = state.matched + ' / ' + state.totalPairs;
    el.timer.textContent = state.secondsLeft + 's';
    el.timer.classList.toggle('is-danger', state.secondsLeft <= 10);
  }

  // ============ 计时 ============
  function startTimer() {
    clearInterval(state.timerId);
    state.timerId = setInterval(() => {
      state.secondsLeft -= 1;
      if (state.secondsLeft <= 0) {
        state.secondsLeft = 0;
        updateHud();
        endGame(false);
        return;
      }
      updateHud();
    }, 1000);
  }

  // ============ 生命周期 ============
  function startGame() {
    const cfg = LEVELS[state.level];
    state.phase = 'playing';
    state.firstPick = null;
    state.lock = false;
    state.matched = 0;
    state.totalPairs = cfg.pairs;
    state.score = 0;
    state.combo = 0;
    state.maxCombo = 0;
    state.wrongCount = 0;
    state.secondsLeft = cfg.seconds;
    state.deck = buildDeck(cfg.pairs);

    el.overlay.classList.add('is-hidden');
    renderBoard();
    updateHud();
    startTimer();
  }

  function endGame(win) {
    if (state.phase === 'ended') return;
    state.phase = 'ended';
    clearInterval(state.timerId);

    // 时间奖励：通关时按剩余秒数加分
    if (win) {
      state.score += state.secondsLeft * 5;
      sfx.win();
    } else {
      sfx.lose();
    }

    // 最高分
    const old = store.best[state.level] || 0;
    const isNewBest = state.score > old;
    if (isNewBest) {
      store.best[state.level] = state.score;
      saveStore(store);
      renderBest();
    }

    // 结算面板
    const cfg = LEVELS[state.level];
    el.overlayTitle.textContent = win ? '🎉 全部配对成功！' : '⏰ 时间到，没能全部完成';
    el.overlayText.textContent  = win
      ? '本局完成 ' + cfg.pairs + ' 组配对，剩余 ' + state.secondsLeft + ' 秒（剩余时间按 5 分/秒 计入奖励）。'
      : '本局完成 ' + state.matched + ' / ' + state.totalPairs + ' 组，再试一次会更快。';

    const accuracy = state.totalPairs ? Math.round((state.matched / state.totalPairs) * 100) : 0;
    el.overlayStats.innerHTML =
      '<li><b>' + state.score + '</b><span>本局得分' + (isNewBest ? '（新纪录！）' : '') + '</span></li>' +
      '<li><b>' + accuracy + '%</b><span>配对完成率</span></li>' +
      '<li><b>×' + state.maxCombo + '</b><span>最高连击</span></li>' +
      '<li><b>' + state.wrongCount + '</b><span>配错次数</span></li>';

    // 错题本
    if (store.wrong.length) {
      el.wrongList.innerHTML = store.wrong.slice(0, 6).map(w =>
        '<li><b>' + escapeHtml(w.term) + '</b> — ' + escapeHtml(w.def) + '</li>'
      ).join('');
      el.wrongList.parentElement.classList.remove('is-hidden');
    } else {
      el.wrongList.parentElement.classList.add('is-hidden');
    }

    el.overlay.classList.remove('is-hidden');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  // ============ 事件绑定 ============
  el.btnStart.addEventListener('click', startGame);
  el.btnRestart.addEventListener('click', () => {
    el.overlay.classList.add('is-hidden');
    startGame();
  });

  el.levelInputs.forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) {
        state.level = input.value;
        // 换难度立即重开一局，避免残留旧牌面
        if (state.phase === 'playing') {
          clearInterval(state.timerId);
          startGame();
        }
      }
    });
  });

  el.btnSound.addEventListener('click', () => {
    state.soundOn = !state.soundOn;
    el.btnSound.textContent = state.soundOn ? '🔊 音效开' : '🔇 音效关';
    el.btnSound.setAttribute('aria-pressed', String(state.soundOn));
  });

  // 键盘：数字键 1/2/3 选难度，Enter 开始
  document.addEventListener('keydown', ev => {
    if (state.phase === 'playing') return;
    if (ev.key === 'Enter') { startGame(); }
    if (ev.key === '1' || ev.key === '2' || ev.key === '3') {
      const map = { '1': 'easy', '2': 'normal', '3': 'hard' };
      state.level = map[ev.key];
      document.querySelector('input[name="level"][value="' + map[ev.key] + '"]').checked = true;
    }
  });

  // ============ 初始化 ============
  renderBest();
  updateHud();
})();
