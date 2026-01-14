# A11Y Assist (Extensão VS Code)

Extensão que detecta em tempo real elementos `<svg>` e `<img>` sem acessibilidade adequada e oferece um *Quick Fix* para gerar automaticamente título/descrição ou marcar como decorativo usando IA (ou heurística local se nenhuma API estiver configurada).

## Objetivo
Prevenir falhas do tipo "Missing Alternative Text" em SVG e imagens conforme diretrizes **WCAG 2.2 (Critério 1.1.1 - Conteúdo Não Textual)**, inserindo `<title>`, `<desc>`, atributos `alt` e ARIA apropriados.

---

## 🏗️ Modelo de Implementação e Arquitetura

### Padrões Arquiteturais Aplicados

#### 1. **Arquitetura em Camadas (Layered Architecture)**
O projeto segue uma separação clara de responsabilidades em camadas:

```
┌─────────────────────────────────────────────────────────────────┐
│                      CAMADA DE APRESENTAÇÃO                      │
│  extension.ts - UI, Diagnósticos SVG/IMG, Code Actions, Status  │
├─────────────────────────────────────────────────────────────────┤
│                      CAMADA DE SERVIÇOS                          │
│  iaClient.ts - Orquestração de chamadas IA, fallback, .env      │
├─────────────────────────────────────────────────────────────────┤
│                      CAMADA DE DOMÍNIO                           │
│  svgParser.ts - Análise de SVG/IMG, regras de acessibilidade    │
│  prompt.ts - Engenharia de prompts WCAG 2.2, templates          │
├─────────────────────────────────────────────────────────────────┤
│                      CAMADA DE INFRAESTRUTURA                    │
│  svgRenderer.ts - Renderização Base64, payloads de visão        │
│  fs (Node.js) - Leitura de imagens locais para análise          │
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
A função `createIAClient()` atua como factory, criando instâncias configuradas do cliente IA com suporte a múltiplas fontes de configuração:

```typescript
export function createIAClient(): IAClient {
    // Carregar variáveis do arquivo .env
    const envConfig = loadEnvConfig();
    
    // Ler configurações do VS Code
    const config = vscode.workspace.getConfiguration('svgA11yAssist');
    
    // Prioridade: VS Code settings > .env > variáveis de ambiente do sistema
    const apiKey = config.get<string>('apiKey') 
        || envConfig['SVG_A11Y_API_KEY'] 
        || envConfig['OPENAI_API_KEY']
        || process.env.SVG_A11Y_API_KEY;
        
    return new IAClient({ apiKey, endpoint, model, useVision });
}
```

### Diagrama de Fluxo de Dados

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Documento  │────▶│  svgParser   │────▶│  Diagnóstico │
│  HTML/JSX    │     │ findSvgNodes │     │   Warning    │
│              │     │ findImgNodes │     │  SVG / IMG   │
└──────────────┘     └──────────────┘     └──────────────┘
                                                  │
                                                  ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Correção   │◀────│   iaClient   │◀────│  Quick Fix   │
│   Aplicada   │     │ suggestForSvg│     │   Trigger    │
│              │     │ suggestForImg│     │              │
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

### Análise de SVG
- Scanner de documento (HTML / JSX / TSX) detecta `<svg>`:
	- Falha se não possuir `<title>` ou `<desc>` e também não tiver `aria-hidden="true"`.
- Cria diagnóstico (warning) com código `svg-missing-a11y`.
- Quick Fix: "🎨 Gerar acessibilidade para SVG com IA".

### Análise de Imagens (NOVO!)
- Scanner detecta tags `<img>` sem atributo `alt`:
	- Falha se não possuir `alt` e também não tiver `aria-hidden="true"` ou `role="presentation"`.
- Cria diagnóstico (warning) com código `img-missing-alt`.
- Quick Fix: "🖼️ Gerar alt para imagem com IA".
- **Suporte a imagens locais**: Lê arquivos do sistema de arquivos e envia como base64 para análise visual.
- **Suporte a URLs externas**: Analisa imagens de URLs HTTP/HTTPS diretamente.

### Modos de Análise
- **Modo Texto**: Envia código SVG ou caminho da imagem para análise via prompt refinado.
- **Modo Visão**: Renderiza SVG/imagem e usa modelos multimodais (GPT-4o, Claude Vision, Gemini) para análise visual.
- **Heurística Inteligente**: Fallback local que detecta ícones, gráficos, logos e formas decorativas.

### Indicadores Visuais
- Barra de status animada durante análise.
- Notificações de progresso com opção de cancelamento.
- Feedback com classificação WCAG 2.2 (tipo de imagem e conformidade).

### Formato de Resposta IA
```jsonc
{
  "conformidade": {
    "status": "conforme" | "não conforme",
    "altObrigatorio": true | false,
    "justificativa": "Declaração clara sobre conformidade com 1.1.1"
  },
  "tipoImagem": {
    "classificacao": "Decorativa" | "Funcional" | "Informativa" | "Complexa",
    "impacto": "Descrição de como o tipo define a necessidade do alt"
  },
  "recomendacao": {
    "altText": "Texto alternativo recomendado",
    "descricaoLonga": "Descrição detalhada para imagens complexas",
    "solucaoAria": "role, aria-label, aria-describedby se aplicável"
  },
  "codigoSugerido": "Snippet HTML/ARIA completo para implementação"
}
```

### Aplicação de Correções
- **SVG Decorativo**: adiciona `aria-hidden="true"`.
- **SVG Informativo**: adiciona `<title id="...">`, opcional `<desc>`, `role="img"`, `aria-labelledby="..."`.
- **IMG Decorativa**: adiciona `alt=""`.
- **IMG Informativa**: adiciona `alt="descrição gerada pela IA"`.
- Se nenhuma API configurada, gera sugestão heurística local.

## Arquitetura de Arquivos

| Arquivo | Responsabilidade | Padrões |
|---------|------------------|---------|
| `src/extension.ts` | Ativação, diagnósticos SVG/IMG, Code Actions, UI | Facade, Observer |
| `src/svgParser.ts` | Localiza blocos `<svg>` e `<img>`, analisa acessibilidade | Domain Logic |
| `src/svgRenderer.ts` | Renderiza SVG para Base64, payloads de visão | Adapter |
| `src/prompt.ts` | Engenharia de prompts WCAG 2.2 para IA | Template Method |
| `src/iaClient.ts` | Cliente IA multi-provedor com fallback e análise de imagens locais | Strategy, Adapter, Factory |
| `build/esbuild.js` | Bundle rápido com esbuild | Build Tool |

## Fluxo de Análise com IA

### Modo Texto (Padrão)
```
Código SVG/IMG → buildPrompt() → API IA (Chat) → JSON Response → Aplicar Correção
```

### Modo Visão (Multimodal)
```
SVG → renderSvgToBase64() → createVisionPayload() → API Vision → JSON Response → Aplicar Correção
IMG Local → fs.readFile() → Base64 → createVisionPayload() → API Vision → JSON Response → Aplicar Correção
IMG URL → URL direta → API Vision → JSON Response → Aplicar Correção
```

### Modo Heurístico (Fallback)
```
SVG/IMG → mockHeuristic() / mockImgHeuristic() → Análise de padrões → JSON Response → Aplicar Correção
```

## Provedores de IA Suportados

| Provedor | Endpoint | Modelo Recomendado | Formatos |
|----------|----------|-------------------|----------|
| OpenAI | `https://api.openai.com/v1/chat/completions` | `gpt-4o` | Texto, Visão |
| Anthropic | `https://api.anthropic.com/v1/messages` | `claude-3-5-sonnet-20241022` | Texto, Visão |
| Google | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `gemini-1.5-pro` | Texto, Visão |

