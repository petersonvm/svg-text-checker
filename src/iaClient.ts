import * as vscode from 'vscode';
import { buildPrompt, buildVisionPrompt } from './prompt';
import { renderSvgToBase64, createVisionPayload, detectAIProvider } from './svgRenderer';

/**
 * Análise WCAG 2.2 detalhada retornada pelo LLM
 */
export interface WCAGAnalysis {
	conformidade: {
		status: 'conforme' | 'não conforme';
		altObrigatorio: boolean;
		justificativa: string;
	};
	tipoImagem: {
		classificacao: 'Decorativa' | 'Funcional' | 'Informativa' | 'Complexa' | 'Captcha' | 'Texto em Imagem';
		impacto: string;
	};
	codigoSugerido: string;
}

export interface IAResponseSuggestion {
	isDecorative: boolean;
	titleText?: string;
	descText?: string;
	/** Análise detalhada WCAG 2.2 (disponível quando LLM responde no novo formato) */
	wcagAnalysis?: WCAGAnalysis;
}

export interface IAClientOptions {
	apiKey?: string;
	endpoint?: string;
	model?: string;
	useVision?: boolean; // Habilita análise visual com modelos multimodais
}

export class IAClient {
	constructor(private readonly opts: IAClientOptions) {}

	async suggestForSvg(svgCode: string): Promise<IAResponseSuggestion> {
		// If no endpoint/key provided, use heuristic mock to keep UX responsive.
		if (!this.opts.endpoint || !this.opts.apiKey) {
			return this.mockHeuristic(svgCode);
		}

		// Decide entre modo texto ou visão
		if (this.opts.useVision) {
			return this.suggestWithVision(svgCode);
		}

		return this.suggestWithText(svgCode);
	}

