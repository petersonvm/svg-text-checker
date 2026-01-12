# SVG A11Y Assist (Extensão VS Code)

Extensão que detecta em tempo real elementos `<svg>` sem acessibilidade adequada e oferece um *Quick Fix* para gerar automaticamente título/descrição ou marcar como decorativo usando IA (ou heurística local se nenhuma API estiver configurada).

## Objetivo
Prevenir falhas do tipo "Missing Alternative Text" em SVG conforme diretrizes WCAG, inserindo `<title>`, `<desc>` e atributos ARIA apropriados.

## Funcionalidades
- Scanner de documento (HTML / JSX / TSX) detecta `<svg>`:
	- Falha se não possuir `<title>` ou `<desc>` e também não tiver `aria-hidden="true"`.
- Cria diagnóstico (warning) com código `svg-missing-a11y`.
- Quick Fix: "Gerar Acessibilidade para SVG com IA".
- Chama serviço de IA (endpoint configurável) com *prompt* refinado e espera JSON:
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

## Arquitetura
| Arquivo | Responsabilidade |
|---------|------------------|
| `src/extension.ts` | Ativação, diagnósticos, provider de Code Action, aplicação de edits |
| `src/svgParser.ts` | Localiza blocos `<svg>` e determina necessidade de acessibilidade |
| `src/prompt.ts` | Monta prompt estruturado para IA |
| `src/iaClient.ts` | Cliente IA genérico + fallback heurístico |
| `build/esbuild.js` | Bundle rápido com esbuild |

## Prompt Enviado à IA
Construído em `buildPrompt(svgCode)`:
```
Você é um especialista em Acessibilidade Web (WCAG) focado em SVGs. Sua tarefa é analisar o código SVG fornecido e retornar a estrutura de acessibilidade mais adequada em um objeto JSON.

Decisões:
1. Determine se o SVG é Informativo (requer <title>) ou Decorativo (pode ser aria-hidden).
2. Se informativo, gere um título breve (<=10 palavras) e, se complexo (gráfico, diagrama, múltiplos elementos de dados), gere uma descrição detalhada.

Formato de Saída (JSON Obrigatório):
{
	"isDecorative": true/false,
	"titleText": "Título breve e funcional (máx. 10 palavras).",
	"descText": "Descrição detalhada ou string vazia"
}

Responda somente com JSON válido.

Input SVG:
<svg>...</svg>
```

## Configurações
Em `settings.json` ou GUI:
- `svgA11yAssist.apiKey`: chave da API (ou usar env `SVG_A11Y_API_KEY`).
- `svgA11yAssist.endpoint`: URL do endpoint IA. Vazio => modo mock.
- `svgA11yAssist.model`: nome do modelo (opcional).

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

## Fluxo Interno
1. `findSvgNodes` encontra `<svg>` e avalia presença de `<title>`, `<desc>`, `aria-hidden`.
2. Diagnóstico criado se faltar tudo.
3. Quick Fix chama `iaClient.suggestForSvg`.
4. IA retorna JSON; fallback heurístico se erro.
5. `buildWorkspaceEditForSuggestion` aplica mudanças.

## Limitações & Próximos Passos
- Parser simplificado (regex) pode falhar em SVG fragmentado ou template strings complexas.
- Não trata múltiplas correções simultâneas (processa primeiro alvo). Pode-se expandir para aplicar em todos.
- Suporte adicional a `role="presentation"` quando decorativo poderia ser adicionado.
- Testes automatizados (Jest) podem ser incluídos posteriormente.

## Licença
MIT
