/* ============================================================
   APP, Estado global e lógica de UI
   ============================================================ */

(function () {
  'use strict';

  /* ============================================================
     ESTADO
     ============================================================ */
  const state = {
    mode: 'simulation',          // 'simulation' | 'api'
    model: 'sim-flash',          // modelo atualmente selecionado
    contextWindow: 200,          // tokens
    tokenLimit: 5000,            // tokens (alerta)
    hallucinate: false,          // alucinação em sim mode
    history: [],                 // [{role, content, tokens, totalTokens, inputTokens, outputTokens, cumulativeTokens, timestamp, msgIndex}]
    facts: [],                   // [{type, value, msgIndex}]
    cumulativeTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    sending: false,
  };

  /* ============================================================
     PRICING (USD per 1M tokens)
     ============================================================ */
  const PRICING = {
    'sim-flash':         { input: 0.10, output: 0.30 },
    'sim-pro':           { input: 0.50, output: 1.50 },
    'gemini-2.5-flash':  { input: 0.10, output: 0.30 },
    'gemini-2.5-pro':    { input: 1.25, output: 5.00 },
    'gemini-2.0-flash':  { input: 0.10, output: 0.30 },
  };

  /* ============================================================
     ELEMENTOS DOM
     ============================================================ */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const el = {
    // Mode
    modeSim: $('#mode-sim'),
    modeApi: $('#mode-api'),
    apiBanner: $('#api-banner'),
    apiKeyInput: $('#api-key-input'),
    apiKeySave: $('#api-key-save'),
    apiKeyClear: $('#api-key-clear'),
    apiKeyStatus: $('#api-key-status'),
    // Config
    modelSelect: $('#model-select'),
    contextWindow: $('#context-window'),
    contextWindowValue: $('#context-window-value'),
    tokenLimit: $('#token-limit'),
    tokenLimitValue: $('#token-limit-value'),
    hallucinateToggle: $('#hallucinate-toggle'),
    hallucinateField: $('#hallucinate-field'),
    clearBtn: $('#clear-btn'),
    demoBtns: $$('.demo-btn'),
    // Metrics
    mMessages: $('#m-messages'),
    mTotalTokens: $('#m-total-tokens'),
    mAvgTokens: $('#m-avg-tokens'),
    mCost: $('#m-cost'),
    progressFill: $('#progress-fill'),
    progressPercent: $('#progress-percent'),
    limitAlert: $('#limit-alert'),
    // Chat
    chatMessages: $('#chat-messages'),
    chatForm: $('#chat-form'),
    chatInput: $('#chat-input'),
    sendBtn: $('#send-btn'),
    cwiCurrent: $('#cwi-current'),
    cwiMax: $('#cwi-max'),
    // Viz
    tabs: $$('.tab'),
    tabPanels: $$('.tab-panel'),
    windowViz: $('#window-viz'),
    detailsTbody: $('#details-tbody'),
    // Toast
    toastContainer: $('#toast-container'),
  };

  /* ============================================================
     UTILS
     ============================================================ */
  function formatNumber(n) {
    return n.toLocaleString('pt-BR');
  }
  function formatCost(usd) {
    // Mostrar até 4 casas decimais quando muito pequeno
    if (usd < 0.01) return '$' + usd.toFixed(4).replace('.', ',');
    return '$' + usd.toFixed(2).replace('.', ',');
  }
  function calculateCost(model, inputTokens, outputTokens) {
    const p = PRICING[model] || { input: 0.20, output: 0.20 };
    return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
  }
  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  function renderMarkdown(str) {
    // Suporte mínimo de markdown: **bold** e *italic* e `code` e quebras de linha
    let s = escapeHTML(str);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');
    s = s.replace(/_([^_\n]+?)_/g, '<em>$1</em>');
    s = s.replace(/`([^`]+?)`/g, '<code>$1</code>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }
  function toast(message, type = 'info', durationMs = 3000) {
    const div = document.createElement('div');
    div.className = `toast ${type}`;
    div.textContent = message;
    el.toastContainer.appendChild(div);
    setTimeout(() => {
      div.style.opacity = '0';
      div.style.transform = 'translateX(20px)';
      div.style.transition = 'all .2s';
      setTimeout(() => div.remove(), 220);
    }, durationMs);
  }

  /* ============================================================
     MODE TOGGLE
     ============================================================ */
  function setMode(mode) {
    state.mode = mode;
    el.modeSim.classList.toggle('active', mode === 'simulation');
    el.modeApi.classList.toggle('active', mode === 'api');
    el.modeSim.setAttribute('aria-selected', mode === 'simulation');
    el.modeApi.setAttribute('aria-selected', mode === 'api');
    el.apiBanner.hidden = mode !== 'api';
    el.hallucinateField.style.display = mode === 'simulation' ? '' : 'none';

    // Ajustar modelo conforme modo
    if (mode === 'simulation') {
      if (!state.model.startsWith('sim-')) {
        state.model = 'sim-flash';
        el.modelSelect.value = 'sim-flash';
      }
    } else {
      if (state.model.startsWith('sim-')) {
        state.model = 'gemini-2.5-flash';
        el.modelSelect.value = 'gemini-2.5-flash';
      }
    }
    updateMetrics();
  }

  el.modeSim.addEventListener('click', () => setMode('simulation'));
  el.modeApi.addEventListener('click', () => setMode('api'));

  /* ============================================================
     API KEY UI
     ============================================================ */
  function refreshApiKeyStatus() {
    if (GeminiClient.hasApiKey()) {
      el.apiKeyStatus.textContent = '✓ Configurada e salva neste navegador';
      el.apiKeyStatus.className = 'ok';
      el.apiKeyInput.value = '';
      el.apiKeyInput.placeholder = '••••••••••••••••••••';
    } else {
      el.apiKeyStatus.textContent = 'Não configurada, modo API não funcionará';
      el.apiKeyStatus.className = '';
      el.apiKeyInput.placeholder = 'AIza...';
    }
  }

  el.apiKeySave.addEventListener('click', () => {
    const k = el.apiKeyInput.value.trim();
    if (!k) {
      toast('Cole a chave antes de salvar', 'error');
      return;
    }
    if (!k.startsWith('AIza')) {
      toast('Chave do Gemini começa com "AIza". Verifique.', 'error');
      return;
    }
    GeminiClient.setApiKey(k);
    refreshApiKeyStatus();
    toast('Chave salva no localStorage do navegador', 'success');
  });

  el.apiKeyClear.addEventListener('click', () => {
    GeminiClient.setApiKey('');
    refreshApiKeyStatus();
    toast('Chave removida', 'info');
  });

  /* ============================================================
     MODEL / SLIDERS / TOGGLES
     ============================================================ */
  el.modelSelect.addEventListener('change', (e) => {
    state.model = e.target.value;
    // Se selecionou modelo Gemini real, mudar para modo API
    if (!state.model.startsWith('sim-') && state.mode !== 'api') {
      setMode('api');
    } else if (state.model.startsWith('sim-') && state.mode !== 'simulation') {
      setMode('simulation');
    }
    updateMetrics();
  });

  el.contextWindow.addEventListener('input', (e) => {
    state.contextWindow = parseInt(e.target.value, 10);
    el.contextWindowValue.textContent = `${formatNumber(state.contextWindow)} tokens`;
    el.cwiMax.textContent = formatNumber(state.contextWindow);
    // Recalcular quais mensagens estão na janela com o novo tamanho
    updateAllVisualizations();
  });

  el.tokenLimit.addEventListener('input', (e) => {
    state.tokenLimit = parseInt(e.target.value, 10);
    el.tokenLimitValue.textContent = `${formatNumber(state.tokenLimit)} tokens`;
    updateProgressBar();
  });

  el.hallucinateToggle.addEventListener('change', (e) => {
    state.hallucinate = e.target.checked;
    toast(state.hallucinate
      ? 'Alucinação ativada: a IA inventará respostas erradas quando perder contexto'
      : 'Alucinação desativada: a IA admitirá quando não souber', 'info');
  });

  el.clearBtn.addEventListener('click', () => {
    if (state.history.length === 0) return;
    if (confirm('Limpar todo o histórico da conversa?')) {
      clearHistory();
      toast('Histórico limpo', 'info');
    }
  });

  /* ============================================================
     TABS
     ============================================================ */
  el.tabs.forEach(t => {
    t.addEventListener('click', () => {
      const target = t.dataset.tab;
      el.tabs.forEach(x => x.classList.toggle('active', x === t));
      el.tabPanels.forEach(p => p.classList.toggle('active', p.id === `tab-${target}`));
    });
  });

  /* ============================================================
     CHAT INPUT
     ============================================================ */
  el.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      el.chatForm.requestSubmit();
    }
  });
  // Auto-resize textarea
  el.chatInput.addEventListener('input', () => {
    el.chatInput.style.height = 'auto';
    el.chatInput.style.height = Math.min(el.chatInput.scrollHeight, 120) + 'px';
  });

  el.chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const userMsg = el.chatInput.value.trim();
    if (!userMsg || state.sending) return;

    state.sending = true;
    el.sendBtn.disabled = true;
    el.chatInput.disabled = true;

    try {
      await sendMessage(userMsg);
      el.chatInput.value = '';
      el.chatInput.style.height = 'auto';
    } catch (err) {
      console.error(err);
      toast(err.message || 'Erro ao enviar mensagem', 'error', 5000);
    } finally {
      state.sending = false;
      el.sendBtn.disabled = false;
      el.chatInput.disabled = false;
      el.chatInput.focus();
    }
  });

  /* ============================================================
     ENVIO DE MENSAGEM (núcleo)
     ============================================================ */
  async function sendMessage(userMsg) {
    // 1) Registrar mensagem do usuário no histórico
    const userTokens = Simulation.countTokens(userMsg);
    const userIdx = state.history.length;
    state.cumulativeTokens += userTokens;
    state.history.push({
      role: 'user',
      content: userMsg,
      tokens: userTokens,
      inputTokens: userTokens,
      outputTokens: 0,
      totalTokens: userTokens,
      cumulativeTokens: state.cumulativeTokens,
      timestamp: new Date(),
      msgIndex: userIdx,
    });

    // Render parcial: mostrar a msg do usuário e indicador de typing
    renderChat();
    showTypingIndicator();
    scrollChatToBottom();

    // 2) Chamar IA (simulação ou real)
    let aiResult;
    try {
      if (state.mode === 'simulation') {
        aiResult = await simulateAICall(userMsg);
      } else {
        aiResult = await callRealGemini(userMsg);
      }
    } catch (err) {
      hideTypingIndicator();
      // Reverter: remover mensagem do usuário do histórico
      state.history.pop();
      state.cumulativeTokens -= userTokens;
      renderChat();
      throw err;
    }

    // 3) Detectar fatos novos da mensagem do usuário e armazenar
    const newFacts = Simulation.extractFacts(userMsg);
    for (const f of newFacts) {
      // Atualizar fato se já existe (mesmo type) ou adicionar
      const existing = state.facts.find(x => x.type === f.type);
      if (existing) {
        existing.value = f.value;
        existing.msgIndex = userIdx;
      } else {
        state.facts.push({ ...f, msgIndex: userIdx });
      }
    }

    // 4) Registrar resposta da IA no histórico
    hideTypingIndicator();
    state.cumulativeTokens += aiResult.outputTokens;
    state.totalInputTokens += aiResult.inputTokens;
    state.totalOutputTokens += aiResult.outputTokens;
    state.history.push({
      role: 'assistant',
      content: aiResult.content,
      tokens: aiResult.outputTokens,
      inputTokens: aiResult.inputTokens,
      outputTokens: aiResult.outputTokens,
      totalTokens: aiResult.totalTokens,
      cumulativeTokens: state.cumulativeTokens,
      timestamp: new Date(),
      msgIndex: state.history.length,
    });

    // 5) Re-render geral
    updateAllVisualizations();
    scrollChatToBottom();
  }

  function simulateAICall(userMsg) {
    return new Promise((resolve) => {
      // Simula latência para parecer realista
      setTimeout(() => {
        const result = Simulation.send(
          { history: state.history.slice(0, -1), facts: state.facts },
          userMsg,
          { hallucinate: state.hallucinate, contextWindow: state.contextWindow }
        );
        resolve({
          content: result.content,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          totalTokens: result.totalTokens,
        });
      }, 350 + Math.random() * 600);
    });
  }

  async function callRealGemini(userMsg) {
    if (!GeminiClient.hasApiKey()) {
      throw new Error('Configure sua API key do Gemini no banner amarelo no topo da página.');
    }
    // O histórico para a API exclui a última msg (que é a do usuário recém-adicionada)
    const historyForApi = state.history.slice(0, -1).map(m => ({
      role: m.role, content: m.content,
    }));
    return GeminiClient.send({
      model: state.model,
      history: historyForApi,
      userMsg,
    });
  }

  /* ============================================================
     RENDER: CHAT
     ============================================================ */
  function renderChat() {
    if (state.history.length === 0) {
      el.chatMessages.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">👋</div>
          <h3>Comece a conversa</h3>
          <p>Digite uma mensagem para ver a janela de contexto crescer em tempo real.</p>
          <div class="empty-tips">
            <p><strong>Dica para professores:</strong></p>
            <ol>
              <li>Defina a janela em <strong>150 tokens</strong></li>
              <li>Digite: <em>"Meu nome é Maria, tenho 30 anos e moro no Rio"</em></li>
              <li>Faça outras 4-5 perguntas</li>
              <li>Pergunte: <em>"Qual meu nome?"</em></li>
              <li>Veja a IA esquecer ao vivo 🎓</li>
            </ol>
          </div>
        </div>
      `;
      return;
    }

    const inWindow = Simulation.computeInWindow(state.history, state.contextWindow);
    el.chatMessages.innerHTML = state.history.map((msg, i) => {
      const isOut = !inWindow.has(i);
      const roleLabel = msg.role === 'user' ? 'Você' : 'Assistente';
      const time = msg.timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      return `
        <div class="message ${msg.role}${isOut ? ' out-of-context' : ''}">
          <span class="message-role">${roleLabel}</span>
          <div class="message-content">${renderMarkdown(msg.content)}</div>
          <div class="message-meta">
            <span>🔢 ${formatNumber(msg.tokens)} tokens</span>
            <span>⏱ ${time}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function showTypingIndicator() {
    const div = document.createElement('div');
    div.id = 'typing-indicator';
    div.className = 'message assistant';
    div.innerHTML = `
      <span class="message-role">Assistente</span>
      <div class="typing"><span></span><span></span><span></span></div>
    `;
    el.chatMessages.appendChild(div);
  }
  function hideTypingIndicator() {
    const t = document.getElementById('typing-indicator');
    if (t) t.remove();
  }
  function scrollChatToBottom() {
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  }

  /* ============================================================
     RENDER: METRICS & PROGRESS
     ============================================================ */
  function updateMetrics() {
    const total = state.cumulativeTokens;
    const msgs = state.history.length;
    const avg = msgs > 0 ? (total / msgs).toFixed(1) : '0';
    const cost = calculateCost(state.model, state.totalInputTokens, state.totalOutputTokens);

    el.mMessages.textContent = formatNumber(msgs);
    el.mTotalTokens.textContent = formatNumber(total);
    el.mAvgTokens.textContent = avg;
    el.mCost.textContent = formatCost(cost);

    updateProgressBar();
    updateContextWindowIndicator();
  }

  function updateProgressBar() {
    const pct = Math.min((state.cumulativeTokens / state.tokenLimit) * 100, 100);
    el.progressFill.style.width = pct + '%';
    el.progressPercent.textContent = pct.toFixed(1) + '%';

    el.progressFill.classList.remove('warn', 'danger');
    if (pct >= 100) el.progressFill.classList.add('danger');
    else if (pct >= 80) el.progressFill.classList.add('warn');

    el.limitAlert.classList.remove('warn', 'danger');
    if (pct >= 100) {
      el.limitAlert.hidden = false;
      el.limitAlert.classList.add('danger');
      el.limitAlert.textContent = '🚨 Limite de alerta excedido!';
    } else if (pct >= 80) {
      el.limitAlert.hidden = false;
      el.limitAlert.classList.add('warn');
      el.limitAlert.textContent = `⚠️ ${pct.toFixed(0)}% do limite atingido`;
    } else {
      el.limitAlert.hidden = true;
    }
  }

  function updateContextWindowIndicator() {
    // Quantos tokens estão atualmente DENTRO da janela
    const inWindow = Simulation.computeInWindow(state.history, state.contextWindow);
    let tokensInWindow = 0;
    state.history.forEach((m, i) => {
      if (inWindow.has(i)) tokensInWindow += m.tokens;
    });

    el.cwiCurrent.textContent = formatNumber(tokensInWindow);
    el.cwiMax.textContent = formatNumber(state.contextWindow);

    el.cwiCurrent.classList.remove('warn', 'danger');
    const pct = tokensInWindow / state.contextWindow;
    if (pct >= 0.95) el.cwiCurrent.classList.add('danger');
    else if (pct >= 0.75) el.cwiCurrent.classList.add('warn');
  }

  /* ============================================================
     RENDER: WINDOW VIZ (estrela do show)
     ============================================================ */
  function renderWindowViz() {
    if (state.history.length === 0) {
      el.windowViz.innerHTML = '<div class="empty-viz">Envie mensagens para ver a visualização.</div>';
      return;
    }

    const inWindow = Simulation.computeInWindow(state.history, state.contextWindow);
    el.windowViz.innerHTML = state.history.map((msg, i) => {
      const isIn = inWindow.has(i);
      const role = msg.role === 'user' ? 'Você' : 'IA';
      const preview = msg.content.length > 80 ? msg.content.slice(0, 80) + '…' : msg.content;
      return `
        <div class="window-row ${isIn ? 'in' : 'out'}">
          <div class="window-row-id">#${i + 1}</div>
          <div class="window-row-role">${isIn ? '✓' : '✕'} ${role}</div>
          <div class="window-row-preview">${escapeHTML(preview)}</div>
          <div class="window-row-tokens">${formatNumber(msg.tokens)} tok</div>
        </div>
      `;
    }).join('');
  }

  /* ============================================================
     RENDER: DETAILS TABLE
     ============================================================ */
  function renderDetailsTable() {
    if (state.history.length === 0) {
      el.detailsTbody.innerHTML = '<tr><td colspan="6" class="empty-cell">Sem dados ainda</td></tr>';
      return;
    }
    const inWindow = Simulation.computeInWindow(state.history, state.contextWindow);
    el.detailsTbody.innerHTML = state.history.map((m, i) => {
      const preview = m.content.length > 100 ? m.content.slice(0, 100) + '…' : m.content;
      const isIn = inWindow.has(i);
      const role = m.role === 'user' ? 'Usuário' : 'Assistente';
      const time = m.timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `
        <tr>
          <td class="num">${i + 1}</td>
          <td>${role}</td>
          <td class="num">${formatNumber(m.tokens)}</td>
          <td class="num">${formatNumber(m.cumulativeTokens)}</td>
          <td><span class="status-pill ${isIn ? 'in' : 'out'}">${isIn ? '✓ Na janela' : '✕ Fora'}</span></td>
          <td class="preview-cell" title="${escapeHTML(m.content)}">${escapeHTML(preview)}</td>
        </tr>
      `;
    }).join('');
  }

  /* ============================================================
     RENDER MASTER
     ============================================================ */
  function updateAllVisualizations() {
    renderChat();
    updateMetrics();
    renderWindowViz();
    renderDetailsTable();
    ChartsModule.updateGrowth(state.history);
    ChartsModule.updateBars(state.history);
  }

  function clearHistory() {
    state.history = [];
    state.facts = [];
    state.cumulativeTokens = 0;
    state.totalInputTokens = 0;
    state.totalOutputTokens = 0;
    updateAllVisualizations();
  }

  /* ============================================================
     DEMOS PRÉ-PROGRAMADAS
     Cada demo zera o histórico e roda uma sequência de mensagens
     para o professor demonstrar um conceito específico.
     ============================================================ */
  const DEMOS = {
    'memory-loss': {
      title: '🎭 Demo: A IA esqueceu meu nome',
      contextWindow: 150,
      hallucinate: false,
      messages: [
        'Meu nome é Maria, tenho 30 anos e moro no Rio de Janeiro.',
        'Você pode me explicar o que são embeddings?',
        'E qual a diferença entre embedding multimodal e geração multimodal?',
        'Me dá exemplos de aplicações práticas de embeddings.',
        'Qual meu nome?',
      ],
    },
    'growth': {
      title: '📈 Demo: Crescimento da janela',
      contextWindow: 800,
      hallucinate: false,
      messages: [
        'Oi',
        'O que é tokenização?',
        'Explica como funciona a janela de contexto',
        'O que é um intervalo (chunk) e quando usar?',
        'Liste exemplos de bancos de vetores',
      ],
    },
    'hallucination': {
      title: '🌀 Demo: Alucinação ao perder contexto',
      contextWindow: 200,
      hallucinate: true,
      messages: [
        'Meu nome é Ricardo e minha comida favorita é lasanha.',
        'Explica em detalhes os cinco tipos de aprendizado de máquina, com exemplos.',
        'E qual a diferença entre aprendizado federado e por transferência? Detalha bem.',
        'Qual minha comida favorita?',
      ],
    },
  };

  el.demoBtns.forEach(btn => {
    btn.addEventListener('click', () => runDemo(btn.dataset.demo));
  });

  async function runDemo(name) {
    const demo = DEMOS[name];
    if (!demo) return;
    if (state.mode === 'api' && !GeminiClient.hasApiKey()) {
      // Forçar simulação para demo
      setMode('simulation');
      toast('Modo simulação ativado para a demo', 'info');
    } else if (state.mode === 'api') {
      const ok = confirm('Esta demo usará chamadas reais à API (gastos $$). Deseja rodar em modo simulação?');
      if (ok) setMode('simulation');
    }

    clearHistory();
    state.contextWindow = demo.contextWindow;
    el.contextWindow.value = demo.contextWindow;
    el.contextWindowValue.textContent = `${formatNumber(demo.contextWindow)} tokens`;
    el.cwiMax.textContent = formatNumber(demo.contextWindow);
    state.hallucinate = demo.hallucinate;
    el.hallucinateToggle.checked = demo.hallucinate;
    updateAllVisualizations();

    toast(demo.title + ', rodando...', 'info', 2000);
    for (const msg of demo.messages) {
      try {
        await sendMessage(msg);
        // Pausa entre mensagens para o efeito visual
        await new Promise(r => setTimeout(r, 600));
      } catch (err) {
        toast('Demo interrompida: ' + err.message, 'error');
        break;
      }
    }
    // Dica final para a melhor demo
    if (name === 'memory-loss' || name === 'hallucination') {
      toast('🎓 Note como a IA "esqueceu" ou "inventou" porque a 1ª mensagem saiu da janela', 'success', 6000);
    }
  }

  /* ============================================================
     INICIALIZAÇÃO
     ============================================================ */
  function init() {
    // Inicializar valores
    el.contextWindowValue.textContent = `${formatNumber(state.contextWindow)} tokens`;
    el.tokenLimitValue.textContent = `${formatNumber(state.tokenLimit)} tokens`;
    el.cwiMax.textContent = formatNumber(state.contextWindow);

    // Gráficos
    ChartsModule.initGrowthChart(document.getElementById('chart-growth'));
    ChartsModule.initBarsChart(document.getElementById('chart-bars'));

    // Status da API key
    refreshApiKeyStatus();

    // Render inicial
    updateAllVisualizations();

    // Detectar se já tem chave salva, não trocar de modo, apenas avisar
    if (GeminiClient.hasApiKey()) {
      console.log('[CWM] API key encontrada no localStorage. Modo API disponível.');
    }
  }

  // Bootstrap quando DOM e Chart.js prontos
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
