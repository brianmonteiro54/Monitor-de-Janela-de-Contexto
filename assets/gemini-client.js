/* ============================================================
   GEMINI CLIENT — chamadas reais à API do Google Gemini
   diretamente do navegador. A chave fica em localStorage e é
   enviada no header da requisição.
   Doc: https://ai.google.dev/api/rest/v1/models/generateContent
   ============================================================ */

const GeminiClient = (() => {

  const STORAGE_KEY = 'cwm.apiKey';

  function getApiKey() {
    return localStorage.getItem(STORAGE_KEY) || '';
  }
  function setApiKey(k) {
    if (k && k.trim()) localStorage.setItem(STORAGE_KEY, k.trim());
    else localStorage.removeItem(STORAGE_KEY);
  }
  function hasApiKey() {
    const k = getApiKey();
    return k && k.length > 8 && k.startsWith('AIza');
  }

  /* Converte o histórico interno do app para o formato esperado pela API.
     contents: [{ role: 'user'|'model', parts: [{ text: '...' }] }]
  */
  function buildContents(history) {
    return history.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
  }

  /* Envia mensagem real para Gemini.
     model: nome do modelo (ex: 'gemini-2.5-flash')
     history: lista de mensagens anteriores [{role, content}]
     userMsg: nova mensagem do usuário
     Retorna { content, inputTokens, outputTokens, totalTokens }
  */
  async function send({ model, history, userMsg }) {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error('API key não configurada. Configure no banner amarelo no topo.');
    }

    const fullHistory = [
      ...buildContents(history),
      { role: 'user', parts: [{ text: userMsg }] },
    ];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: fullHistory,
          generationConfig: { temperature: 0.7 },
        }),
      });
    } catch (e) {
      throw new Error('Falha de rede ao chamar a API: ' + e.message);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      let errMsg = `Erro HTTP ${response.status}`;
      try {
        const j = JSON.parse(errBody);
        if (j.error?.message) errMsg = j.error.message;
      } catch {}
      if (response.status === 400 && /API key/i.test(errMsg)) {
        throw new Error('API key inválida. Verifique a chave no banner do topo.');
      }
      if (response.status === 429) {
        throw new Error('Limite de requisições excedido. Aguarde alguns segundos.');
      }
      throw new Error(errMsg);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new Error('A API retornou sem candidates. Resposta: ' + JSON.stringify(data));
    }

    const content = (candidate.content?.parts || [])
      .map(p => p.text || '')
      .join('');

    const usage = data.usageMetadata || {};
    return {
      content: content || '(resposta vazia)',
      inputTokens:  usage.promptTokenCount      || 0,
      outputTokens: usage.candidatesTokenCount  || 0,
      totalTokens:  usage.totalTokenCount       || 0,
    };
  }

  return {
    getApiKey, setApiKey, hasApiKey, send,
  };
})();

window.GeminiClient = GeminiClient;
