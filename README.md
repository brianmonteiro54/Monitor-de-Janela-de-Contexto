# Monitor de Janela de Contexto

Aplicação didática para demonstrar **janela de contexto** em LLMs ,  pensada para a aula de **IA Practitioner**, slide "Janela de contexto" do Encontro 2.

Roda 100% no navegador: sem Python, sem servidor, sem build. É só um `index.html` com JS estático. Funciona em **modo simulação** (sem API key) e em **modo real** (Google Gemini, com API key gratuita).

---

## Por que isso existe

Os slides explicam janela de contexto na teoria. Mas o aluno só **sente** o conceito quando vê a IA "esquecer" o nome dele em tempo real, com o contador de tokens batendo no limite. Esse app faz exatamente isso.

O modo simulação é o ponto crítico: muitos professores não querem ou não conseguem pagar uma API só pra dar uma aula. Sem o modo simulação, a ferramenta é inútil pra eles. Com ele, a aula acontece igual — a "IA" simulada de propósito esquece fatos quando a mensagem original sai da janela.

---

## Deploy no GitHub Pages (3 passos)

1. Crie um repositório no GitHub e suba a pasta inteira (`index.html`, `assets/`, `README.md`).
2. Em **Settings → Pages**, selecione branch `main` e pasta `/ (root)`. Salve.
3. Aguarde ~1 min. O app fica disponível em `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

Pronto. O professor abre o link na aula, escolhe modo simulação ou cola a API key dele — a chave fica só no `localStorage` do navegador dele, nunca sobe pra lugar nenhum.

Não precisa de servidor obrigatoriamente — abrir o `index.html` direto no navegador também funciona, só algumas funcionalidades de `localStorage` ficam mais restritas em `file://` em alguns navegadores.

---

## Como usar em aula

### Modo Simulação (sem API key)

1. No painel da esquerda, deixe em **Simulação**.
2. Ajuste a **janela de contexto** pra `150` tokens (deliberadamente pequena — pra forçar overflow rápido).
3. Mande a primeira mensagem: `Meu nome é Maria, tenho 30 anos e moro no Rio.`
4. Faça umas 4–5 perguntas longas sobre qualquer assunto (machine learning, história, o que for) — o objetivo é **empurrar a primeira mensagem pra fora da janela**.
5. Pergunte: **`Qual meu nome?`**
6. A IA simulada responde "_Desculpe, não tenho essa informação..._" e o aluno vê na tela a mensagem #1 marcada como **FORA DA JANELA**.

Para um efeito ainda mais dramático, ative o toggle **"Modo alucinação"** antes do passo 5 — aí em vez de admitir, a IA **inventa** um nome errado, com aviso explicativo. Bom para mostrar o que acontece com modelos que não foram treinados pra dizer "não sei".

### Modo Real (com API key Gemini)

1. Pegue uma key em [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey) (gratuita).
2. Cole no campo "API Key" do painel esquerdo. A chave fica em `localStorage` — não sai do navegador.
3. Escolha modelo (`gemini-2.5-flash` é o mais barato e suficiente pra demo).
4. Use normalmente. O contador mostra tokens e estimativa de custo real em USD.

---

## Demos prontas

No topo do painel da esquerda há três botões de "demo pronta" que populam um cenário:

- **Esquecimento clássico** — janela 150, sem alucinação. Mostra a IA admitindo que não sabe.
- **Crescimento da janela** — janela 800, sem alucinação. Mostra os gráficos crescendo gradualmente até o limite.
- **Alucinação** — janela 200, com alucinação ativada. Mostra a IA inventando fatos errados.

Use eles como ponto de partida e modifique ao vivo durante a aula.

---

## Arquitetura

```
context-window-monitor/
├── index.html              # Dashboard de 3 colunas (config / chat / gráficos)
├── README.md
└── assets/
    ├── styles.css          # Tema escuro (otimizado pra projetor de sala)
    ├── simulation.js       # Motor de IA falsa (extração de fatos + memória de janela)
    ├── gemini-client.js    # Cliente fetch pra API Gemini real
    ├── charts.js           # Wrappers Chart.js (crescimento cumulativo + barras por msg)
    └── app.js              # Estado, eventos, renderização
```

Dependências externas (via CDN, não precisam baixar):
- Chart.js 4.4.1
- Google Fonts (Manrope, JetBrains Mono)

---

## O que o motor de simulação faz por baixo dos panos

O simulador imita o comportamento real de uma janela de contexto:

1. **Tokenização aproximada**: `≈ length / 4` (mesma heurística que tokenizers reais usam como first-order).
2. **Extração de fatos**: detecta nome, idade, localização, profissão, hobby, comida, pet, cor, número, linguagem etc. via regex em português. Cada fato fica associado à mensagem que o introduziu.
3. **Cálculo da janela**: a cada turno, recompõe a janela de trás pra frente até bater no limite (igual LLM real faz).
4. **Lógica de resposta**:
   - Se o aluno pergunta sobre um fato e a mensagem original ainda está na janela → IA responde correto.
   - Se a mensagem original **saiu** da janela → IA diz que não sabe, ou (se alucinação ON) inventa um valor errado garantidamente diferente do real.
5. **Feedback visual**: mensagens fora da janela aparecem em cinza com tarja "FORA DA JANELA".

O simulador foi cuidadosamente projetado pra ser **didaticamente honesto**: ele não trapaceia, não força respostas erradas em hora errada. Ele só obedece à regra "se saiu da janela, não tem acesso".

---

## Licença

Uso livre pra fins educacionais. Adapte como quiser.