## Prompts de IA

### Prompt WCAG 2.2 (Texto e Visão)
O sistema utiliza prompts estruturados baseados no **Critério de Sucesso 1.1.1 Conteúdo Não Textual** (Nível A):

```
🎯 Persona: Analista de Conformidade WCAG 2.2 Sênior

✍️ Tarefa: Determinar:
1. Necessidade de Texto Alternativo
2. Tipo de Imagem WCAG (Decorativa, Funcional, Informativa, Complexa, Captcha, Texto em Imagem)
3. Texto Alternativo Ideal

📋 Formato de Saída: JSON estruturado com conformidade, tipoImagem, recomendacao e codigoSugerido
```

### Tipos de Imagem WCAG
| Tipo | Descrição | Solução |
|------|-----------|---------|
| **Decorativa** | Ícones de separação, formas abstratas sem significado | `alt=""` ou `aria-hidden="true"` |
| **Funcional** | Botões, links, controles interativos | alt descreve a AÇÃO |
| **Informativa** | Logos, ilustrações, fotos com significado | alt descreve o CONTEÚDO |
| **Complexa** | Gráficos de dados, diagramas, infográficos | alt resumido + descrição longa |
| **Texto em Imagem** | Texto renderizado como imagem | alt reproduz o texto exato |

## Configurações
Em `settings.json` ou GUI:
- `svgA11yAssist.apiKey`: chave da API (ou usar variáveis de ambiente).
- `svgA11yAssist.endpoint`: URL do endpoint IA. Vazio => modo heurístico.
- `svgA11yAssist.model`: nome do modelo (ex: `gpt-4o`, `claude-3-5-sonnet-20241022`).
- `svgA11yAssist.useVision`: Habilita análise visual com modelos multimodais.

### Suporte a Arquivo `.env` (NOVO!)
A extensão carrega automaticamente variáveis de um arquivo `.env` na raiz do workspace:

