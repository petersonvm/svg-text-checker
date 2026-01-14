# SVG A11Y Assist (Extensão VS Code)

Extensão que detecta em tempo real elementos `<svg>` sem acessibilidade adequada e oferece um *Quick Fix* para gerar automaticamente título/descrição ou marcar como decorativo usando IA (ou heurística local se nenhuma API estiver configurada).

## Objetivo
Prevenir falhas do tipo "Missing Alternative Text" em SVG conforme diretrizes WCAG, inserindo `<title>`, `<desc>` e atributos ARIA apropriados.

---

## 🏗️ Modelo de Implementação e Arquitetura

### Padrões Arquiteturais Aplicados

#### 1. **Arquitetura em Camadas (Layered Architecture)**
O projeto segue uma separação clara de responsabilidades em camadas:

```
┌─────────────────────────────────────────────────────────────────┐
│                      CAMADA DE APRESENTAÇÃO                      │
│  extension.ts - UI, Diagnósticos, Code Actions, Status Bar      │
├─────────────────────────────────────────────────────────────────┤
│                      CAMADA DE SERVIÇOS                          │
│  iaClient.ts - Orquestração de chamadas IA, fallback            │
├─────────────────────────────────────────────────────────────────┤
│                      CAMADA DE DOMÍNIO                           │
│  svgParser.ts - Análise de SVG, regras de acessibilidade        │
│  prompt.ts - Engenharia de prompts, templates                   │
├─────────────────────────────────────────────────────────────────┤
│                      CAMADA DE INFRAESTRUTURA                    │
│  svgRenderer.ts - Renderização Base64, integração APIs          │
└─────────────────────────────────────────────────────────────────┘
```

#### 2. **Strategy Pattern (Padrão Estratégia)**
O `iaClient.ts` implementa o padrão Strategy para alternar entre diferentes estratégias de análise:
- **Estratégia Texto**: Envia código SVG como texto para modelos de linguagem
- **Estratégia Visão**: Renderiza SVG e envia como imagem para modelos multimodais
- **Estratégia Heurística**: Fallback local quando API não está disponível

```typescript
// Seleção dinâmica de estratégia
if (!this.opts.endpoint || !this.opts.apiKey) {
    return this.mockHeuristic(svgCode);  // Estratégia 3
}
if (this.opts.useVision) {
    return this.suggestWithVision(svgCode);  // Estratégia 2
}
return this.suggestWithText(svgCode);  // Estratégia 1
```

#### 3. **Adapter Pattern (Padrão Adaptador)**
O sistema adapta diferentes APIs de IA para uma interface comum:

```typescript
// Interface comum de resposta
interface IAResponseSuggestion {
    isDecorative: boolean;
    titleText?: string;
    descText?: string;
}

// Adaptadores por provedor (OpenAI, Claude, Gemini)
switch (provider) {
    case 'openai': // Adapta formato OpenAI
    case 'claude': // Adapta formato Anthropic
    case 'gemini': // Adapta formato Google
}
```

#### 4. **Factory Pattern (Padrão Fábrica)**
A função `createIAClient()` atua como factory, criando instâncias configuradas do cliente IA:

```typescript
export function createIAClient(): IAClient {
    const config = vscode.workspace.getConfiguration('svgA11yAssist');
    return new IAClient({ 
        apiKey, endpoint, model, useVision 
    });
}
```

### Diagrama de Fluxo de Dados

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Documento  │────▶│  svgParser   │────▶│  Diagnóstico │
│  HTML/JSX    │     │  findSvgNodes│     │   Warning    │
└──────────────┘     └──────────────┘     └──────────────┘
                                                  │
                                                  ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Correção   │◀────│   iaClient   │◀────│  Quick Fix   │
│   Aplicada   │     │ suggestForSvg│     │   Trigger    │
└──────────────┘     └──────────────┘     └──────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │  Texto   │  │  Visão   │  │Heurística│
        │   API    │  │   API    │  │  Local   │
        └──────────┘  └──────────┘  └──────────┘
