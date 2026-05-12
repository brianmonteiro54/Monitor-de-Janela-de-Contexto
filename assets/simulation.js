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
     ou ~4 caracteres. Em português é parecido (~3.5-4 chars/token).
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
    // Hobby / gosto, usar \b para evitar casar "amo" dentro de "chamo"
    { type: 'hobby',    re: /\b(?:meu hobby (?:é|eh|e)|adoro|gosto de|amo)\s+([a-zà-ú]+(?:\s[a-zà-ú]+){0,2})/i, group: 1 },
    // Comida favorita, exige forma de afirmação
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
     decidimos se a IA "lembra", só lembra se a mensagem original com o
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
     respostas, efeito didático devastador.
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

  /* -------- BASE DE CONHECIMENTO --------
     Conteúdo da aula "Fundamentos de IA, Embeddings e Tipos de Aprendizado
     de Máquina" (Encontro 2). Cada tópico tem respostas reais pra os 4 tipos
     de pergunta mais comuns (o que é / como funciona / exemplos / pra que serve).
     Adaptado do Guia do Professor, falando *para* o aluno (não como o professor
     fala em sala). As analogias do guia são preservadas porque funcionam.
  */
  const KNOWLEDGE = {

    // ===== MÓDULO 1, EMBEDDINGS =====

    'embeddings': {
      aliases: ['embedding', 'vetores semânticos', 'representação vetorial', 'word embeddings'],
      what: 'Embedding é a tradução de uma palavra, frase ou imagem numa lista de números (um vetor). Computadores não entendem texto, só números, então pra processar "cachorro", a palavra primeiro vira essa lista. O detalhe genial: a conversão é feita de um jeito que palavras de significado parecido ganhem listas parecidas. "Cachorro" e "cão" ficam próximos. "Cachorro" e "caminhão" ficam distantes. Significado virou geometria.',
      how: 'Pensa num mapa gigante onde cada palavra do dicionário ocupa um endereço. "Cachorro" fica numa rua, "gato" na rua do lado, "leão" dois quarteirões adiante. "Caminhão" e "obra" ficam do outro lado da cidade. Esse mapa é o espaço de embeddings. Quando o computador quer saber se duas palavras são parecidas, ele consulta o mapa: estão perto? Estão longe? A "mágica" é que o modelo aprende sozinho a desenhar esse mapa vendo milhões de textos durante o treino, ninguém define manualmente onde cada palavra vai.',
      examples: ['busca do Google encontrando resultados úteis mesmo com erro de digitação ou sinônimos', 'Spotify recomendando músicas parecidas com as que você ouve', 'chatbot empresarial achando a resposta certa no manual interno', 'iFood sugerindo restaurantes similares aos que você já pediu'],
      uses: 'É a base de toda busca semântica, sistema de recomendação moderno e aplicação de RAG. Sem embeddings, IA generativa em cima de dados de empresa seria praticamente inviável, eles são a ponte que transforma texto, imagem e áudio em algo que máquinas conseguem comparar.',
    },

    'vetor': {
      aliases: ['vetores'],
      what: 'No contexto da aula, vetor é simplesmente uma lista de números, tipicamente longa: 300, 768, 1.536, 3.072 números, depende do modelo. É a forma matemática que carrega o significado de uma palavra ou imagem depois que ela vira embedding.',
      how: 'Cada posição do vetor é uma coordenada. Junto, todas as coordenadas indicam um "ponto" num espaço de muitas dimensões. Vetores próximos nesse espaço representam coisas semanticamente parecidas. A distância entre dois vetores (calculada por similaridade de cosseno ou distância euclidiana) é o quanto eles são parecidos.',
      examples: ['um embedding do OpenAI text-embedding-3-small tem 1.536 dimensões', 'vetores de fotos no Google Fotos costumam ter 512 ou 1024 dimensões'],
      uses: 'Vetor é o "formato de transporte" de significado dentro de qualquer sistema moderno de IA. Tudo que entra num modelo passa por essa forma em algum momento.',
    },

    'modelo de embedding de texto': {
      aliases: ['embedding de texto', 'text embedding', 'modelo de texto'],
      what: 'É o software especializado em receber texto (palavra, frase ou parágrafo) e devolver o vetor numérico correspondente. É a "máquina" que faz a conversão de texto pra embedding.',
      how: 'Por baixo é uma rede neural treinada em quantidades massivas de texto. Durante o treino ela aprende qual combinação de números melhor representa cada palavra com base em como as palavras aparecem juntas nos textos. Modelos modernos são contextuais: a palavra "banco" em "sentei no banco da praça" vira um vetor diferente do "banco" em "abri conta no banco". Pensa nele como um tradutor especializado que só faz uma coisa: recebe português e devolve um código numérico que captura o significado. E o código tem essa propriedade: frases que dizem coisas parecidas ganham códigos parecidos.',
      examples: ['quando você digita "restaurante perto aberto agora" no Google, ele converte a frase em embedding e busca documentos com embedding parecido', 'OpenAI text-embedding-3', 'modelos da Cohere e Voyage AI', 'modelos open-source como BGE e E5'],
      uses: 'Toda busca semântica, todo chatbot empresarial que encontra resposta em manual interno, toda aplicação de RAG passa por um modelo de embedding de texto. É a engrenagem central de aplicações modernas. Importante: NÃO é a mesma coisa que ChatGPT, esse é um LLM que gera texto. O modelo de embedding é mais simples: só converte texto em vetor. Em RAG, os dois trabalham juntos.',
    },

    'modelo de embedding de imagem': {
      aliases: ['embedding de imagem', 'image embedding', 'visão computacional', 'visao computacional'],
      what: 'Mesmo princípio do embedding de texto, mas a entrada é uma foto. A saída é um vetor que representa o que está na imagem: objetos, cores, formas, composição. Imagens parecidas viram vetores parecidos.',
      how: 'É uma rede neural treinada em quantidades massivas de imagens. Cada imagem do treino tem um embedding aprendido, e o modelo generaliza pra fotos novas que ele nunca viu. É como uma "assinatura visual" numérica: você reconhece um amigo de longe pelo jeito de andar, pela altura, sem conseguir listar exatamente o que detectou. O embedding de imagem é essa assinatura, em forma de números.',
      examples: ['busca por "praia" no iPhone ou Google Fotos que acha todas as fotos de praia sem você ter rotulado nenhuma', 'Pinterest mostrando imagens parecidas com a que você clicou', 'e-commerce mostrando "produtos parecidos"', 'iFood reconhecendo prato em foto'],
      uses: 'Catálogos de e-commerce, bancos de imagens, moderação de conteúdo, apps de fotos pessoais, busca visual reversa. Toda foto que entra na galeria do seu celular passa por um modelo desses, é como o sistema organiza por tema sem você rotular nada.',
    },

    'embedding multimodal': {
      aliases: ['embeddings multimodais', 'multimodal embedding'],
      what: 'É um modelo de embedding que coloca tipos diferentes de dado (texto E imagem, por exemplo) no MESMO espaço de embeddings. A palavra "praia" e uma foto de praia ficam no mesmo ponto do mapa, mesmo sendo tipos diferentes. Isso permite buscas cruzadas: você descreve em texto e o sistema acha imagens; você dá uma imagem e ele acha textos relacionados.',
      how: 'O modelo é treinado em pares (imagem + descrição), bilhões de exemplos. Durante o treino ele aprende a colocar a imagem e o texto que a descrevem no mesmo ponto do espaço. Pensa num dicionário ilustrado: numa página, a palavra "gato" + definição + fotos de gatos. Em embedding multimodal, todas essas formas ocupam endereços vizinhos no mesmo mapa.',
      examples: ['Google Lens (você aponta a câmera, ele descreve o que é)', 'bancos de imagens stock onde você busca "pessoa correndo na praia ao pôr do sol" e ele encontra fotos', 'CLIP da OpenAI', 'o módulo de visão do ChatGPT/Claude quando você manda uma foto'],
      uses: 'Permite todas as aplicações que cruzam texto e imagem: busca por descrição em catálogos visuais, acessibilidade, indexação de bibliotecas multimídia. É o pulo conceitual que tornou a IA generativa moderna tão fluida com mídia diferente.',
    },

    'geração multimodal': {
      aliases: ['geracao multimodal', 'modelo de geração multimodal', 'multimodal generation'],
      what: 'Vai além de comparar: CRIA conteúdo novo, recebendo um tipo de entrada e produzindo outro. Você dá texto, ele devolve imagem. Você dá imagem, ele devolve descrição. Você dá texto, ele devolve áudio. **A diferença crítica em relação a embedding multimodal: embedding COMPARA, geração CRIA.**',
      how: 'Usa o mesmo "mapa de significados" do embedding multimodal, mas pra construir uma saída a partir da entrada, não só pra consultar. Tipo um caricaturista de rua: você descreve a pessoa que quer e ele desenha; ou você mostra uma foto e ele descreve em palavras. Os dois trabalhos exigem entender uma coisa e produzir outra.',
      examples: ['DALL·E, Midjourney, Stable Diffusion (texto → imagem)', 'ChatGPT descrevendo uma foto que você mandou (imagem → texto)', 'apps de acessibilidade que descrevem em voz alta o que aparece na câmera pra pessoas cegas', 'TTS gerando voz a partir de texto'],
      uses: 'Toda IA generativa que cruza modalidades. Geração de imagem a partir de prompt, descrição automática de fotos, conversão texto-voz, voz-texto, vídeo a partir de texto (Sora, Veo). **Decora pra prova: embedding compara, geração cria.**',
    },

    // ===== MÓDULO 2, PROCESSAMENTO DE TEXTO =====

    'tokenização': {
      aliases: ['tokenizacao', 'tokens', 'token', 'tokenizer', 'tokenizador'],
      what: 'Tokenização é o processo de quebrar texto em pedaços menores chamados tokens, pra que o modelo consiga processar. Um token PODE ser uma palavra inteira, mas também pode ser um pedaço de palavra (subword), ou até um caractere isolado, depende do modelo.',
      how: 'Pensa numa criança aprendendo a ler: ela não lê "extraordinariamente" de uma vez, quebra em ex-tra-or-di-na-ri-a-men-te. Os modelos fazem parecido: palavras pequenas e comuns viram um token só ("gato" → 1 token), palavras grandes ou raras viram vários ("extraordinariamente" → vários). Cada modelo tem o seu próprio tokenizador, treinado pra escolher pedaços que aparecem com frequência nos textos. Por isso a mesma palavra pode virar 1 token num modelo e 3 em outro, não são compatíveis entre fornecedores.',
      examples: ['no ChatGPT, "gato" geralmente é 1 token só', '"extraordinariamente" vira vários tokens', 'uma palavra em português vira em média 1,5-2 tokens; em inglês geralmente 1', 'emoji costuma virar 1-2 tokens'],
      uses: 'Duas razões práticas pra entender token: **(1) cobrança**, APIs de IA cobram por token consumido, não por caractere ou palavra. Como o português gera ~2x mais tokens que o inglês na maioria dos tokenizadores (otimizados pra inglês), textos em português acabam ficando mais caros nas APIs. **(2) janela de contexto**, esse limite que define quanto o modelo "enxerga" é medido em tokens. Antes de gerar embedding, antes de prever qualquer coisa, o texto precisa virar tokens. É etapa obrigatória.',
    },

    'bag-of-words': {
      aliases: ['bag of words', 'saco de palavras', 'bow'],
      what: 'Técnica clássica (anterior aos embeddings modernos) que representa um texto contando quantas vezes cada palavra aparece, **ignorando completamente a ordem**. "O cachorro mordeu o homem" vira o mesmo saco de palavras que "o homem mordeu o cachorro". É a maior limitação da técnica: significados radicalmente diferentes geram representações idênticas.',
      how: 'Cada texto vira um vetor do tamanho do vocabulário. Cada posição do vetor corresponde a uma palavra possível, e o valor é a contagem dessa palavra naquele texto. Pensa em jogar todas as palavras de um livro num liquidificador: sai uma sopa onde você sabe quais palavras existem e quantas vezes cada uma aparece, mas perdeu a ordem pra sempre.',
      examples: ['filtros de spam clássicos (várias ocorrências de "promoção", "grátis", "urgente", "clique aqui" → provavelmente spam, independente da ordem)', 'classificação de tópicos em documentos', 'busca por palavra-chave antiga'],
      uses: 'Funcionou bem por décadas em problemas onde a ordem importa pouco: classificação de spam, categorização de tópicos, busca por palavra-chave. Hoje em dia foi superado por embeddings modernos pra tarefas sofisticadas, mas ainda é útil em problemas simples por ser barato e rápido. Pode ser visto como uma versão muito primitiva de embedding, só conta palavras, não captura significado.',
    },

    'contagem de frequência': {
      aliases: ['frequência de palavras', 'tf-idf', 'frequencia'],
      what: 'Ferramenta básica de análise de texto: contar quantas vezes cada palavra aparece num documento. Palavras muito frequentes indicam tema. Palavras raras podem ser muito informativas (especialmente em buscas). Refinamentos como TF-IDF combinam frequência local com raridade global pra identificar quais palavras são realmente características de um texto.',
      how: 'Versão básica: conta. Versão refinada (TF-IDF): peso de uma palavra = (frequência no documento) × (raridade no conjunto). Stopwords ("de", "o", "a") geralmente são removidas antes de contar, não acrescentam informação útil porque aparecem em qualquer texto.',
      examples: ['nuvem de palavras coloridas onde tamanho da palavra = frequência', 'trending topics de redes sociais', 'análise de avaliações de produto pra descobrir reclamações mais comuns'],
      uses: 'Antes dos embeddings sofisticados, era a forma principal de transformar texto em entrada pra modelos de ML. Mesmo hoje continua útil em muitas tarefas práticas: análise de sentimento simples, descoberta de tópicos, indicadores rápidos de tema.',
    },

    'janela de contexto': {
      aliases: ['context window', 'janela', 'contexto', 'tamanho de contexto'],
      what: 'É o limite máximo de tokens que o modelo consegue "ver" de uma vez só, incluindo seu prompt, o histórico da conversa, qualquer contexto adicional, E a resposta que ele vai gerar. Tudo que ultrapassa esse limite simplesmente não existe pro modelo. **É exatamente o que esse app tá demonstrando.**',
      how: 'Pensa na memória de curto prazo de uma pessoa lendo um livro grosso: se você lê 800 páginas sem parar, chega no fim sem se lembrar dos detalhes do começo. O cérebro tem limite. A IA tem o mesmo limite, só que é exato e mensurável em tokens. Passou do limite, alguma parte foi cortada, geralmente o que está no início. Em conversas longas com ChatGPT, quando ele parece "esquecer" o que você falou no começo, **não é falha, é janela de contexto cheia**.',
      examples: ['GPT-3.5: 16k tokens', 'GPT-4 Turbo: 128k tokens', 'Claude 3.5 Sonnet: 200k tokens', 'Gemini 1.5 Pro: até 2M tokens'],
      uses: 'Define até onde o modelo "enxerga". Implicação prática: se você joga um relatório de 50 páginas no ChatGPT e a janela é pequena, ele só vai ler o começo, o resto fica fora do alcance. Quanto maior a janela, mais flexibilidade, mas o custo cresce muito rápido (dobrar a janela mais que dobra o custo). Em soluções reais, vale dividir documentos longos em intervalos (chunks) em vez de jogar tudo numa janela enorme. Janela de contexto é a memória de **curto prazo** do modelo numa única chamada, entre chamadas, ele não lembra de nada a não ser que a aplicação reenvie o histórico.',
    },

    'intervalo': {
      aliases: ['chunk', 'chunks', 'chunking', 'intervalos', 'pedaços de texto', 'pedacos de texto'],
      what: 'Quando um documento é maior que a janela de contexto do modelo, a solução é dividi-lo em pedaços menores. Cada pedaço, com começo e fim definidos, é chamado de **intervalo** (em inglês, chunk). Cada um pode ser indexado, buscado e processado de forma independente.',
      how: 'Pensa em comer uma torta gigante: você não come inteira de uma garfada, corta em fatias. Cada fatia tem começo e fim, é manipulável, cabe na boca. Mesma ideia com documentos: o sistema corta, cria embedding de cada pedaço, guarda num banco vetorial. Na hora da pergunta, busca os pedaços mais parecidos com a pergunta e passa só eles pro modelo redigir a resposta. **Dimensionar o tamanho de cada intervalo é mais arte que ciência**: pequenos demais perdem contexto, grandes demais ficam imprecisos. Uma técnica comum é **overlap**: deixar cada intervalo conter o final do anterior, pra ideias que cruzam o corte não se perderem.',
      examples: ['NotebookLM (Google) cortando PDF em pedaços pra responder perguntas', 'ChatGPT processando arquivos longos', 'chatbot empresarial respondendo com base em documentação interna'],
      uses: 'Intervalo é a base prática de qualquer sistema de **RAG** (Retrieval-Augmented Generation), o padrão hoje quando se quer um chatbot que responda com base em documentos da empresa. Cada projeto encontra o tamanho ideal experimentando, em manuais técnicos, intervalos por seção fazem sentido; em conversas de chat, intervalos menores funcionam.',
    },

    // ===== MÓDULO 3, TIPOS DE DADOS =====

    'dados estruturados': {
      aliases: ['dado estruturado', 'structured data'],
      what: 'Dados organizados em linhas e colunas, com esquema fixo. Planilhas, tabelas de banco de dados relacional, registros de transações. Você sabe exatamente onde está cada informação e consulta com SQL.',
      how: 'Pensa no armário organizado: meias na primeira gaveta, camisas na segunda, calças na terceira. Cada coisa no seu lugar, e consultar é rápido. Você abre, encontra, fecha.',
      examples: ['tabela de clientes (id, nome, idade, cidade)', 'planilha de vendas mensais', 'registros de pedidos de um e-commerce', 'extrato bancário em CSV'],
      uses: 'Sustentou décadas de Machine Learning clássico (regressão, árvores de decisão). Vai pra bancos relacionais como Aurora PostgreSQL ou MySQL. Costuma precisar de pouco pré-processamento. É o terreno do SQL e da análise tradicional.',
    },

    'dados não estruturados': {
      aliases: ['dados nao estruturados', 'dado não estruturado', 'unstructured data'],
      what: 'Tudo o que não cabe numa tabela: textos livres (e-mails, WhatsApp), fotos, vídeos, áudios, PDFs digitalizados. Não há esquema fixo. Você não consegue rodar uma consulta SQL pedindo "todos os e-mails em que o cliente reclamou" porque "reclamou" não está numa coluna; está espalhado dentro do texto.',
      how: 'Pensa naquela caixa em cima do armário onde você joga fotos antigas, contas, cartas, recibos, tudo misturado. Tem informação valiosa ali, mas pra encontrar algo específico você tem que abrir e olhar uma a uma. Pra extrair valor desse dado, precisa primeiro entender o conteúdo, e é aí que entra IA (embeddings, especificamente).',
      examples: ['e-mails de atendimento ao cliente', 'transcrições de ligações com SAC', 'avaliações de produto em loja online', 'fotos de estoque', 'gravações de reunião'],
      uses: 'Estima-se que **cerca de 80% dos dados gerados pelas empresas hoje sejam não estruturados**, e a proporção cresce. Cada câmera de segurança, cada áudio de atendimento, cada mensagem de cliente é dado não estruturado. Embeddings são a ponte que torna esse dado pesquisável. Aplicações práticas de IA generativa empresarial sempre lidam com dado não estruturado.',
    },

    'dados semiestruturados': {
      aliases: ['dado semiestruturado', 'semi-estruturado'],
      what: 'Categoria intermediária entre estruturado e não estruturado. Têm alguma estrutura, mas não tão rígida quanto uma tabela.',
      how: 'Têm marcadores (tags, chaves) que organizam o conteúdo, mas o formato é flexível, diferente de uma tabela rígida.',
      examples: ['arquivos JSON', 'XML', 'logs de servidor', 'documentos do MongoDB'],
      uses: 'Comum em APIs e integrações entre sistemas. Pra esta aula basta entender que existe e fica entre os dois extremos.',
    },

    // ===== MÓDULO 4, BANCOS DE VETORES =====

    'banco de vetores': {
      aliases: ['bancos de vetores', 'banco vetorial', 'vector database', 'banco de dados vetorial', 'vector db'],
      what: 'Banco de dados especializado em armazenar embeddings e, principalmente, buscar por similaridade. Diferente de banco relacional, onde você consulta por igualdade exata ("clientes com idade igual a 30"), um banco vetorial responde a consultas de proximidade: dado um vetor de consulta, devolve os vetores mais próximos.',
      how: 'Pensa numa perfumaria onde o atendente conhece milhares de fragrâncias de cabeça. Você diz "gostei desse aqui, mas quero algo parecido um pouco mais cítrico". Ele vai e te traz três opções compatíveis. Não é busca por nome ou marca, é busca por **semelhança**. O banco de vetores faz a mesma coisa, com números no lugar de cheiros. Por trás existem algoritmos chamados **ANN (Approximate Nearest Neighbor)** que aproximam a resposta sem comparar o vetor de consulta com todos os outros do banco (seria lento demais com bilhões de itens). Introduzem pequeno erro, mas entregam resposta em milissegundos.',
      examples: ['Pinecone, Weaviate, Qdrant, Milvus (bancos dedicados)', 'pgvector no PostgreSQL (extensão em banco relacional)', 'vector no MongoDB', 'OpenSearch com k-NN'],
      uses: 'Loja online recomendando produtos similares, YouTube sugerindo o próximo vídeo, chatbot empresarial buscando trechos relevantes antes do LLM redigir a resposta, todo padrão **RAG** moderno usa banco de vetores como peça central.',
    },

    'aurora postgresql': {
      aliases: ['aurora', 'postgresql', 'postgres'],
      what: 'Banco de dados relacional gerenciado da AWS, baseado no PostgreSQL open-source. É amplamente usado em sistemas corporativos pra armazenar dados estruturados clássicos: clientes, produtos, transações, pedidos. Já está em produção em milhares de empresas brasileiras.',
      how: 'É o PostgreSQL "tradicional" mas com tudo gerenciado pela AWS (backups, alta disponibilidade, escalabilidade automática). Aceita extensões, inclusive a **pgvector**, que adiciona suporte nativo a vetores e transforma o Aurora numa solução híbrida (dados estruturados + embeddings no mesmo banco).',
      examples: ['e-commerce armazenando produtos, clientes e pedidos', 'sistema bancário guardando contas e transações'],
      uses: 'Quando uma empresa já tem PostgreSQL em produção e quer adicionar capacidade vetorial (busca semântica, RAG) sem migrar pra outro banco, instala o pgvector no Aurora PostgreSQL existente. **Combinação Aurora PostgreSQL + pgvector é a opção AWS típica pra vetores em ambientes que já usam PostgreSQL**, e cai com frequência em prova de AWS AI Practitioner.',
    },

    'pgvector': {
      aliases: ['pg vector', 'extensão pgvector'],
      what: 'Extensão do PostgreSQL que adiciona suporte nativo a vetores. Com ela, dá pra criar uma coluna do tipo `vector` numa tabela, guardar embeddings ali e consultar por similaridade usando SQL, sem precisar migrar pra um banco vetorial dedicado.',
      how: 'Imagina seu arquivo de aço com dezenas de gavetas, em uso há anos pra documentos comuns. Surge a necessidade de guardar fotos. Duas opções: comprar um arquivo separado só pra fotos (dobra espaço e manutenção), ou comprar uma **gaveta especial** pra fotos e instalar dentro do arquivo que você já tem. Continua tudo num lugar só, e a gaveta nova fala com as outras. **pgvector é essa gaveta especial.** Instala no PostgreSQL existente, adiciona suporte a vetores, e pronto, o banco aguenta guardar tanto registros tradicionais quanto embeddings.',
      examples: ['e-commerce em Aurora PostgreSQL adicionando coluna de embedding na tabela de produtos pra busca visual', 'sistema de RH que indexa currículos como embeddings e busca por similaridade'],
      uses: 'Maior vantagem: simplicidade. A equipe continua usando o que conhece, dados estruturados e vetores ficam no mesmo banco, podem ser consultados juntos no mesmo SQL. Pra altíssima escala (bilhões de vetores), bancos dedicados como Pinecone podem ter melhor performance, mas pra maioria das aplicações empresariais, pgvector resolve.',
    },

    // ===== MÓDULO 5, ROTULAGEM =====

    'rotulagem': {
      aliases: ['rotulagem de dados', 'labeling', 'labelling', 'rotular'],
      what: 'Rotular um dado é associá-lo à resposta correta. Foto de cachorro recebe o rótulo "cachorro". E-mail de promoção recebe "spam". Transação financeira recebe "fraude" ou "normal". Cada par (entrada + rótulo) vira material de ensino pro modelo.',
      how: 'Pensa numa criança aprendendo a falar: a mãe aponta pro cachorro e diz "esse é o Rex, é um cachorro". Aponta pro gato: "esse é o Mingau, é um gato". Cada apontar acompanhado da palavra é uma rotulagem. Depois de muitas repetições, a criança aprende sozinha. **Pode ser feita por humanos, por máquinas (auto-labeling) ou em modelos híbridos.** Qualidade do rótulo é tudo, existe um ditado clássico: **garbage in, garbage out**. Lixo entra, lixo sai. Rótulo errado, modelo aprende errado.',
      examples: ['CAPTCHA do Google ("clique nas imagens com semáforos"), você está rotulando dados de carros autônomos sem perceber', 'empresa de carros autônomos pagando equipes pra marcar pedestres, semáforos e placas em milhões de fotos', 'humanos avaliando respostas do ChatGPT pra dizer qual é melhor (parte do RLHF)'],
      uses: 'Necessária pra todo aprendizado supervisionado. Em escala é desafio gigante, equipes inteiras dedicadas só a isso, com revisão por múltiplas pessoas e métricas de concordância pra garantir qualidade. É um custo enorme em projetos sérios de IA.',
    },

    'dado rotulado': {
      aliases: ['dados rotulados', 'rotulados', 'labeled data'],
      what: 'Dado que vem com a resposta correta associada (entrada + rótulo). Caros e demorados de produzir, mas necessários pro tipo mais comum de aprendizado: o supervisionado.',
      how: 'Cada exemplo tem o "gabarito" junto. Foto + rótulo "cachorro". E-mail + rótulo "spam". Transação + rótulo "fraude".',
      examples: ['conjunto de 10.000 fotos com tipo de animal já anotado', 'milhares de e-mails marcados como spam ou não spam'],
      uses: 'É o que torna o aprendizado supervisionado viável. A escassez de dado rotulado de qualidade é um dos maiores limitadores em projetos de IA corporativa.',
    },

    'dado não rotulado': {
      aliases: ['dados não rotulados', 'dados nao rotulados', 'unlabeled data'],
      what: 'Dado sem resposta, só a entrada bruta. Abundante e barato: toda foto na internet, todo e-mail trocado, todo áudio gravado começa não rotulado.',
      how: 'É a entrada sem o "gabarito". Texto solto, foto solta, áudio solto, sem ninguém ter dito o que aquilo é ou significa.',
      examples: ['todo conteúdo da Wikipedia (texto sem rótulo de tópico)', 'fotos do seu celular sem tags', 'gravações de áudio de reuniões'],
      uses: 'A maior parte do dado do mundo é não rotulada. Por isso surgiram técnicas que aproveitam ele: **aprendizado não supervisionado** (busca padrões sem rótulo), **auto-supervisionado** (usado pra treinar LLMs, o próprio texto vira sua própria supervisão prevendo a próxima palavra), e **semi-supervisionado** (mistura pouca rotulagem com muito dado bruto).',
    },

    'ground truth': {
      aliases: ['sagemaker ground truth', 'sage maker ground truth'],
      what: 'Serviço da AWS que **gerencia o processo de rotulagem de dados em escala**. Não é quem faz a rotulagem em si, é quem organiza, distribui, controla qualidade e consolida o trabalho. Faz parte da família SageMaker, a plataforma da AWS pra ML.',
      how: 'Você sobe os dados, define o tipo de tarefa de rotulagem (classificação de imagem, identificação de objetos, transcrição de áudio), e o serviço orquestra: pode usar funcionários da sua empresa, terceiros que você contratou, ou conectar com o Mechanical Turk pra usar trabalho humano em escala. Faz controle de qualidade automático (concordância entre rotuladores, revisão de discrepâncias) e ainda pode usar **auto-labeling**: depois que tem rótulos suficientes, treina um modelo que rotula automaticamente os fáceis e deixa pros humanos só os difíceis.',
      examples: ['empresa de carros autônomos rotulando milhões de frames de vídeo com pedestres e placas', 'hospital classificando exames de raio-x', 'banco categorizando documentos digitalizados'],
      uses: 'Quando o volume de dados pra rotular é grande demais pra uma equipe interna fazer manualmente. Ground Truth **gerencia o processo**; Mechanical Turk fornece a força de trabalho. **Não confundir os dois papéis**, é erro frequente, até entre profissionais.',
    },

    'mechanical turk': {
      aliases: ['amazon mechanical turk', 'mturk', 'turkers'],
      what: 'Plataforma da AWS onde milhares de pessoas no mundo todo fazem microtarefas pagas por unidade entregue. Cada tarefa pode ser pequena: marcar pedestres numa foto, transcrever um trecho de áudio, validar resposta gerada por IA, classificar um sentimento.',
      how: 'É um **marketplace, não emprego**. Trabalhadores (chamados turkers) se cadastram, escolhem tarefas e recebem por unidade. A AWS faz a intermediação: pagamento, controle de qualidade básico, reputação. O nome vem da máquina de xadrez do século 18 que fingia ser autônoma mas tinha um humano escondido dentro, "o turco mecânico". Tipo um app de freelance, mas pra microtarefas minúsculas: em vez de "desenvolver site por R$ 5.000", é "marcar essa imagem por R$ 0,02". Mil pessoas trabalhando em paralelo entregam em horas o que uma equipe interna faria em semanas.',
      examples: ['categorizar 100 mil avaliações de produto em positivas/negativas/neutras', 'transcrever áudios curtos de atendimento', 'validar se imagens geradas por IA seguiram o prompt corretamente'],
      uses: 'Pode ser usado isoladamente ou integrado ao SageMaker Ground Truth (que então usa o Turk como uma das opções de força de trabalho). Em ambos os casos, é forma de paralelizar massivamente trabalho humano em rotulagem. **Repetindo: Ground Truth gerencia o processo, Mechanical Turk fornece a força de trabalho**, papéis diferentes.',
    },

    // ===== MÓDULO 6, TIPOS DE APRENDIZADO =====

    'aprendizado supervisionado': {
      aliases: ['supervised learning', 'supervisionado'],
      what: 'O tipo **mais comum e mais intuitivo** de aprendizado. O modelo recebe um conjunto de exemplos onde cada entrada vem com a resposta correta. Aprende a mapear entrada pra saída. Depois consegue prever a saída pra entradas novas que nunca viu.',
      how: 'Pensa num aluno estudando pra prova com livro de exercícios E gabarito ao lado: resolve cada exercício, confere com o gabarito, vê onde errou, ajusta o entendimento. Depois de milhares de exercícios, consegue resolver questões parecidas numa prova real sem o gabarito. O modelo faz a mesma coisa: "resolve" cada exemplo, "confere" com o rótulo, ajusta até errar pouco, depois vai pra produção respondendo sozinho. **Duas grandes famílias**: **classificação** (prevê categoria, spam ou não spam, fraude ou normal, gato ou cachorro) e **regressão** (prevê número, preço de imóvel, quantidade de vendas, temperatura amanhã).',
      examples: ['filtro de spam aprendendo com e-mails marcados', 'previsão de preço de imóvel com base em vendas anteriores', 'reconhecimento de imagem com fotos rotuladas', 'detecção de fraude em cartão de crédito'],
      uses: 'É o estilo de aprendizado por trás da maioria das aplicações empresariais clássicas. Requer dado rotulado de qualidade, quantidade depende da complexidade (centenas a milhões de exemplos). Avaliação é objetiva: compara previsão com resposta real, calcula erro.',
    },

    'aprendizado não supervisionado': {
      aliases: ['unsupervised learning', 'nao supervisionado', 'não supervisionado'],
      what: 'O modelo recebe **só os dados, sem resposta**. O trabalho dele é descobrir padrões sozinho: encontrar grupos, estruturas, anomalias. Não há gabarito. Há descoberta.',
      how: 'Pensa numa criança recebendo uma caixa enorme de Lego, com peças misturadas, sem instrução. Ela não sabe que vai construir um navio ou um castelo. Mas naturalmente começa a separar: vermelhos com vermelhos, redondos com redondos. Sem ninguém ter dito que é assim, ela descobre grupos sozinha. **Três famílias clássicas**: **clusterização** (descobrir grupos parecidos no meio dos dados), **redução de dimensionalidade** (resumir muitas variáveis em poucas, geralmente pra visualizar), e **detecção de anomalias** (encontrar pontos diferentes do padrão).',
      examples: ['Spotify agrupando você com pessoas de gosto parecido pra criar "Descobertas da Semana"', 'lojas online segmentando clientes em grupos sem ninguém ter dito quais grupos existem (gastam pouco/compram muito, gastam muito/compram raro)', 'detecção de fraude identificando transações estranhas sem precisar de exemplos prévios'],
      uses: 'Aproveita o oceano de dados não rotulados que existe, grande vantagem. Grande dificuldade: avaliar se o resultado é bom, já que sem gabarito a avaliação fica subjetiva. A pergunta típica é "esse agrupamento faz sentido pro negócio?". Exige conhecimento do domínio pra validar.',
    },

    'aprendizado por reforço': {
      aliases: ['reinforcement learning', 'rl', 'reforço', 'reforco'],
      what: 'Aqui o modelo, chamado de **agente**, interage com um **ambiente**: toma uma ação, observa o resultado, recebe uma **recompensa** (positiva se foi bom, negativa se foi ruim), e aprende a tomar ações que maximizam recompensa no longo prazo. Não há rótulo prévio, há **experiência acumulada**.',
      how: 'Pensa em treinar um cachorro a sentar: você dá o comando "senta", se ele senta, biscoito; se faz qualquer outra coisa, nada. Depois de várias repetições ele aprende que sentar quando ouve a palavra leva ao biscoito. Não recebeu rótulos prévios sobre o que era certo, descobriu por consequência. **Distingue-se dos outros tipos por ser sequencial**: em supervisionado, cada exemplo é independente; em reforço, ações tomadas agora afetam recompensas futuras. O agente precisa equilibrar **exploração** ("tentar coisas novas") e **exploração inversa** ("apostar no que já dá certo").',
      examples: ['AlphaGo (DeepMind) que aprendeu Go melhor que qualquer humano jogando milhões de partidas contra si mesmo', 'carros autônomos treinados em simulação antes de irem pra rua', 'bots de videogame aprendendo a vencer fases', 'robôs industriais aprendendo a manipular peças tentando até acertar'],
      uses: 'Aplicações com decisão sequencial: jogos, robótica, otimização de processos, sistemas modernos de recomendação. **Curiosidade pra prova**: a fase final do treinamento do ChatGPT, que faz ele dar respostas que humanos gostam, usa reforço, a sigla é **RLHF** (Reinforcement Learning from Human Feedback). Humanos avaliam respostas, e o modelo aprende a gerar as que humanos preferem. Reforço também aparece em LLMs, não só em jogos.',
    },

    'aprendizado federado': {
      aliases: ['federated learning', 'federado'],
      what: 'Treinamento **distribuído**. Cada participante (dispositivo, hospital, banco) treina localmente com seus próprios dados. **Apenas as atualizações do modelo, não os dados em si, são enviadas pra um servidor central**, que combina tudo e gera uma versão melhor do modelo, que volta pros dispositivos.',
      how: 'Pensa em vários alunos espalhados pelo país estudando o mesmo livro em casa. Em vez de mandarem pro professor o livro inteiro com anotações pessoais, cheio de coisas íntimas e sublinhados privados,, cada um manda **só um resumo** do que aprendeu. O professor junta os resumos e devolve uma síntese melhorada. Os livros pessoais nunca saem da casa. **A motivação central é privacidade**: em muitos cenários os dados não podem sair do lugar onde foram gerados (LGPD, GDPR, segredo comercial, prontuários médicos).',
      examples: ['teclado do celular aprendendo suas gírias e jargões sem mandar tudo que você digita pro servidor da Apple ou Google, esse é o exemplo mais cotidiano, federado em produção no bolso de cada um', 'hospitais treinando modelo de diagnóstico em conjunto sem compartilhar prontuários', 'bancos colaborando em modelo anti-fraude sem expor dados de clientes'],
      uses: 'Quando privacidade é obrigatória, é a única opção viável. **Trade-off**: mais complexo de implementar que centralizado, e o modelo final às vezes fica um pouco abaixo do que seria possível com tudo num lugar só. Mas em casos com restrição forte de privacidade (LGPD, GDPR, hospitais, prontuários), federado é o caminho. Não confundir com aprendizado por transferência, são coisas diferentes: federado **distribui o treino**, transferência **reaproveita um modelo já treinado**.',
    },

    'aprendizado por transferência': {
      aliases: ['transfer learning', 'transferência', 'transferencia'],
      what: 'Em vez de treinar do zero (que é caro: milhões de exemplos + muito poder computacional), **reaproveita um modelo já treinado em uma tarefa relacionada e ajusta pra nova tarefa**. Você sai do zero e parte de um modelo que já sabe muito.',
      how: 'Pensa em alguém que já sabe dirigir carro e vai aprender moto: não começa do zero. Já entende trânsito, sinalização, equilíbrio em movimento, distância de frenagem. Só precisa adaptar o que já sabe ao novo veículo. Aprende em dias em vez de meses. **Técnica mais comum dentro de transferência é o fine-tuning**: pega o modelo pré-treinado e ajusta com dados específicos da nova tarefa. Outras variações: **extração de features** (usa parte do modelo congelada e treina só uma cabeça nova) e **prompt tuning** (ajusta prompts em vez de pesos).',
      examples: ['fine-tuning de um modelo de visão pré-treinado em ImageNet pra reconhecer raio-x médico', 'BERT/GPT/Llama adaptados pra domínio jurídico ou médico', 'modelo de detecção de defeitos em fábrica partindo de um modelo geral de imagens'],
      uses: '**Foi a técnica que viabilizou a IA generativa moderna e democratizou IA.** Antes, treinar um modelo decente exigia equipes grandes, dados massivos e meses de GPU. Hoje qualquer empresa pequena consegue, em dias, fazer fine-tuning de um modelo público pra tarefa específica. Sem transferência, IA ainda seria jogo só de gigantes. Funciona melhor quando a tarefa nova se parece com a antiga, reaproveitar modelo de imagens pra texto não funciona, são domínios distantes demais.',
    },

    // ===== TÓPICOS COMPLEMENTARES =====

    'machine learning': {
      aliases: ['ml', 'aprendizado de máquina', 'aprendizado de maquina'],
      what: 'Machine Learning é um ramo da IA onde algoritmos aprendem padrões a partir de dados, sem precisar ser programados explicitamente pra cada caso. Em vez de você escrever as regras, mostra exemplos e o modelo descobre as regras sozinho.',
      how: 'Funciona em três etapas: (1) coleta dados de exemplo, (2) treina um modelo matemático ajustando seus parâmetros pra minimizar erro nas previsões, (3) usa o modelo treinado pra fazer previsões em dados novos. **As cinco grandes famílias** (vamos ver cada uma na aula): supervisionado, não supervisionado, por reforço, federado e por transferência.',
      examples: ['filtro de spam aprendendo com e-mails marcados', 'recomendação do Spotify e Netflix', 'detecção de fraude em cartão de crédito', 'reconhecimento de voz no celular'],
      uses: 'Praticamente tudo em IA hoje: busca, recomendação, tradução, diagnóstico médico, carros autônomos, geração de texto e imagem.',
    },

    'deep learning': {
      aliases: ['dl', 'aprendizado profundo', 'redes profundas'],
      what: 'Subconjunto de Machine Learning que usa redes neurais com muitas camadas (daí "deep", profundo). Cada camada aprende representações progressivamente mais abstratas dos dados.',
      how: 'Numa rede que reconhece gatos: primeiras camadas detectam bordas e texturas, do meio detectam olhos e orelhas, finais combinam tudo pra concluir "isso é um gato". Treinamento usa backpropagation pra ajustar bilhões de pesos. Exige muito mais dado e poder computacional que ML clássico, mas escala muito melhor.',
      examples: ['reconhecimento facial', 'ChatGPT e outros LLMs', 'tradução automática (Google Translate)', 'geração de imagens (Stable Diffusion, DALL·E, Midjourney)'],
      uses: 'Tecnologia por trás de praticamente todas as IAs modernas que parecem "mágicas". Dados não estruturados (texto, imagem, áudio) ganharam vida com Deep Learning.',
    },

    'redes neurais': {
      aliases: ['rede neural', 'neural network', 'nn'],
      what: 'Modelos matemáticos vagamente inspirados no cérebro. Compostas por camadas de "neurônios" (nós matemáticos) conectados, onde cada conexão tem um peso ajustável.',
      how: 'Cada neurônio recebe valores de entrada, multiplica pelos pesos, soma, aplica uma função de ativação não-linear, e passa o resultado adiante. O treinamento ajusta os pesos pra que a saída final aproxime o resultado desejado.',
      examples: ['perceptron (a rede mais simples)', 'CNNs (Convolutional Neural Networks) para imagens', 'RNNs e Transformers para texto'],
      uses: 'Base de praticamente tudo em deep learning. Modelos de embedding, LLMs, geração de imagem, todos são variações de redes neurais.',
    },

    'transformer': {
      aliases: ['transformers', 'attention is all you need'],
      what: 'Arquitetura de rede neural que revolucionou NLP em 2017 (paper "Attention Is All You Need"). É a base de praticamente todos os LLMs modernos: GPT, Claude, Gemini, Llama, tudo é Transformer.',
      how: 'A inovação central é o **mecanismo de atenção (self-attention)**: cada token consegue "olhar" pra todos os outros tokens da sequência e decidir o quanto cada um é relevante. Isso resolveu o problema das RNNs de esquecer dependências longas e permitiu paralelizar o treinamento de forma massiva.',
      examples: ['GPT (decoder-only Transformer)', 'BERT (encoder-only)', 'T5 (encoder-decoder)', 'Vision Transformers pra imagens'],
      uses: 'LLMs, tradução, sumarização, classificação de texto, e, surpreendentemente, também visão computacional. Domina o campo.',
    },

    'llm': {
      aliases: ['large language model', 'modelo de linguagem', 'modelos de linguagem', 'llms', 'modelo de linguagem grande'],
      what: 'LLM (Large Language Model) é um modelo de linguagem treinado em quantidades massivas de texto, tipicamente trilhões de tokens, pra prever a próxima palavra. Apesar do objetivo simples, gera capacidades emergentes surpreendentes: raciocínio, tradução, código, criatividade.',
      how: 'Treinamento em fases: (1) **pré-treino** auto-supervisionado em quantidade gigante de texto da internet aprendendo a prever o próximo token, (2) **fine-tuning supervisionado** com exemplos curados de pergunta-resposta, (3) **RLHF** com feedback humano pra ser útil, honesto e seguro. A geração é **autorregressiva**: prevê um token de cada vez, alimentando de volta o que já gerou.',
      examples: ['GPT-4 (OpenAI)', 'Claude (Anthropic)', 'Gemini (Google)', 'Llama (Meta)', 'Mistral'],
      uses: 'Chatbots, copilots de programação, agentes autônomos, análise de documentos, geração de conteúdo, sumarização, tradução. Em aplicações de RAG trabalham junto com modelos de embedding: o de embedding faz a busca, o LLM redige a resposta.',
    },

    'rlhf': {
      aliases: ['reinforcement learning from human feedback', 'feedback humano'],
      what: 'RLHF (**Reinforcement Learning from Human Feedback**, Aprendizado por Reforço com Feedback Humano) é a aplicação de aprendizado por reforço pra alinhar LLMs com o que humanos preferem. Foi a técnica usada na fase final do treinamento do ChatGPT e de praticamente todos os chatbots modernos.',
      how: 'O processo: (1) o modelo já pré-treinado gera várias respostas pra cada prompt, (2) humanos avaliam qual resposta é melhor (escolhem entre A e B, por exemplo), (3) com essas avaliações treina-se um modelo de recompensa que estima "quão boa" cada resposta é, (4) finalmente, o LLM é re-treinado com reforço usando esse modelo de recompensa como sinal. O resultado é um modelo que gera respostas que humanos consideram úteis, honestas e seguras.',
      examples: ['fase final do treino do ChatGPT, Claude, Gemini', 'instrução tuning de modelos open-source como Llama'],
      uses: 'É como LLMs aprenderam a ser úteis em vez de só "completarem texto". Sem RLHF, modelos como GPT-4 e Claude soariam muito mais brutos e menos alinhados com o que esperamos de um assistente. **Curiosidade pra prova**: RLHF é a "ponte" entre reforço (que parece ser só de jogos e robótica) e LLMs.',
    },

    'rag': {
      aliases: ['retrieval augmented generation', 'retrieval-augmented'],
      what: 'RAG (Retrieval-Augmented Generation) combina busca + geração. Em vez de depender só do que o LLM "sabe" do treino, você **busca documentos relevantes numa base e injeta no contexto antes de gerar a resposta**.',
      how: 'Pipeline típico: (1) você indexa seus documentos cortando em intervalos (chunks), transformando cada um em embedding e guardando num banco vetorial, (2) na hora da pergunta, converte a pergunta em embedding e busca os trechos mais similares, (3) injeta esses trechos no prompt junto com a pergunta, (4) o LLM redige a resposta com base no contexto recuperado.',
      examples: ['chatbot empresarial respondendo com base em documentação interna', 'assistente jurídico citando artigos da legislação', 'NotebookLM do Google', 'busca semântica em e-commerce'],
      uses: 'Padrão da indústria quando você precisa que o LLM responda com base em dados específicos (da empresa, atualizados, ou que ele não viu no treino). Combina embeddings, banco de vetores, intervalos e LLM, junta TUDO que vimos na aula num só pipeline. Se você for fazer AWS AI Practitioner, essa palavra vai aparecer dezenas de vezes.',
    },

    'fine-tuning': {
      aliases: ['fine tuning', 'finetuning', 'ajuste fino'],
      what: 'Pegar um modelo pré-treinado e continuar treinando ele num conjunto de dados específico do seu domínio. Ajusta os pesos pra que ele performe melhor numa tarefa particular. É a **técnica mais comum dentro de aprendizado por transferência**.',
      how: 'Você precisa de dataset rotulado com exemplos de entrada e saída desejada. O modelo treina nesses exemplos com learning rate baixo pra não destruir o conhecimento prévio. Variações modernas como **LoRA** (Low-Rank Adaptation) treinam só uma pequena fração dos pesos, ficando bem mais barato.',
      examples: ['fine-tunar GPT em conversas do seu produto pra responder no tom da marca', 'fine-tunar em código pra criar um copilot especializado', 'instruction tuning pra modelos seguirem instruções'],
      uses: 'Quando prompt engineering + RAG não bastam pra atingir a qualidade desejada. Geralmente caro e demorado, então é último recurso. RAG resolve a maioria dos casos sem precisar de fine-tuning.',
    },

    'prompt engineering': {
      aliases: ['engenharia de prompt', 'prompting', 'prompt'],
      what: 'Prática de escrever instruções (prompts) de um jeito que faz o LLM produzir o resultado desejado de forma mais consistente. Não é só "saber escrever bem", é entender como o modelo processa instruções.',
      how: 'Técnicas comuns: (1) ser específico sobre o formato de saída, (2) dar exemplos (few-shot), (3) pedir pra pensar passo a passo (chain-of-thought), (4) dar um papel ao modelo ("você é um especialista em..."), (5) separar instruções e dados claramente.',
      examples: ['few-shot prompting (mostrar 2-3 exemplos antes da tarefa)', 'chain-of-thought ("pense passo a passo")', 'role prompting ("aja como um revisor crítico")'],
      uses: 'Praticamente toda aplicação que usa LLM precisa de bom prompt engineering. É a "API" entre humano e modelo.',
    },

    'ia': {
      aliases: ['inteligência artificial', 'inteligencia artificial', 'artificial intelligence'],
      what: 'IA (Inteligência Artificial) é o **campo amplo** de fazer máquinas com comportamento que a gente chama de "inteligente". É o termo guarda-chuva. Inclui desde sistemas baseados em regras (sem aprendizado nenhum) até LLMs modernos.',
      how: 'Engloba várias subáreas: Machine Learning (que aprende com dados), Deep Learning (subconjunto de ML com redes neurais profundas), processamento de linguagem natural, visão computacional, robótica, sistemas especialistas.',
      examples: ['ChatGPT', 'sistemas de recomendação', 'reconhecimento de voz', 'carros autônomos', 'sistemas especialistas clássicos baseados em regras'],
      uses: 'Hierarquia importante: **toda ML é IA, mas nem toda IA é ML**. Sistemas especialistas dos anos 80 baseados em regras eram IA sem ML. Hoje em dia "IA" no uso popular geralmente se refere a sistemas baseados em ML/Deep Learning.',
    },

    'python': {
      aliases: [],
      what: 'Linguagem de programação de alto nível, interpretada, conhecida por sintaxe limpa e legível. É a linguagem **dominante em ciência de dados, machine learning e IA**.',
      how: 'Tipagem dinâmica, indentação como sintaxe, vasto ecossistema de bibliotecas pra IA: NumPy, Pandas, PyTorch, TensorFlow, scikit-learn, transformers da Hugging Face.',
      examples: ['NumPy pra computação numérica', 'Pandas pra manipulação de dados', 'PyTorch e TensorFlow pra deep learning', 'scikit-learn pra ML clássico', 'LangChain e LlamaIndex pra LLMs'],
      uses: 'Quase toda IA moderna é prototipada e frequentemente colocada em produção em Python. Se você vai trabalhar com IA, vale aprender.',
    },

    'api': {
      aliases: ['apis'],
      what: 'API (Application Programming Interface) é um contrato que define como diferentes softwares se comunicam. No contexto de IA, geralmente é uma API REST que você chama via HTTP pra usar um modelo hospedado por um provedor.',
      how: 'Você manda uma requisição (geralmente POST com JSON) pra um endpoint, com sua chave de autenticação. O servidor processa e devolve a resposta. Provedores como OpenAI, Anthropic, Google e AWS oferecem APIs assim.',
      examples: ['POST https://api.openai.com/v1/chat/completions', 'POST https://api.anthropic.com/v1/messages', 'AWS Bedrock (acesso a vários LLMs num só endpoint)'],
      uses: 'É como aplicações integram modelos de IA sem precisar hospedar nada localmente. Cobrança quase sempre por token, daí a importância de entender tokenização.',
    },

  };

  function findTopic(text) {
    const lower = text.toLowerCase();
    // Pegar o match MAIS ESPECÍFICO (mais longo). Sem isso, "modelo de embedding
    // de texto" cai em "embedding", "banco de vetores" cai em "vetor", etc.
    let bestKey = null;
    let bestLen = 0;
    for (const [key, data] of Object.entries(KNOWLEDGE)) {
      // Casar a própria chave (com word boundary onde possível)
      if (lower.includes(key) && key.length > bestLen) {
        bestKey = key;
        bestLen = key.length;
      }
      for (const alias of data.aliases || []) {
        const re = new RegExp(`\\b${alias.replace(/[+\-\[\]\\\.]/g, '\\$&')}\\b`, 'i');
        if (re.test(lower) && alias.length > bestLen) {
          bestKey = key;
          bestLen = alias.length;
        }
      }
    }
    return bestKey;
  }

  /* -------- RESPOSTAS NATURAIS PARA FRASES COMUNS --------
     Quando o usuário não está perguntando sobre fatos, gerar uma resposta
     contextualmente apropriada. Quando o nome ESTÁ na janela, a IA usa
     o nome ocasionalmente, quando o nome SAIR da janela, ela para de usar.
     Esse é o efeito didático.
  */
  function generateContextualResponse(userMsg, knownFacts) {
    const lower = userMsg.toLowerCase().trim();
    const nameFact = knownFacts.find(f => f.type === 'name');
    const userName = nameFact ? nameFact.value.split(' ')[0] : null;

    // Usar nome ~40% das vezes quando disponível, pra não ficar artificial
    const useName = userName && Math.random() < 0.4;
    const namePrefix = useName ? `${userName}, ` : '';
    const nameSuffix = useName ? `, ${userName}` : '';

    // -------- Saudações --------
    if (/^(oi|olá|ola|hey|bom\s+dia|boa\s+tarde|boa\s+noite|e[ ]?aí|opa)\b/i.test(userMsg)) {
      if (userName) {
        const greetings = [
          `Oi de novo, ${userName}! Tudo certo? Em que posso ajudar?`,
          `E aí, ${userName}! Bom te ver. O que você quer explorar agora?`,
          `Olá, ${userName}! Prossegue, tô aqui.`,
        ];
        return greetings[Math.floor(Math.random() * greetings.length)];
      }
      return 'Olá! Tudo bem? Pode me perguntar qualquer coisa ou me contar algo sobre você, tô aqui pra conversar.';
    }

    // -------- Despedidas --------
    if (/^(tchau|até logo|até mais|valeu|obrigad[ao]|flw|falou)\b/i.test(userMsg)) {
      if (userName) return `Foi ótimo conversar, ${userName}! Até a próxima.`;
      return 'Foi um prazer. Volte sempre que precisar!';
    }

    // -------- "Como vai?" --------
    if (/(como\s+(?:você\s+)?(?:está|vai|tá|estas))|tudo\s+bem|beleza\??$/i.test(userMsg)) {
      return `Tudo certo${nameSuffix}! Pronto pra ajudar. E você, como tá?`;
    }

    // -------- Matemática simples --------
    const mathMatch = userMsg.match(/(\d+(?:\.\d+)?)\s*([+\-*\/x×÷])\s*(\d+(?:\.\d+)?)/);
    if (mathMatch) {
      const a = parseFloat(mathMatch[1]);
      const op = mathMatch[2];
      const b = parseFloat(mathMatch[3]);
      let result;
      switch (op) {
        case '+': result = a + b; break;
        case '-': result = a - b; break;
        case '*': case 'x': case '×': result = a * b; break;
        case '/': case '÷': result = b !== 0 ? +(a / b).toFixed(4) : 'indefinido (divisão por zero)'; break;
      }
      return `${a} ${op} ${b} = **${result}**`;
    }

    // -------- Detectar tópico conhecido --------
    const topicKey = findTopic(userMsg);
    const topicData = topicKey ? KNOWLEDGE[topicKey] : null;

    // -------- "Qual a diferença entre X e Y" --------
    const diffMatch = userMsg.match(/(?:diferen[çc]a|diferen[çc]as)\s+entre\s+([a-zà-úA-ZÀ-Ú\s\-]+?)\s+e\s+([a-zà-úA-ZÀ-Ú\s\-]+?)[\?\.]?$/i);
    if (diffMatch) {
      const t1 = diffMatch[1].trim();
      const t2 = diffMatch[2].trim();
      // Normalizar pra reduzir variações (singular/plural, com/sem "aprendizado")
      const norm = (s) => s.toLowerCase()
        .replace(/^aprendizado\s+(por\s+)?/i, '')
        .replace(/^dados?\s+/i, '')
        .replace(/^modelo\s+(de\s+)?/i, '')
        .replace(/s$/, '')
        .trim();
      const a = norm(t1);
      const b = norm(t2);
      const pair = `${a}|${b}`;
      const reversePair = `${b}|${a}`;
      const knownDiffs = {
        // ===== Confusões clássicas (Apêndice B do Guia do Professor) =====
        'embedding multimodal|geração multimodal':
          '**Essa é uma das diferenças mais cobradas em prova.** Embedding multimodal **COMPARA**: coloca foto e descrição no mesmo ponto do mapa de significados pra você poder consultar. Geração multimodal **CRIA**: usa o mapa pra construir uma foto a partir de uma descrição (DALL·E, Midjourney), ou uma descrição a partir de uma foto (ChatGPT olhando imagem). Mesmo mapa, finalidades diferentes. A regra a decorar: **embedding compara, geração cria**.',
        'embedding|geração multimodal':
          '**Embedding compara, geração cria.** Embedding (multimodal ou não) coloca coisas no mesmo espaço pra você consultar por similaridade. Geração multimodal usa esse espaço pra produzir conteúdo novo: texto vira imagem (DALL·E), imagem vira descrição (ChatGPT lendo foto).',
        'estruturado|não estruturado':
          'Estruturados são organizados em linhas e colunas, com esquema fixo (planilhas, tabelas SQL), você consulta com SQL. Não estruturados são tudo que não cabe em tabela: e-mails, fotos, áudios, PDFs, conversas de WhatsApp, não tem esquema fixo. **Estima-se que ~80% do dado das empresas hoje seja não estruturado**, e é justamente isso que tornou embeddings tão importantes: eles dão "etiquetas numéricas" pro que estava na caixa solta.',
        'ground truth|mechanical turk':
          '**Esse é o erro frequente até entre profissionais.** Ground Truth **gerencia o processo** de rotulagem, organiza, distribui, controla qualidade, consolida. Mechanical Turk **fornece a força de trabalho**, é o marketplace onde milhares de pessoas no mundo executam microtarefas pagas por unidade. Ground Truth pode acionar o Mechanical Turk como uma das fontes de rotuladores. Mas os papéis são distintos: um é o gerente do processo, o outro é a mão de obra.',
        'federado|transferência':
          '**Federado distribui o treino; transferência reaproveita um modelo já treinado.** Não têm relação direta. Federado **preserva privacidade** treinando localmente em cada dispositivo (teclado do celular aprendendo suas gírias sem mandar nada pro servidor). Transferência **poupa tempo e custo** pegando um modelo público pré-treinado e adaptando pra sua tarefa (fine-tunar BERT pra área jurídica). Soa parecido por causa do "trans-" no nome, mas são coisas distintas.',
        'supervisionado|não supervisionado':
          'Supervisionado aprende com dados **rotulados** (entrada + resposta correta), tipo aluno com gabarito ao lado. Não supervisionado recebe **só os dados, sem resposta**, e tem que descobrir padrões sozinho, tipo criança organizando peças de Lego por cor. Resumo: **supervisionado tem gabarito, não supervisionado descobre sozinho**.',
        'supervisionado|reforço':
          'Supervisionado aprende com pares (entrada, resposta correta), exemplos independentes. Reforço aprende **interagindo com um ambiente**: toma ação, recebe recompensa (positiva ou negativa), ajusta. É sequencial: ações afetam recompensas futuras. Pensa no aluno com gabarito (supervisionado) vs cachorro recebendo biscoito (reforço).',
        'janela de contexto|intervalo':
          'Janela de contexto é o **limite total** que o modelo enxerga numa chamada (ex: 128k tokens). Intervalo (chunk) é a **estratégia** quando o documento é maior que a janela: você corta em pedaços, indexa cada um, busca os relevantes na hora da pergunta. **Janela define quanto cabe; intervalos resolvem o que não cabe**.',
        'janela de contexto|chunk':
          'Janela de contexto é o **limite total** que o modelo enxerga numa chamada (ex: 128k tokens). Chunk (intervalo) é a **estratégia** quando o documento é maior que a janela: você corta em pedaços, indexa cada um, busca os relevantes na hora da pergunta. **Janela define quanto cabe; chunks resolvem o que não cabe**.',
        'embedding|llm':
          'Modelo de embedding **converte texto em vetor**, é mais simples, só faz essa tradução pra busca por similaridade. LLM (ChatGPT, Claude, Gemini) **gera texto novo**, é muito mais complexo, treinado pra prever a próxima palavra. **Em RAG eles trabalham juntos**: o de embedding faz a busca dos trechos relevantes, o LLM redige a resposta.',
        'rag|fine-tuning':
          'RAG **injeta informação relevante** no contexto no momento da pergunta, bom pra dados que mudam ou são grandes demais. Fine-tuning **altera os pesos do modelo** num treinamento adicional, bom pra ensinar estilo, tom ou tarefas muito específicas. RAG é mais rápido, barato e atualizável; fine-tuning é mais profundo mas custa caro. **Na prática, RAG resolve a maioria dos casos sem precisar de fine-tuning**.',
        'pgvector|aurora postgresql':
          'Aurora PostgreSQL é o **banco** (relacional gerenciado pela AWS, baseado no PostgreSQL). pgvector é uma **extensão** que você instala dentro do PostgreSQL pra adicionar suporte a vetores. Os dois nomes andam juntos: **Aurora PostgreSQL + pgvector** é a combinação típica AWS pra capacidade vetorial. Aurora é o arquivo de aço; pgvector é a gaveta especial que você instala dentro.',
        'ia|ml':
          'IA é o campo amplo de fazer máquinas com comportamento "inteligente". ML é um subconjunto de IA: especificamente o paradigma de aprender com dados em vez de regras programadas à mão. **Toda ML é IA, mas nem toda IA é ML**, sistemas especialistas clássicos baseados em regras são IA sem ML.',
        'ml|dl':
          'ML é o campo geral de aprender com dados, usando qualquer algoritmo: árvores de decisão, regressão, SVM, KNN, redes neurais. Deep Learning é o subconjunto de ML que usa redes neurais profundas (muitas camadas). DL exige muito mais dado e poder computacional, mas escala muito melhor.',
        'token|palavra':
          'Um token nem sempre é uma palavra. Palavras comuns viram um token só, palavras raras se quebram em vários sub-tokens. Espaços, pontuação e emojis também viram tokens. Regra de bolso: 1 token ≈ 4 caracteres em inglês, 1,5-2 tokens por palavra em português (o tokenizador foi otimizado pra inglês, daí português ficar mais caro nas APIs).',
        'gpt|claude':
          'Ambos são LLMs comerciais baseados em Transformer. GPT é da OpenAI, Claude é da Anthropic. Diferem em treino, capacidades, comprimento de janela (Claude tipicamente tem janelas maiores), preço e personalidade. Pra escolher, vale testar nos seus casos reais.',
      };
      if (knownDiffs[pair]) return knownDiffs[pair];
      if (knownDiffs[reversePair]) return knownDiffs[reversePair];

      return `Boa pergunta${nameSuffix}. Os dois conceitos têm relação, mas se diferenciam principalmente em escopo e aplicação. **${t1}** costuma ser mais ${Math.random() < 0.5 ? 'amplo e geral' : 'específico e técnico'}, enquanto **${t2}** tende a ser ${Math.random() < 0.5 ? 'mais focado em casos práticos' : 'um caso particular dentro de um campo maior'}. Quer que eu detalhe algum dos dois separadamente primeiro?`;
    }

    // -------- "O que é X" / "O que são X" --------
    const whatIs = userMsg.match(/(?:o\s+que\s+(?:é|são)|me\s+(?:explica|fala\s+sobre)|explica)\s+([a-zà-úA-ZÀ-Ú\s]+?)[\?\.]?$/i);
    if (whatIs && topicData) {
      let answer = `${topicData.what}\n\n${topicData.how}`;
      if (topicData.examples && Math.random() < 0.6) {
        answer += `\n\nAlguns exemplos práticos: ${topicData.examples.slice(0, 3).join('; ')}.`;
      }
      if (useName && Math.random() < 0.5) answer = `Boa, ${userName}. ` + answer;
      return answer;
    }
    if (whatIs && !topicData) {
      const topic = whatIs[1].trim();
      return `Sobre **${topic}** especificamente, posso falar em termos gerais${nameSuffix}, mas não tenho certeza se vou acertar todos os detalhes técnicos. ` +
             `Quer que eu tente explicar do meu jeito ou prefere que eu foque em algum aspecto específico desse assunto?`;
    }

    // -------- "Como funciona X" --------
    const howWorks = userMsg.match(/como\s+(?:funciona|funcionam|trabalha)\s+([a-zà-úA-ZÀ-Ú\s]+?)[\?\.]?$/i);
    if (howWorks && topicData) {
      let answer = topicData.how;
      if (topicData.examples) {
        answer += `\n\nNa prática isso aparece em coisas como: ${topicData.examples.slice(0, 2).join(' e ')}.`;
      }
      return answer;
    }

    // -------- "Exemplo de X" / "Me dê exemplos" --------
    const exampleMatch = userMsg.match(/(?:exemplos?|um\s+exemplo|casos?|aplica[çc]ões)\s+(?:de|para|do|da)?\s*([a-zà-úA-ZÀ-Ú\s]*)/i);
    if (exampleMatch && topicData && topicData.examples) {
      const exs = topicData.examples;
      return `Vou te dar exemplos concretos${nameSuffix}:\n\n` +
             exs.map((e, i) => `${i + 1}. ${e.charAt(0).toUpperCase() + e.slice(1)}`).join('\n') +
             `\n\nQuer que eu detalhe algum desses?`;
    }

    // -------- "Para que serve X" / "Onde usa X" --------
    const useMatch = userMsg.match(/(?:para\s+que\s+serv[ae]m?|pra\s+que\s+serv[ae]m?|onde\s+(?:é\s+|s[ãa]o\s+)?(?:usa|usad[ao]s?|aplic[ao]m?))\s+([a-zà-úA-ZÀ-Ú\s]+?)[\?\.]?$/i);
    if (useMatch && topicData && topicData.uses) {
      return topicData.uses + (useName ? ` Faz sentido pra você, ${userName}?` : '');
    }

    // -------- Listagem --------
    if (/^(?:liste|enumere|cite|me\s+d[êe]|d[êe][- ]me|quais\s+(?:são|s\u00e3o))\s+/i.test(userMsg)) {
      if (topicData && topicData.examples) {
        return `Lista${nameSuffix}:\n\n` +
               topicData.examples.map((e, i) => `${i + 1}. ${e.charAt(0).toUpperCase() + e.slice(1)}`).join('\n');
      }
      return `Posso te dar uma lista, mas seria mais útil se você me desse um pouco mais de contexto sobre o que exatamente você quer enumerar. Estamos falando de exemplos práticos, tipos, etapas, ferramentas? Me orienta um pouco que eu monto uma lista mais útil${nameSuffix}.`;
    }

    // -------- Opinião --------
    if (/(?:o\s+que\s+você\s+acha|sua\s+opinião|você\s+recomenda|vale\s+a\s+pena)/i.test(userMsg)) {
      if (topicKey) {
        return `Sobre ${topicKey}, minha visão é que vale a pena entender bem os fundamentos antes de partir pra ferramentas. ` +
               `É um campo onde o hype anda na frente da realidade, então quem entende o que está por baixo toma decisões melhores. ` +
               `Mas o melhor é experimentar, qual seu caso de uso específico${nameSuffix}?`;
      }
      return `Honestamente depende muito do contexto${nameSuffix}. Me conta mais sobre a situação que você quer me dá uma opinião mais útil.`;
    }

    // -------- "Por que" --------
    if (/^por\s*qu[eê]/i.test(userMsg)) {
      if (topicKey && KNOWLEDGE[topicKey].how) {
        return `Boa pergunta. ${KNOWLEDGE[topicKey].how}`;
      }
      return `A resposta curta é: depende dos detalhes do caso. A resposta longa envolve entender o contexto, as restrições e os trade-offs envolvidos. Se você me der mais detalhes do cenário, consigo te explicar com mais profundidade${nameSuffix}.`;
    }

    // -------- "Como" genérico --------
    if (/^como\s+/i.test(userMsg)) {
      return `Pra te dar um passo a passo útil${nameSuffix}, preciso entender um pouco mais o seu contexto. ` +
             `Você tá começando do zero ou já tem alguma base? Qual ferramenta ou linguagem você usa? ` +
             `Com essas duas infos eu monto um caminho concreto.`;
    }

    // -------- Tópico detectado, sem pattern claro --------
    if (topicData) {
      const intros = [
        `Sobre ${topicKey}, vale destacar:`,
        `Boa, esse é um tema importante${nameSuffix}.`,
        `Posso explicar.`,
      ];
      return `${intros[Math.floor(Math.random() * intros.length)]} ${topicData.what} ` +
             `\n\nQuer que eu entre em como funciona, ou prefere ver exemplos práticos?`;
    }

    // -------- Fallback variado --------
    const longMsg = userMsg.length > 50;
    const fallbacks = longMsg ? [
      `Entendi seu ponto${nameSuffix}. Pra eu te dar uma resposta mais útil, me ajuda a focar: você quer um panorama geral, exemplos práticos, ou tá tentando resolver um problema específico?`,
      `Faz sentido. Tem várias camadas nessa questão. Qual ângulo te interessa mais, o conceitual, o técnico, ou o prático?`,
      `Anotado. Posso ir por dois caminhos: te explicar a teoria primeiro, ou ir direto pra um exemplo concreto. Qual prefere${nameSuffix}?`,
    ] : [
      `Conta um pouco mais${nameSuffix}. Tô curioso pra entender o que você quer explorar.`,
      `Me dá mais contexto que eu te ajudo melhor.`,
      `Pode desenvolver${nameSuffix}? Quero entender direito antes de responder.`,
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
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
        // IA "lembra", responder com o fato real
        return formatFactAnswer(questionType, knownFact.value);
      } else {
        // IA "esqueceu", fato existe nos allFacts mas não na janela
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

    // 2) Não é pergunta sobre fato, gerar resposta contextual
    let response = generateContextualResponse(userMsg, inWindowFacts);

    // 3) Se o usuário acabou de compartilhar um fato, reconhecer de forma natural
    const newFacts = extractFacts(userMsg);
    if (newFacts.length > 0 && !questionType) {
      // Construir reconhecimento variado e natural
      const nameNew = newFacts.find(f => f.type === 'name');
      const ageNew = newFacts.find(f => f.type === 'age');
      const locNew = newFacts.find(f => f.type === 'location');

      let ack = '';
      if (nameNew && ageNew && locNew) {
        const intros = [
          `Show, ${nameNew.value}! ${ageNew.value} anos e morando em ${locNew.value}, anotado.`,
          `Oi ${nameNew.value}! Boa, ${ageNew.value} anos e de ${locNew.value}.`,
          `Beleza, ${nameNew.value}. Vou guardar: ${ageNew.value} anos, ${locNew.value}.`,
        ];
        ack = intros[Math.floor(Math.random() * intros.length)];
      } else if (nameNew) {
        const intros = [
          `Prazer, ${nameNew.value}!`,
          `Oi ${nameNew.value}, tudo bem?`,
          `Beleza, ${nameNew.value}.`,
        ];
        ack = intros[Math.floor(Math.random() * intros.length)];
      } else if (ageNew) {
        ack = `Anotado, ${ageNew.value} anos.`;
      } else {
        // Reconhecimento mais sutil pros outros fatos
        const others = newFacts.filter(f => !['name','age','location'].includes(f.type));
        if (others.length > 0) {
          const f = others[0];
          switch (f.type) {
            case 'job':      ack = `Que legal, ${f.value} é uma área que dá pano pra manga.`; break;
            case 'hobby':    ack = `Boa, ${f.value} é um hobby bacana.`; break;
            case 'food':     ack = `${f.value.charAt(0).toUpperCase() + f.value.slice(1)} é ótima escolha.`; break;
            case 'pet':      ack = `Que fofo que você tem um ${f.value}!`; break;
            case 'pet_name': ack = `${f.value} é um ótimo nome!`; break;
            case 'color':    ack = `${f.value.charAt(0).toUpperCase() + f.value.slice(1)} é uma cor bonita.`; break;
            case 'language': ack = `Boa, ${f.value} é uma escolha sólida.`; break;
          }
        }
      }

      if (ack) {
        // Detectar se a msg do usuário é "só apresentação" (fatos sem pergunta).
        // Nesse caso, substituir totalmente a resposta pelo reconhecimento + convite.
        const hasQuestion = /\?/.test(userMsg) || /^(qual|quando|onde|como|quem|quantos|quanta|que|o que|por que)\b/i.test(userMsg.trim());
        const onlyFactsNoQuestion = !hasQuestion;

        if (onlyFactsNoQuestion) {
          const invitations = [
            'Pode me perguntar qualquer coisa ou continuar contando sobre você.',
            'Em que posso te ajudar?',
            'O que você quer explorar?',
            'Manda a próxima.',
          ];
          response = ack + ' ' + invitations[Math.floor(Math.random() * invitations.length)];
        } else {
          // Usuário compartilhou fato + fez pergunta, prefixa reconhecimento e mantém resposta
          response = ack + ' ' + response;
        }
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
     send(state, userMsg, opts), simula uma chamada assíncrona de IA.
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
        break; // Não cabe mais, todas as anteriores também ficam fora
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

  /* -------- Calcula o status COMPLETO de cada mensagem.
     Para cada msg do histórico, devolve:
       { inWindow: true } se está na janela atual
       { inWindow: false, leftAt: T } se saiu da janela quando a msg #T+1 chegou
     Isso permite a UI mostrar "saiu quando msg #11 entrou", o que é
     pedagogicamente muito mais claro do que só ✓/✕.
  */
  function computeWindowHistory(history, contextWindow) {
    const status = history.map(() => ({ inWindow: true, leftAt: null }));

    // Para cada turno (do mais antigo ao mais recente), recalcula a janela
    // e marca quando cada mensagem cai fora pela PRIMEIRA vez.
    for (let t = 0; t < history.length; t++) {
      let budget = contextWindow;
      const inSet = new Set();
      for (let i = t; i >= 0; i--) {
        if (budget - history[i].tokens >= 0) {
          inSet.add(i);
          budget -= history[i].tokens;
        } else break;
      }
      // Marca as que NÃO estão na janela no turno t e ainda não tinham caído
      for (let i = 0; i <= t; i++) {
        if (!inSet.has(i) && status[i].leftAt === null) {
          status[i].leftAt = t;
        }
      }
    }

    // Estado final: marca o inWindow real (estado atual)
    const finalIn = computeInWindow(history, contextWindow);
    for (let i = 0; i < history.length; i++) {
      status[i].inWindow = finalIn.has(i);
    }

    return status;
  }

  return {
    countTokens,
    extractFacts,
    send,
    computeInWindow,
    computeWindowHistory,
  };
})();

window.Simulation = Simulation;
