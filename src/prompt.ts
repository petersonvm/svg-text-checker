/**
 * Prompt para análise via código SVG (modo texto)
 */
export function buildPrompt(svgCode: string): string {
	return `Você é um especialista em Acessibilidade Web (WCAG) focado em SVGs. Sua tarefa é analisar o código SVG fornecido e retornar a estrutura de acessibilidade mais adequada em um objeto JSON.\n\nDecisões:\n1. Determine se o SVG é Informativo (requer <title>) ou Decorativo (pode ser aria-hidden).\n2. Se informativo, gere um título breve (<=10 palavras) e, se complexo (gráfico, diagrama, múltiplos elementos de dados), gere uma descrição detalhada.\n\nFormato de Saída (JSON Obrigatório):\n{\n  "isDecorative": true/false,\n  "titleText": "Título breve e funcional (máx. 10 palavras).",\n  "descText": "Descrição detalhada ou string vazia"\n}\n\nResponda somente com JSON válido.\n\nInput SVG:\n${svgCode}`;
}

/**
 * Prompt para análise via imagem (modo visão/multimodal)
 * Este prompt é usado quando o SVG é enviado como imagem para modelos com capacidade de visão
 */
export function buildVisionPrompt(): string {
	return `Você é um especialista em Acessibilidade Web (WCAG). Analise esta imagem SVG e determine a melhor abordagem de acessibilidade.

## Sua Tarefa:
1. **Observe a imagem** e identifique o que ela representa visualmente
2. **Determine se é decorativa** (apenas estética, sem informação) ou **informativa** (transmite dados, conceitos ou ações)
3. **Se informativa**, crie textos alternativos apropriados

## Critérios de Decisão:
- **Decorativo**: ícones de separação, formas abstratas sem significado, elementos puramente estéticos
- **Informativo**: gráficos de dados, ícones de ação, logos, diagramas, ilustrações com significado

## Diretrizes para Textos:
- **titleText**: Máximo 10 palavras. Descreva a função/propósito, não a aparência. Ex: "Gráfico de vendas mensais" (não "Barras coloridas")
- **descText**: Apenas para SVGs complexos (gráficos, diagramas). Descreva os dados ou informações representadas. Deixe vazio para ícones simples.

## Formato de Saída (JSON Obrigatório):
{
  "isDecorative": true | false,
  "titleText": "Título breve e funcional",
  "descText": "Descrição detalhada ou string vazia"
}

Responda SOMENTE com o JSON, sem explicações adicionais.`;
}

/**
 * Prompt para análise de imagens genéricas (PNG, JPG, etc.) - não apenas SVG
 */
export function buildImageAnalysisPrompt(context?: string): string {
	const contextInfo = context ? `\n\nContexto adicional: ${context}` : '';
	
	return `Você é um especialista em Acessibilidade Web (WCAG). Analise esta imagem e gere textos alternativos apropriados para uso em aplicações web.

## Sua Tarefa:
1. **Descreva o conteúdo visual** da imagem
2. **Identifique o propósito** provável da imagem no contexto web
3. **Gere textos alternativos** seguindo boas práticas de acessibilidade

## Diretrizes:
- Se a imagem parece ser **decorativa** (background, separador visual), indique isso
- Para imagens **informativas**, forneça:
  - Um texto alternativo curto (alt text) de até 125 caracteres
  - Uma descrição longa se a imagem for complexa (gráficos, infográficos)

## Formato de Saída (JSON Obrigatório):
{
  "isDecorative": true | false,
  "titleText": "Texto alternativo curto e funcional",
  "descText": "Descrição detalhada para imagens complexas ou string vazia"
}${contextInfo}

Responda SOMENTE com o JSON, sem explicações adicionais.`;
}