```env
# Configuração de API
SVG_A11Y_API_KEY=sk-...
SVG_A11Y_ENDPOINT=https://api.openai.com/v1/chat/completions
SVG_A11Y_MODEL=gpt-4o
SVG_A11Y_USE_VISION=true

# Alternativas por provedor
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...
```

**Prioridade de configuração**: VS Code settings > .env > variáveis de ambiente do sistema

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

### SVG
1. **Detecção**: `findSvgNodes` encontra `<svg>` via regex e avalia presença de `<title>`, `<desc>`, `aria-hidden`.
2. **Diagnóstico**: Warning criado se SVG não tiver acessibilidade adequada.
3. **Quick Fix**: Usuário clica na lâmpada → dispara `applyFixForSvg`.
4. **Indicadores Visuais**: Barra de status animada + notificação de progresso.
5. **Análise IA**: `iaClient.suggestForSvg` escolhe estratégia (texto/visão/heurística).
6. **Resposta**: IA retorna JSON WCAG 2.2; fallback heurístico se erro.
7. **Aplicação**: `buildWorkspaceEditForSuggestion` aplica mudanças no documento.
8. **Feedback**: Mensagem de sucesso com classificação WCAG.

### IMG (NOVO!)
1. **Detecção**: `findImgNodes` encontra `<img>` via regex e avalia presença de `alt`, `aria-hidden`, `role`.
2. **Diagnóstico**: Warning criado se IMG não tiver `alt`.
3. **Quick Fix**: Usuário clica na lâmpada → dispara `applyFixForImg`.
4. **Análise IA**: `iaClient.suggestForImg` escolhe estratégia:
   - **URL externa**: Envia URL diretamente para API de visão.
   - **Arquivo local**: Lê arquivo do sistema, converte para Base64, envia para API.
   - **Texto**: Analisa nome do arquivo/URL com LLM.
   - **Heurística**: Fallback local baseado em padrões de nome de arquivo.
5. **Aplicação**: `buildWorkspaceEditForImg` adiciona atributo `alt`.
6. **Feedback**: Mensagem de sucesso com texto alt gerado.

## Heurística Local Inteligente

Quando a API não está disponível, o sistema analisa SVG e imagens localmente:

### Heurística SVG
| Padrão Detectado | Classificação | Título Sugerido |
|------------------|---------------|-----------------|
| ViewBox 24x24 + paths complexos | Ícone de ação | Detecta ícone específico |
| Múltiplas linhas paralelas | Menu hamburger | "Abrir menu de navegação" |
| Elemento `<text>` presente | Logo/Texto | "Logotipo" |
| Múltiplos rects + linhas | Gráfico de barras | "Gráfico de barras" |
| Paths com arcos (comando A) | Gráfico de pizza | "Gráfico de distribuição" |
| Forma simples isolada | Decorativo | aria-hidden="true" |

### Detecção de Ícones Específicos (40+ padrões)
O sistema identifica ícones comuns por:
1. **Análise de path**: Coordenadas típicas (ex: coração com "21.35")
2. **Análise estrutural**: Combinação de elementos (ex: 1 círculo + 1 linha = lupa)
3. **Keywords**: Classes, IDs, comentários no SVG

| Ícone | Padrão | Título Gerado |
|-------|--------|---------------|
| ❤️ Coração | Path com curvas bezier específicas | "Adicionar aos favoritos" |
| 🔍 Lupa | 1 círculo + 1 linha | "Pesquisar" |
| ☰ Menu | 3 linhas horizontais | "Abrir menu de navegação" |
| ✕ Fechar | 2 linhas cruzadas | "Fechar" |
| 🔔 Sino | Path + círculo pequeno (badge) | "Ver notificações" |

### Heurística IMG (NOVO!)
| Padrão no Nome/URL | Classificação | Alt Sugerido |
|--------------------|---------------|--------------|
| `decorative`, `spacer`, `bg-image` | Decorativa | `alt=""` |
| `icon-search`, `lupa` | Ícone funcional | "Pesquisar" |
| `logo-empresa` | Logo | "Logo Empresa" |
| `banner-promo` | Informativa | "Banner promocional" |
| `product-xyz` | Produto | "Produto xyz" |
| `chart-`, `graph-` | Complexa | "Gráfico" |

## Limitações & Próximos Passos
- Parser simplificado (regex) pode falhar em SVG/IMG fragmentado ou template strings complexas.
- Não trata múltiplas correções simultâneas (processa primeiro alvo). Pode-se expandir para aplicar em todos.
- Imagens com Data URI (`data:image/...`) são suportadas parcialmente (heurística apenas).
- Suporte adicional a `role="presentation"` quando decorativo poderia ser adicionado.
- Testes automatizados (Jest) podem ser incluídos posteriormente.
- Cache de respostas da IA para SVGs/imagens idênticos.
- Suporte a análise em lote (corrigir todos os problemas de uma vez).

## Licença
MIT