	/**
	 * Análise via prompt de texto (modo tradicional)
	 */
	private async suggestWithText(svgCode: string): Promise<IAResponseSuggestion> {
		// Detectar provedor para usar formato correto
		const provider = detectAIProvider(this.opts.endpoint!);
		const prompt = buildPrompt(svgCode);
		
		// Montar body no formato correto para cada provedor
		let body: object;
		let headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${this.opts.apiKey}`
		};

		switch (provider) {
			case 'openai':
				body = {
					model: this.opts.model || 'gpt-4o',
					messages: [
						{ role: 'user', content: prompt }
					],
					max_tokens: 500
				};
				break;
			
			case 'claude':
				headers['anthropic-version'] = '2023-06-01';
				headers['x-api-key'] = this.opts.apiKey!;
				delete (headers as Record<string, string | undefined>)['Authorization'];
				body = {
					model: this.opts.model || 'claude-3-5-sonnet-20241022',
					max_tokens: 500,
					messages: [
						{ role: 'user', content: prompt }
					]
				};
				break;
			
			case 'gemini':
				body = {
					contents: [
						{ parts: [{ text: prompt }] }
					],
					generationConfig: { maxOutputTokens: 500 }
				};
				break;
			
			default:
				// Formato OpenAI-like como padrão
				body = {
					model: this.opts.model || 'auto',
					messages: [
						{ role: 'user', content: prompt }
					]
				};
		}

		try {
			const resp = await fetch(this.opts.endpoint!, {
				method: 'POST',
				headers,
				body: JSON.stringify(body)
			});
			if (!resp.ok) {
				const errorText = await resp.text();
				throw new Error(`HTTP ${resp.status}: ${errorText.slice(0, 200)}`);
			}
			return this.parseVisionResponse(await resp.text(), provider);
		} catch (err) {
			vscode.window.showWarningMessage(
				`Falha na chamada de IA (texto), usando heurística local: ${(err as Error).message}`
			);
			return this.mockHeuristic(svgCode);
		}
	}

	/**
	 * Análise via modelo multimodal com visão (envia imagem + prompt)
	 */
	private async suggestWithVision(svgCode: string): Promise<IAResponseSuggestion> {
		try {
			// Renderizar SVG para Base64
			const renderedImage = await renderSvgToBase64(svgCode);
			
			// Detectar provedor de IA
			const provider = detectAIProvider(this.opts.endpoint!);
			
			// Criar payload de imagem no formato correto
			const imagePayload = createVisionPayload(
				renderedImage,
				provider === 'unknown' ? 'openai' : provider
			);

			// Montar body baseado no provedor
			const body = this.buildVisionRequestBody(imagePayload, provider);

			const resp = await fetch(this.opts.endpoint!, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.opts.apiKey}`,
					...(provider === 'claude' ? { 'anthropic-version': '2023-06-01' } : {})
				},
				body: JSON.stringify(body)
			});

			if (!resp.ok) {
				const errorText = await resp.text();
				throw new Error(`HTTP ${resp.status}: ${errorText.slice(0, 200)}`);
			}

			return this.parseVisionResponse(await resp.text(), provider);
		} catch (err) {
			vscode.window.showWarningMessage(
				`Falha na chamada de IA (visão), tentando modo texto: ${(err as Error).message}`
			);
			// Fallback para modo texto
			return this.suggestWithText(svgCode);
		}
	}

	/**
	 * Monta o corpo da requisição baseado no provedor de IA
	 */
	private buildVisionRequestBody(
		imagePayload: object,
		provider: 'openai' | 'claude' | 'gemini' | 'unknown'
	): object {
		const prompt = buildVisionPrompt();

		switch (provider) {
			case 'openai':
				return {
					model: this.opts.model || 'gpt-4o',
					messages: [
						{
							role: 'user',
							content: [
								{ type: 'text', text: prompt },
								imagePayload
							]
						}
					],
					max_tokens: 500
				};

			case 'claude':
				return {
					model: this.opts.model || 'claude-3-5-sonnet-20241022',
					max_tokens: 500,
					messages: [
						{
							role: 'user',
							content: [
								imagePayload,
								{ type: 'text', text: prompt }
							]
						}
					]
				};

			case 'gemini':
				return {
					contents: [
						{
							parts: [
								imagePayload,
								{ text: prompt }
							]
						}
					],
					generationConfig: {
						maxOutputTokens: 500
					}
				};

			default:
				// Formato genérico OpenAI-like
				return {
					model: this.opts.model || 'auto',
					messages: [
						{
							role: 'user',
							content: [
								{ type: 'text', text: prompt },
								imagePayload
							]
						}
					]
				};
		}
	}

	/**
	 * Parse da resposta de texto tradicional
	 */
	private parseResponse(text: string): IAResponseSuggestion {
		const match = text.match(/\{[\s\S]*\}/);
		if (!match) throw new Error('No JSON found in response');
		const parsed = JSON.parse(match[0]);
		return {
			isDecorative: !!parsed.isDecorative,
			titleText: parsed.titleText || '',
			descText: parsed.descText || ''
		};
	}

	/**
	 * Parse da resposta de modelos de visão (estrutura varia por provedor)
	 */
	private parseVisionResponse(
		text: string,
		provider: 'openai' | 'claude' | 'gemini' | 'unknown'
	): IAResponseSuggestion {
		const data = JSON.parse(text);
		let content = '';

		switch (provider) {
			case 'openai':
				content = data.choices?.[0]?.message?.content || '';
				break;
			case 'claude':
				content = data.content?.[0]?.text || '';
				break;
			case 'gemini':
				content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
				break;
			default:
				// Tentar extrair de formatos comuns
				content = data.choices?.[0]?.message?.content 
					|| data.content?.[0]?.text 
					|| data.response 
					|| JSON.stringify(data);
		}

		return this.parseWCAGResponse(content);
	}

	/**
	 * Parse da resposta no novo formato WCAG 2.2
	 * Converte a estrutura WCAG para o formato IAResponseSuggestion usado internamente
	 */
	private parseWCAGResponse(text: string): IAResponseSuggestion {
		const match = text.match(/\{[\s\S]*\}/);
		if (!match) throw new Error('No JSON found in response');
		
		const parsed = JSON.parse(match[0]);
		
		// Verificar se é o novo formato WCAG
		if (parsed.conformidade && parsed.tipoImagem && parsed.recomendacao) {
			const isDecorative = parsed.tipoImagem.classificacao === 'Decorativa';
			return {
				isDecorative,
				titleText: parsed.recomendacao.altText || '',
				descText: parsed.recomendacao.descricaoLonga || '',
				// Campos adicionais do formato WCAG
				wcagAnalysis: {
					conformidade: parsed.conformidade,
					tipoImagem: parsed.tipoImagem,
					codigoSugerido: parsed.codigoSugerido
				}
			};
		}
		
		// Fallback para formato antigo (compatibilidade)
		return {
			isDecorative: !!parsed.isDecorative,
			titleText: parsed.titleText || '',
			descText: parsed.descText || ''
		};
	}

	private mockHeuristic(svgCode: string): IAResponseSuggestion {
		const lower = svgCode.toLowerCase();
		
		// Detectar elementos que indicam conteúdo informativo
		const hasText = /<text[\s>]/i.test(lower);
		const hasMultipleShapes = (lower.match(/<(rect|circle|ellipse|polygon|path|line)\b/g) || []).length >= 3;
		const looksLikeChart = hasMultipleShapes && /(axis|chart|bar|graph|data|legend)/i.test(lower);
		const looksLikeIcon = /viewbox\s*=\s*["']?\s*0\s+0\s+(24|16|20|32|48)\s+(24|16|20|32|48)/i.test(svgCode);
		const hasComplexPath = /<path[^>]+d\s*=\s*["'][^"']{100,}/i.test(svgCode);
		const looksLikeLogo = hasText || (hasComplexPath && looksLikeIcon);
		
		// Detectar padrões comuns de ícones
		const iconPatterns = [
			/stroke-width|stroke-linecap|stroke-linejoin/i, // Ícones de linha
			/fill="(none|currentColor)"/i, // Ícones com cores dinâmicas
			/<circle[^>]+r\s*=\s*["']?\d/i, // Círculos (botões, notificações)
			/<line[^>]+/i, // Linhas (menus, fechamento)
		];
		const looksLikeActionIcon = iconPatterns.some(p => p.test(svgCode));
		
		// SVGs pequenos (até 48x48) com paths são geralmente ícones informativos
		const isSmallIcon = looksLikeIcon && (hasComplexPath || looksLikeActionIcon);
		
		// Determinar se é decorativo
		// Apenas formas muito simples sem propósito aparente são decorativas
		const isSimpleDecorativeShape = !hasText && !looksLikeChart && !isSmallIcon && !looksLikeLogo 
			&& (lower.match(/<(rect|circle|ellipse)\b/g) || []).length <= 1
			&& !hasComplexPath;
		
		if (isSimpleDecorativeShape) {
			return { isDecorative: true, titleText: '', descText: '' };
		}
		
		// Gerar título baseado no tipo detectado
		let title = 'Elemento gráfico';
		let desc = '';
		
		if (looksLikeChart) {
			title = 'Gráfico de dados';
			desc = 'Gráfico ou diagrama com múltiplos elementos visuais representando dados.';
		} else if (looksLikeLogo && hasText) {
			title = 'Logotipo';
			desc = '';
		} else if (isSmallIcon || looksLikeActionIcon) {
			// Tentar identificar o tipo de ícone pelo conteúdo
			if (/<line[^>]+x1.*<line/is.test(svgCode)) {
				title = 'Ícone de menu';
			} else if (/circle.*r\s*=\s*["']?[89]|r\s*=\s*["']?1[0-2]/i.test(svgCode)) {
				title = 'Ícone circular';
			} else if (/<path[^>]+d\s*=\s*["']M\s*\d+\s+\d+\s*[lL]/i.test(svgCode)) {
				title = 'Ícone de ação';
			} else {
				title = 'Ícone';
			}
		} else if (hasMultipleShapes) {
			title = 'Ilustração';
			desc = 'Imagem vetorial com múltiplos elementos gráficos.';
		}
		
		return { isDecorative: false, titleText: title, descText: desc };
	}
}

export function createIAClient(): IAClient {
	const config = vscode.workspace.getConfiguration('svgA11yAssist');
	const apiKey = config.get<string>('apiKey') || process.env.SVG_A11Y_API_KEY || '';
	const endpoint = config.get<string>('endpoint') || '';
	const model = config.get<string>('model') || '';
	const useVision = config.get<boolean>('useVision') ?? false;
	return new IAClient({ apiKey, endpoint, model, useVision });
}
