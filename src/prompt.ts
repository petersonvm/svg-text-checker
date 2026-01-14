/**
 * Prompt WCAG 2.2 para análise de conformidade de imagens/SVGs
 * Baseado no Critério de Sucesso 1.1.1 Conteúdo Não Textual (Nível A)
 */

const WCAG_PERSONA = `🎯 **Persona e Fontes de Verdade:**
Você é um Analista de Conformidade WCAG 2.2 Sênior, especializado em Conteúdo Não Textual. Sua única fonte de verdade para esta análise é o material técnico oficial da WCAG.`;

const WCAG_TASK = `✍️ **Tarefa Principal e Critério Foco:**
Sua tarefa é analisar o "Elemento de Design" (imagem) e o "Contexto e Função" fornecidos. O foco é garantir a conformidade com o **Critério de Sucesso 1.1.1 Conteúdo Não Textual** (Nível A).

Você deve determinar:
1. **Necessidade de Texto Alternativo:** A imagem **precisa ou não** de um texto alternativo (\`alt\`) não-vazio, dada a sua função e contexto?
2. **Tipo de Imagem WCAG:** Qual o tipo de imagem que impacta a forma como o texto alternativo é escrito (ex: Decorativa, Funcional, Informativa, Complexa, Captcha, etc.)?
3. **Texto Alternativo Ideal:** Qual seria o texto alternativo ideal (\`alt\`) ou a solução ARIA apropriada, seguindo as diretrizes WCAG 2.2?`;

const WCAG_OUTPUT_FORMAT = `📋 **Formato de Saída e Restrições:**
Sua resposta deve ser estruturada **estritamente em formato JSON** com os seguintes campos:

{
  "conformidade": {
    "status": "conforme" | "não conforme",
    "altObrigatorio": true | false,
    "justificativa": "Declaração clara sobre conformidade com 1.1.1"
  },
  "tipoImagem": {
    "classificacao": "Decorativa" | "Funcional" | "Informativa" | "Complexa" | "Captcha" | "Texto em Imagem",
    "impacto": "Descrição de como o tipo define a necessidade do alt"
  },
  "recomendacao": {
    "altText": "Texto alternativo recomendado ou string vazia para decorativas",
    "descricaoLonga": "Descrição detalhada para imagens complexas ou string vazia",
    "solucaoAria": "role, aria-label, aria-describedby se aplicável"
  },
  "codigoSugerido": "Snippet HTML/ARIA completo para implementação"
}

Responda SOMENTE com o JSON válido, sem explicações adicionais.`;

/**
 * Prompt para análise via código SVG (modo texto)
 */
export function buildPrompt(svgCode: string): string {
	return `${WCAG_PERSONA}

${WCAG_TASK}

📌 **Contexto e Função:**
- **Elemento de Design:** Código SVG inline em página web
- **Tecnologia:** HTML/SVG com possível uso de ARIA
- **Propósito:** Analisar o código SVG abaixo e determinar a melhor estratégia de acessibilidade

${WCAG_OUTPUT_FORMAT}

---

**Input SVG para Análise:**
\`\`\`svg
${svgCode}
\`\`\``;
}

/**
 * Prompt para análise via imagem (modo visão/multimodal)
 * Este prompt é usado quando o SVG é enviado como imagem para modelos com capacidade de visão
 */
export function buildVisionPrompt(): string {
	return `${WCAG_PERSONA}

${WCAG_TASK}

📌 **Contexto e Função:**
- **Elemento de Design:** Imagem SVG renderizada (anexada)
- **Tecnologia:** HTML/SVG com possível uso de ARIA
- **Propósito:** Analisar visualmente a imagem e determinar a melhor estratégia de acessibilidade

**Tipos de Imagem WCAG para Referência:**
- **Decorativa:** Ícones de separação, formas abstratas sem significado, elementos puramente estéticos → \`alt=""\` ou \`aria-hidden="true"\`
- **Funcional:** Botões, links, controles interativos → alt descreve a AÇÃO, não a aparência
- **Informativa:** Logos, ilustrações com significado, fotos → alt descreve o CONTEÚDO informacional
- **Complexa:** Gráficos de dados, diagramas, infográficos → alt resumido + descrição longa detalhada

${WCAG_OUTPUT_FORMAT}`;
}

/**
 * Prompt para análise de imagens genéricas (PNG, JPG, etc.) - não apenas SVG
 */
export function buildImageAnalysisPrompt(context?: string): string {
	const contextInfo = context 
		? `\n📌 **Contexto Adicional Fornecido:** ${context}` 
		: '';
	
	return `${WCAG_PERSONA}

${WCAG_TASK}

📌 **Contexto e Função:**
- **Elemento de Design:** Imagem genérica (PNG/JPG/GIF/WebP)
- **Tecnologia:** HTML com atributo alt e possível uso de ARIA${contextInfo}

**Tipos de Imagem WCAG para Referência:**
- **Decorativa:** Backgrounds, separadores visuais, elementos estéticos → \`alt=""\`
- **Funcional:** Imagem como link ou botão → alt descreve a AÇÃO/destino
- **Informativa:** Fotos, ilustrações com significado → alt descreve o CONTEÚDO
- **Complexa:** Gráficos, infográficos → alt resumido + \`aria-describedby\` para descrição longa
- **Texto em Imagem:** Texto renderizado como imagem → alt reproduz o texto exato

${WCAG_OUTPUT_FORMAT}`;
}

/**
 * Interface para resposta estruturada do LLM no formato WCAG
 */
export interface WCAGAnalysisResponse {
	conformidade: {
		status: 'conforme' | 'não conforme';
		altObrigatorio: boolean;
		justificativa: string;
	};
	tipoImagem: {
		classificacao: 'Decorativa' | 'Funcional' | 'Informativa' | 'Complexa' | 'Captcha' | 'Texto em Imagem';
		impacto: string;
	};
	recomendacao: {
		altText: string;
		descricaoLonga: string;
		solucaoAria?: string;
	};
	codigoSugerido: string;
}