```

### Princípios SOLID Aplicados

| Princípio | Aplicação |
|-----------|-----------|
| **S**ingle Responsibility | Cada módulo tem uma única responsabilidade (parser, renderer, client) |
| **O**pen/Closed | Novos provedores de IA podem ser adicionados sem modificar código existente |
| **L**iskov Substitution | Todas as estratégias de IA retornam o mesmo tipo `IAResponseSuggestion` |
| **I**nterface Segregation | Interfaces pequenas e específicas (`IAClientOptions`, `RenderedImage`) |
| **D**ependency Inversion | `extension.ts` depende de abstrações (`IAClient`), não implementações concretas |

---

## Funcionalidades
- Scanner de documento (HTML / JSX / TSX) detecta `<svg>`:
	- Falha se não possuir `<title>` ou `<desc>` e também não tiver `aria-hidden="true"`.
- Cria diagnóstico (warning) com código `svg-missing-a11y`.
- Quick Fix: "Gerar Acessibilidade para SVG com IA".
- **Modo Texto**: Envia código SVG para análise via prompt refinado.
- **Modo Visão**: Renderiza SVG como imagem e usa modelos multimodais (GPT-4V, Claude Vision, Gemini) para análise visual.
- **Indicadores Visuais**: Barra de status animada e notificações de progresso durante análise.
- **Heurística Inteligente**: Fallback local que detecta ícones, gráficos, logos e formas decorativas.
- Chama serviço de IA (endpoint configurável) e espera JSON:
	```jsonc
	{
		"isDecorative": true/false,
		"titleText": "Título breve e funcional (máx. 10 palavras).",
		"descText": "Descrição detalhada ou string vazia"
	}
	```
- Aplica correção:
	- Se `isDecorative: true` => adiciona `aria-hidden="true"`.
	- Se `false` => adiciona `<title id="...">`, opcional `<desc>`, `role="img"`, `aria-labelledby="..."`.
- Se nenhuma API configurada, gera sugestão heurística local.

## Arquitetura de Arquivos

| Arquivo | Responsabilidade | Padrões |
|---------|------------------|---------|
| `src/extension.ts` | Ativação, diagnósticos, Code Actions, UI | Facade, Observer |
| `src/svgParser.ts` | Localiza blocos `<svg>` e analisa acessibilidade | Domain Logic |
| `src/svgRenderer.ts` | Renderiza SVG para Base64, payloads de visão | Adapter |
| `src/prompt.ts` | Engenharia de prompts para IA | Template Method |
| `src/iaClient.ts` | Cliente IA multi-provedor com fallback | Strategy, Adapter, Factory |
| `build/esbuild.js` | Bundle rápido com esbuild | Build Tool |

## Fluxo de Análise com IA

### Modo Texto (Padrão)
```
SVG Code → buildPrompt() → API IA (Chat) → JSON Response → Aplicar Correção
```

### Modo Visão (Multimodal)
```
SVG Code → renderSvgToBase64() → createVisionPayload() → API Vision → JSON Response → Aplicar Correção
```

### Modo Heurístico (Fallback)
```
SVG Code → mockHeuristic() → Análise de padrões (regex) → JSON Response → Aplicar Correção
```

## Provedores de IA Suportados

| Provedor | Endpoint | Modelo Recomendado | Formatos |
|----------|----------|-------------------|----------|
| OpenAI | `https://api.openai.com/v1/chat/completions` | `gpt-4o` | Texto, Visão |
| Anthropic | `https://api.anthropic.com/v1/messages` | `claude-3-5-sonnet-20241022` | Texto, Visão |
| Google | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `gemini-1.5-pro` | Texto, Visão |

## Prompts de IA

### Prompt de Texto
Construído em `buildPrompt(svgCode)` - envia código SVG para análise semântica.

### Prompt de Visão
Construído em `buildVisionPrompt()` - acompanha a imagem renderizada do SVG para análise visual.

