/* ============================================================
   MOTOR DE SIMULAÇÃO
   IA simulada que demonstra o comportamento real de um LLM
   quando a janela de contexto é excedida.

   COMO FUNCIONA:
   1. Rastreia "fatos" que o usuário compartilha (nome, idade, etc.)
   2. Cada fato fica associado à mensagem em que apareceu
   3. Quando o usuário pergunta sobre um fato, a IA só responde se
      a mensagem original ainda estiver dentro da janela de contexto
   4. Caso contrário: responde "não sei" OU alucina (configurável)
   ============================================================ */

const Simulation = (() => {

  /* -------- TOKENIZAÇÃO APROXIMADA --------
     Regra prática usada pelos provedores: ~1 token ≈ 0.75 palavras em inglês,
     ou ~4 caracteres. Em português é parecido (~3.5–4 chars/token).
     Vamos contar por caracteres com fator 4, com piso de 1.
  */
  function countTokens(text) {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
  }

  /* -------- EXTRATOR DE FATOS --------
     Detecta declarações comuns que o usuário faz sobre si próprio.
     Cada fato detectado tem um "tipo" (name, age, location, ...) e o valor.
  */
  const FACT_PATTERNS = [
    // Nome
    { type: 'name',     re: /(?:meu nome (?:é|eh|e)|me chamo|sou (?:a|o)|eu sou (?:a|o)) ([A-ZÀ-Ú][a-zà-ú]+(?:\s[A-ZÀ-Ú][a-zà-ú]+)?)/i, group: 1 },
    { type: 'name',     re: /^(?:[Ee]u\s+)?[Ss]ou\s+([A-ZÀ-Ú][a-zà-ú]+(?:\s[A-ZÀ-Ú][a-zà-ú]+)?)(?:[.,!?\s]|$)/, group: 1 },
    { type: 'name',     re: /^([A-ZÀ-Ú][a-zà-ú]+) aqui[.!]?$/i, group: 1 },
    // Idade
    { type: 'age',      re: /(?:tenho|com)\s+(\d{1,3})\s+anos?/i, group: 1 },
    { type: 'age',      re: /(\d{1,3})\s+anos\s+de\s+idade/i, group: 1 },
    // Localização
    { type: 'location', re: /(?:moro|vivo|estou)\s+(?:em|no|na)\s+([A-ZÀ-Ú][a-zà-úA-ZÀ-Ú\s]+?)(?:[.,!?]|$| e | com )/i, group: 1 },
    { type: 'location', re: /sou\s+(?:de|do|da)\s+([A-ZÀ-Ú][a-zà-úA-ZÀ-Ú\s]+?)(?:[.,!?]|$| e | com )/i, group: 1 },
    // Profissão
    { type: 'job',      re: /trabalho\s+como\s+([a-zà-ú]+(?:o|a|or|ora|ista|eiro|eira|ente))(?:[.,!?\s]|$)/i, group: 1 },
    { type: 'job',      re: /(?:eu\s+)?sou\s+([a-zà-ú]+(?:dor|dora|ista|eiro|eira|ente|ico|ica|ólogo|óloga|ário|ária))(?:[.,!?\s]|$)/i, group: 1 },
    { type: 'job',      re: /minha profissão (?:é|eh|e)\s+([a-zà-ú]+)/i, group: 1 },
    // Hobby / gosto — usar \b para evitar casar "amo" dentro de "chamo"
    { type: 'hobby',    re: /\b(?:meu hobby (?:é|eh|e)|adoro|gosto de|amo)\s+([a-zà-ú]+(?:\s[a-zà-ú]+){0,2})/i, group: 1 },
    // Comida favorita — exige forma de afirmação
    { type: 'food',     re: /(?:minha comida favorita|prato favorito|comida preferida)\s+(?:é|eh|e)\s+([a-zà-úA-ZÀ-Ú\s]+?)(?:[.,!?]|$)/i, group: 1 },
    // Animal de estimação
    { type: 'pet',      re: /(?:tenho|meu)\s+(?:um|uma)?\s*(gato|cachorro|cão|peixe|coelho|hamster|papagaio|tartaruga)/i, group: 1 },
    { type: 'pet_name', re: /(?:meu (?:gato|cachorro|cão|pet) (?:se chama|chama-se|é|eh|e))\s+([A-ZÀ-Ú][a-zà-ú]+)/i, group: 1 },
    // Aniversário / mês
    { type: 'birthday', re: /(?:meu aniversário|nasci)\s+(?:é\s+)?em\s+([a-zà-ú]+)/i, group: 1 },
    // Cor favorita
    { type: 'color',    re: /(?:cor favorita|cor preferida)\s+(?:é|eh|e)\s+([a-zà-ú]+)/i, group: 1 },
    // Número favorito
    { type: 'number',   re: /(?:número favorito|número preferido)\s+(?:é|eh|e)\s+(\d+)/i, group: 1 },
    // Linguagem de programação favorita
    { type: 'language', re: /(?:linguagem favorita|melhor linguagem|prefiro programar em)\s+([A-Za-z+#]+)/i, group: 1 },
  ];

  function extractFacts(message) {
    const facts = [];
    for (const p of FACT_PATTERNS) {
      const m = message.match(p.re);
      if (m && m[p.group]) {
        let value = m[p.group].trim().replace(/\s+/g, ' ');
        // Aparar conectores finais ("tocar violão e" → "tocar violão")
        value = value.replace(/\s+(?:e|ou|com|de|da|do|para|por|no|na|em)$/i, '').trim();
        // Filtrar valores muito curtos ou claramente lixo
        if (value.length >= 2 && value.length <= 60) {
          // Evitar duplicar mesmo tipo na mesma mensagem
          if (!facts.find(f => f.type === p.type)) {
            facts.push({ type: p.type, value });
          }
        }
      }
    }
    return facts;
  }

  /* -------- DETECTOR DE PERGUNTAS SOBRE FATOS --------
     Quando o usuário pergunta "qual meu nome", "onde eu moro", etc.,
     decidimos se a IA "lembra" — só lembra se a mensagem original com o
     fato AINDA estiver dentro da janela de contexto.
  */
  const QUESTION_PATTERNS = [
    { type: 'name',     re: /(?:qual|como)\s+(?:é\s+)?(?:o\s+)?meu\s+nome|quem\s+(?:é|eh|e|sou)\s+eu/i },
    { type: 'name',     re: /você\s+sabe\s+meu\s+nome/i },
    { type: 'age',      re: /(?:qual|quantos?)\s+(?:é\s+)?(?:a\s+)?minha\s+idade|quantos\s+anos\s+(?:eu\s+)?tenho/i },
    { type: 'location', re: /onde\s+(?:eu\s+)?(?:moro|vivo|estou)|qual\s+(?:é\s+)?(?:a\s+)?minha\s+cidade/i },
    { type: 'job',      re: /(?:qual|o que)\s+(?:é\s+)?(?:o que\s+)?eu\s+faço|minha\s+profissão|onde\s+trabalho/i },
    { type: 'hobby',    re: /qual\s+(?:é\s+)?meu\s+hobby|do que\s+(?:eu\s+)?gosto/i },
    { type: 'food',     re: /minha\s+comida\s+(?:favorita|preferida)|prato\s+favorito/i },
    { type: 'pet',      re: /(?:qual|que)\s+(?:é\s+)?(?:o\s+)?meu\s+(?:pet|animal)|tenho\s+(?:algum\s+)?animal/i },
    { type: 'pet_name', re: /(?:qual|como)\s+(?:é\s+)?(?:o\s+)?nome\s+do\s+meu\s+(?:gato|cachorro|cão|pet)/i },
    { type: 'birthday', re: /quando\s+(?:é\s+)?meu\s+aniversário|em\s+que\s+mês\s+(?:eu\s+)?nasci/i },
    { type: 'color',    re: /minha\s+cor\s+(?:favorita|preferida)/i },
    { type: 'number',   re: /meu\s+número\s+(?:favorito|preferido)/i },
    { type: 'language', re: /minha\s+linguagem\s+(?:favorita|preferida)|que\s+linguagem.*(?:gosto|prefiro)/i },
  ];

  function detectFactQuestion(message) {
    // Heurística anti-falso-positivo: só considerar pergunta se tem `?`
    // OU começa com palavra interrogativa (qual, quando, onde, como, quem, quantos)
    const hasQuestionMark = /\?\s*$/.test(message.trim());
    const startsWithQuestion = /^\s*(qual|quando|onde|como|quem|quantos|quanta|que|por\s*qu[eê]|você\s+(?:sabe|lembra))/i.test(message);
    if (!hasQuestionMark && !startsWithQuestion) return null;

    for (const p of QUESTION_PATTERNS) {
      if (p.re.test(message)) return p.type;
    }
    return null;
  }

  /* -------- ALUCINAÇÕES (respostas erradas plausíveis) --------
     Quando o aluno liga "Alucinar ao perder contexto", a IA inventa
     respostas — efeito didático devastador.
  */
  const HALLUCINATIONS = {
    name:     ['João', 'Carlos', 'Ana', 'Pedro', 'Lucas', 'Mariana'],
    age:      ['25', '35', '42', '28', '50'],
    location: ['São Paulo', 'Belo Horizonte', 'Curitiba', 'Salvador', 'Brasília'],
    job:      ['programador', 'professor', 'designer', 'analista'],
    hobby:    ['ler livros', 'jogar videogame', 'andar de bicicleta', 'cozinhar'],
    food:     ['lasanha', 'feijoada', 'pizza', 'sushi'],
    pet:      ['cachorro', 'gato'],
    pet_name: ['Rex', 'Luna', 'Thor', 'Mia'],
    birthday: ['março', 'julho', 'outubro', 'dezembro'],
    color:    ['azul', 'verde', 'vermelho', 'preto'],
    number:   ['7', '13', '42', '21'],
    language: ['Python', 'JavaScript', 'Java', 'Go'],
  };

  function hallucinate(type, realValue) {
    let opts = HALLUCINATIONS[type] || ['algo que não me lembro'];
    // Filtrar o valor real para garantir que a "alucinação" seja sempre ERRADA.
    // Sem isso, o random poderia escolher o mesmo valor que o usuário disse,
    // o que arruinaria a demonstração pedagógica.
    if (realValue) {
      const realLower = String(realValue).toLowerCase().trim();
      const filtered = opts.filter(o => String(o).toLowerCase().trim() !== realLower);
      if (filtered.length > 0) opts = filtered;
    }
    return opts[Math.floor(Math.random() * opts.length)];
  }

  /* -------- RESPOSTAS NATURAIS PARA FRASES COMUNS --------
     Quando o usuário não está perguntando sobre fatos, gerar uma resposta
     contextualmente apropriada que faz a janela CRESCER (que é o ponto).
  */
  function generateContextualResponse(userMsg, knownFacts) {
    const lower = userMsg.toLowerCase();

    // Saudações
    if (/^(oi|olá|ola|hey|bom\s+dia|boa\s+tarde|boa\s+noite|e[ ]?aí)\b/i.test(userMsg)) {
      const nameFact = knownFacts.find(f => f.type === 'name');
      if (nameFact) {
        return `Olá novamente, ${nameFact.value}! Que bom te ver por aqui. Em que posso ajudar agora?`;
      }
      return 'Olá! Tudo bem? Estou aqui para conversar. Pode me contar algo sobre você ou perguntar qualquer coisa.';
    }

    // Despedidas
    if (/^(tchau|até logo|até mais|valeu|obrigad[ao]|flw)/i.test(userMsg)) {
      return 'Foi um prazer conversar! Volte sempre que quiser. Até a próxima!';
    }

    // Perguntas tipo "como vai", "tudo bem"
    if (/(como\s+(?:você\s+)?(?:está|vai|tá))|tudo\s+bem/i.test(userMsg)) {
      return 'Estou bem, obrigado por perguntar! Pronto para ajudar no que precisar. E você, como está?';
    }

    // Perguntas matemáticas simples
    const mathMatch = userMsg.match(/(\d+)\s*([+\-*\/x])\s*(\d+)/);
    if (mathMatch) {
      const a = parseInt(mathMatch[1], 10);
      const op = mathMatch[2];
      const b = parseInt(mathMatch[3], 10);
      let result;
      switch (op) {
        case '+': result = a + b; break;
        case '-': result = a - b; break;
        case '*': case 'x': result = a * b; break;
        case '/': result = b !== 0 ? (a / b).toFixed(2) : 'indefinido (divisão por zero)'; break;
      }
      return `O resultado de ${a} ${op} ${b} é **${result}**. Posso ajudar com mais cálculos?`;
    }

    // Pergunta tipo "o que é X"
    const whatIs = userMsg.match(/o\s+que\s+(?:é|são)\s+([a-zà-úA-ZÀ-Ú\s]+?)\??$/i);
    if (whatIs) {
      const topic = whatIs[1].trim();
      return `Boa pergunta sobre ${topic}! Em termos gerais, esse é um conceito amplo. ` +
             `Tipicamente envolve diversos aspectos como definição, características principais e aplicações práticas. ` +
             `Se quiser, posso me aprofundar em algum aspecto específico — me diga em qual direção te interessa mais.`;
    }

    // Pedido para listar / enumerar
    if (/(?:liste|enumere|cite|me\s+d[êe]|dê[- ]me)\s+(\d+)?/i.test(userMsg)) {
      return `Aqui vai uma lista relacionada ao que você pediu:

1. Primeiro item importante a considerar nesse contexto
2. Segundo item, que normalmente complementa o primeiro
3. Terceiro item, relevante para casos práticos
4. Quarto item, mais avançado mas vale conhecer

Quer que eu detalhe algum desses pontos especificamente?`;
    }

    // Pergunta de opinião
    if (/(?:o\s+que\s+você\s+acha|sua\s+opinião|você\s+recomenda)/i.test(userMsg)) {
      return `Essa é uma pergunta interessante! Pessoalmente, vejo prós e contras. ` +
             `Por um lado, há benefícios claros como praticidade e eficiência. ` +
             `Por outro, existem limitações que vale considerar dependendo do seu caso de uso. ` +
             `Me conte mais sobre seu contexto que eu te dou uma opinião mais específica.`;
    }

    // Pergunta "por que"
    if (/^por\s*qu(?:e|ê)/i.test(userMsg)) {
      return `Ótima pergunta! A resposta envolve alguns fatores. ` +
             `Geralmente isso acontece devido a uma combinação de causas estruturais e contextuais. ` +
             `Os principais motivos costumam ser: a natureza do problema, as restrições envolvidas e as escolhas de implementação. ` +
             `Quer que eu explore alguma dessas dimensões com mais profundidade?`;
    }

    // Pergunta "como"
    if (/^como\s+/i.test(userMsg)) {
      return `Posso explicar! O processo costuma seguir alguns passos básicos:

Primeiro, é importante entender o objetivo e o contexto. Depois, planejar a abordagem mais adequada. Em seguida, executar passo a passo, verificando os resultados intermediários. Por fim, revisar e ajustar conforme necessário.

Cada situação pode exigir adaptações, mas essa estrutura geral funciona bem. Quer que eu detalhe alguma etapa específica?`;
    }

    // Resposta padrão (genérica mas plausível)
    const generic = [
      `Entendi! ${userMsg.length > 30 ? 'Esse é um ponto interessante.' : 'Conta mais.'} Em geral, esse tipo de assunto tem várias camadas. Tem algum aspecto específico que você quer explorar primeiro? Posso te ajudar a pensar de forma mais estruturada.`,
      `Faz sentido o que você está dizendo. Costumo pensar nisso como uma questão que envolve tanto o lado prático quanto o conceitual. Se quiser, posso trazer alguns exemplos concretos para ilustrar melhor.`,
      `Boa observação! Essa é uma daquelas questões que parecem simples mas têm bastante profundidade quando a gente começa a olhar de perto. Quer que eu desenvolva esse raciocínio?`,
      `Interessante! Isso me lembra de discussões parecidas sobre o tema. Há diferentes formas de abordar essa questão — alguns priorizam a eficiência, outros a clareza, outros ainda a flexibilidade. Qual dessas dimensões importa mais para você?`,
    ];
    return generic[Math.floor(Math.random() * generic.length)];
  }

  /* -------- GERAÇÃO DA RESPOSTA PRINCIPAL --------
     Recebe:
       - userMsg: mensagem do usuário recém-enviada
       - inWindowFacts: fatos cujas mensagens originais AINDA estão na janela
       - allFacts: TODOS os fatos já compartilhados (independente da janela)
       - opts: { hallucinate: bool }
     Retorna texto da resposta.
  */
  function respond(userMsg, inWindowFacts, allFacts, opts = {}) {
    const hallucinate_mode = !!opts.hallucinate;

    // 1) Verificar se é uma pergunta sobre algum fato
    const questionType = detectFactQuestion(userMsg);
    if (questionType) {
      const knownFact = inWindowFacts.find(f => f.type === questionType);

      if (knownFact) {
        // IA "lembra" — responder com o fato real
        return formatFactAnswer(questionType, knownFact.value);
      } else {
        // IA "esqueceu" — fato existe nos allFacts mas não na janela
        const wasEverKnown = allFacts.find(f => f.type === questionType);

        if (hallucinate_mode && wasEverKnown) {
          // Alucinar: inventar uma resposta errada (filtrando o valor real)
          const fake = hallucinate(questionType, wasEverKnown.value);
          return formatFactAnswer(questionType, fake) +
                 '\n\n_(Modo demo: a IA acabou de **inventar** essa informação porque a mensagem original saiu da janela de contexto.)_';
        }

        // Sem alucinação: admitir não saber
        if (wasEverKnown) {
          return `Desculpe, não tenho essa informação no contexto atual. ` +
                 `Se você me disse isso antes, parece que a mensagem original saiu da minha janela de contexto. ` +
                 `Pode me lembrar?`;
        }

        return `Hmm, não me lembro de você ter compartilhado essa informação comigo. Pode me contar?`;
      }
    }

    // 2) Não é pergunta sobre fato — gerar resposta contextual
    let response = generateContextualResponse(userMsg, inWindowFacts);

    // 3) Se o usuário acabou de compartilhar um fato, reconhecer
    const newFacts = extractFacts(userMsg);
    if (newFacts.length > 0 && !questionType) {
      const ackParts = newFacts.map(f => {
        switch (f.type) {
          case 'name':     return `prazer em te conhecer, ${f.value}`;
          case 'age':      return `legal saber que você tem ${f.value} anos`;
          case 'location': return `${f.value} é um lugar interessante`;
          case 'job':      return `${f.value}, que profissão bacana`;
          case 'hobby':    return `${f.value} é um hobby ótimo`;
          case 'food':     return `${f.value} parece delicioso`;
          case 'pet':      return `que fofo que você tem um ${f.value}`;
          case 'pet_name': return `${f.value} é um nome lindo`;
          case 'color':    return `${f.value} é uma cor bonita`;
          case 'language': return `${f.value} é uma escolha sólida`;
          default:         return null;
        }
      }).filter(Boolean);

      if (ackParts.length > 0) {
        response = `Anotado: ${ackParts.join(', ')}! ${response}`;
      }
    }

    return response;
  }

  function formatFactAnswer(type, value) {
    switch (type) {
      case 'name':     return `Claro! Seu nome é **${value}**.`;
      case 'age':      return `Você tem **${value}** anos.`;
      case 'location': return `Você mora em **${value}**.`;
      case 'job':      return `Você trabalha como **${value}**.`;
      case 'hobby':    return `Você gosta de **${value}**.`;
      case 'food':     return `Sua comida favorita é **${value}**.`;
      case 'pet':      return `Você tem um **${value}**.`;
      case 'pet_name': return `Seu pet se chama **${value}**.`;
      case 'birthday': return `Seu aniversário é em **${value}**.`;
      case 'color':    return `Sua cor favorita é **${value}**.`;
      case 'number':   return `Seu número favorito é **${value}**.`;
      case 'language': return `Sua linguagem favorita é **${value}**.`;
      default:         return `Lembro sim: **${value}**.`;
    }
  }

  /* -------- API pública --------
     send(state, userMsg, opts) — simula uma chamada assíncrona de IA.
     state: { history: [{role, content, tokens, msgIndex}], facts: [{type, value, msgIndex}] }
     opts:  { hallucinate, contextWindow }
     Retorna { content, inputTokens, outputTokens, totalTokens, newFacts }
  */
  function send(state, userMsg, opts) {
    const { history, facts } = state;
    const { hallucinate: hallucinateMode, contextWindow } = opts;

    // 1) Calcular quais mensagens estão dentro da janela
    //    A regra é a clássica do LLM: pegar do MAIS RECENTE para o mais antigo
    //    até saturar o orçamento de tokens.
    const newUserTokens = countTokens(userMsg);
    // Reserva orçamento para a nova mensagem do usuário (cabe sempre)
    let budget = contextWindow - newUserTokens;
    const inWindowMsgIdx = new Set();

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (budget - msg.tokens >= 0) {
        inWindowMsgIdx.add(i);
        budget -= msg.tokens;
      } else {
        break; // Não cabe mais — todas as anteriores também ficam fora
      }
    }

    // 2) Filtrar fatos que estão associados a mensagens dentro da janela
    const inWindowFacts = facts.filter(f => inWindowMsgIdx.has(f.msgIndex));

    // 3) Extrair fatos da nova mensagem do usuário
    const newFacts = extractFacts(userMsg);

    // 4) Gerar resposta
    const responseText = respond(userMsg, inWindowFacts, facts, { hallucinate: hallucinateMode });

    // 5) Calcular tokens de input (histórico em janela + nova msg) e output
    const historyTokensInWindow = history
      .filter((_, i) => inWindowMsgIdx.has(i))
      .reduce((sum, m) => sum + m.tokens, 0);
    const inputTokens = historyTokensInWindow + newUserTokens;
    const outputTokens = countTokens(responseText);

    return {
      content: responseText,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      userMsgTokens: newUserTokens,
      newFacts,
      inWindowMsgIdx: Array.from(inWindowMsgIdx),
    };
  }

  /* -------- Calcular quais msgs ESTÃO na janela, dada a janela atual.
     Usado para atualizar a UI quando o usuário muda o tamanho da janela
     sem enviar nova mensagem.
  */
  function computeInWindow(history, contextWindow) {
    const inWindow = new Set();
    let budget = contextWindow;
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (budget - msg.tokens >= 0) {
        inWindow.add(i);
        budget -= msg.tokens;
      } else break;
    }
    return inWindow;
  }

  return {
    countTokens,
    extractFacts,
    send,
    computeInWindow,
  };
})();

window.Simulation = Simulation;