```
Você é um especialista em Acessibilidade Web (WCAG). Analise esta imagem SVG...

Critérios de Decisão:
- Decorativo: ícones de separação, formas abstratas sem significado
- Informativo: gráficos de dados, ícones de ação, logos, diagramas

Formato de Saída (JSON Obrigatório):
{
  "isDecorative": true | false,
  "titleText": "Título breve e funcional",
  "descText": "Descrição detalhada ou string vazia"
}
```

## Configurações
Em `settings.json` ou GUI:
- `svgA11yAssist.apiKey`: chave da API (ou usar env `SVG_A11Y_API_KEY`).
- `svgA11yAssist.endpoint`: URL do endpoint IA. Vazio => modo heurístico.
- `svgA11yAssist.model`: nome do modelo (ex: `gpt-4o`, `claude-3-5-sonnet-20241022`).
- `svgA11yAssist.useVision`: Habilita análise visual com modelos multimodais.

### Exemplo de Configuração (OpenAI com Visão)
```json
{
  "svgA11yAssist.apiKey": "sk-...",
  "svgA11yAssist.endpoint": "https://api.openai.com/v1/chat/completions",
  "svgA11yAssist.model": "gpt-4o",
  "svgA11yAssist.useVision": true
}
```

### Exemplo de Configuração (Claude com Visão)
```json
{
  "svgA11yAssist.apiKey": "sk-ant-...",
  "svgA11yAssist.endpoint": "https://api.anthropic.com/v1/messages",
  "svgA11yAssist.model": "claude-3-5-sonnet-20241022",
  "svgA11yAssist.useVision": true
}
```

## Execução / Desenvolvimento
Requisitos: Node 18+, pnpm.

Instalação deps:
```bash
pnpm install
```

Build único:
```bash
pnpm build
```

Modo watch:
```bash
pnpm dev
```

No VS Code: Pressione F5 (Run Extension). Um novo window *Extension Development Host* abre. Abra/edite um arquivo `.html` ou `.tsx` contendo `<svg>` para ver warnings e Quick Fix.

## Fluxo Interno Detalhado

1. **Detecção**: `findSvgNodes` encontra `<svg>` via regex e avalia presença de `<title>`, `<desc>`, `aria-hidden`.
2. **Diagnóstico**: Warning criado se SVG não tiver acessibilidade adequada.
3. **Quick Fix**: Usuário clica na lâmpada → dispara `applyFixForEditor`.
4. **Indicadores Visuais**: Barra de status animada + notificação de progresso.
5. **Análise IA**: `iaClient.suggestForSvg` escolhe estratégia (texto/visão/heurística).
6. **Resposta**: IA retorna JSON com sugestão; fallback heurístico se erro.
7. **Aplicação**: `buildWorkspaceEditForSuggestion` aplica mudanças no documento.
8. **Feedback**: Mensagem de sucesso informando o resultado.

## Heurística Local Inteligente

Quando a API não está disponível, o sistema analisa o SVG localmente:

| Padrão Detectado | Classificação | Título Sugerido |
|------------------|---------------|-----------------|
| ViewBox 24x24 + paths complexos | Ícone de ação | "Ícone" |
| Múltiplas linhas paralelas | Menu hamburger | "Ícone de menu" |
| Elemento `<text>` presente | Logo/Texto | "Logotipo" |
| Múltiplos rects/circles + "chart" | Gráfico | "Gráfico de dados" |
| Forma simples isolada | Decorativo | aria-hidden="true" |

## Limitações & Próximos Passos
- Parser simplificado (regex) pode falhar em SVG fragmentado ou template strings complexas.
- Não trata múltiplas correções simultâneas (processa primeiro alvo). Pode-se expandir para aplicar em todos.
- Suporte adicional a `role="presentation"` quando decorativo poderia ser adicionado.
- Testes automatizados (Jest) podem ser incluídos posteriormente.
- Cache de respostas da IA para SVGs idênticos.

## Licença
MIT
