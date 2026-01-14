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
			/stroke-width|stroke-linecap|stroke-linejoin/i,
			/fill="(none|currentColor)"/i,
			/<circle[^>]+r\s*=\s*["']?\d/i,
			/<line[^>]+/i,
		];
		const looksLikeActionIcon = iconPatterns.some(p => p.test(svgCode));
		
		// SVGs pequenos (até 48x48) com paths são geralmente ícones informativos
		const isSmallIcon = looksLikeIcon && (hasComplexPath || looksLikeActionIcon);
		
		// Determinar se é decorativo
		const isSimpleDecorativeShape = !hasText && !looksLikeChart && !isSmallIcon && !looksLikeLogo 
			&& (lower.match(/<(rect|circle|ellipse)\b/g) || []).length <= 1
			&& !hasComplexPath;
		
		if (isSimpleDecorativeShape) {
			return { isDecorative: true, titleText: '', descText: '' };
		}
		
		// ========================================
		// Identificação específica de ícones comuns
		// ========================================
		const iconIdentification = this.identifySpecificIcon(svgCode, lower);
		if (iconIdentification) {
			return { isDecorative: false, titleText: iconIdentification.title, descText: iconIdentification.desc };
		}
		
		// Gerar título baseado no tipo detectado (fallback)
		let title = 'Elemento gráfico';
		let desc = '';
		
		if (looksLikeChart) {
			title = 'Gráfico de dados';
			desc = 'Gráfico ou diagrama com múltiplos elementos visuais representando dados.';
		} else if (looksLikeLogo && hasText) {
			// Extrair texto do logo se possível
			const textMatch = svgCode.match(/<text[^>]*>([^<]+)<\/text>/i);
			if (textMatch) {
				title = `Logotipo ${textMatch[1].trim()}`;
			} else {
				title = 'Logotipo da empresa';
			}
		} else if (hasMultipleShapes) {
			title = 'Ilustração';
			desc = 'Imagem vetorial com múltiplos elementos gráficos.';
		}
		
		return { isDecorative: false, titleText: title, descText: desc };
	}

	/**
	 * Identifica ícones específicos baseado em padrões visuais do SVG
	 * PRIORIDADE: Análise do path primeiro, depois estrutura, depois keywords
	 */
	private identifySpecificIcon(svgCode: string, lower: string): { title: string; desc: string } | null {
		// =====================================================
		// FASE 1: Análise do path d="" para formas específicas
		// =====================================================
		const pathMatch = svgCode.match(/d\s*=\s*["']([^"']+)["']/i);
		if (pathMatch) {
			const pathData = pathMatch[1];
			
			// ❤️ Coração - path que contém "21.35" ou coordenadas típicas de coração
			if (/21\.35/.test(pathData) || /8\.5.*5\.42/.test(pathData)) {
				return { title: 'Adicionar aos favoritos', desc: '' };
			}
			
			// ❤️ Coração alternativo - curvas bezier simétricas típicas de coração
			// Path começa em M12 (centro) e tem múltiplas curvas C
			if (/^M\s*12\s/.test(pathData) && /[Cc]/.test(pathData) && pathData.length > 100) {
				// Verificar se tem padrão de coração (ponto final em 21.35 ou similar)
				if (/21\.\d|l\s*-?\d+\.?\d*\s+-?\d+\.?\d*\s*[Cc]/i.test(pathData)) {
					return { title: 'Adicionar aos favoritos', desc: '' };
				}
			}
		}

		// =====================================================
		// FASE 2: Análise de cor fill para identificar tipo
		// =====================================================
		const fillMatch = svgCode.match(/fill\s*=\s*["']([^"']+)["']/i);
		if (fillMatch) {
			const fillColor = fillMatch[1].toLowerCase();
			// Rosa/vermelho (#e91e63, #f44336, #e53935, etc.) = coração/favorito
			if (/^#[ef][0-9][0-5a-f][0-9a-f]{3}$/i.test(fillColor) || 
			    /^#[ef][0-9a-f]{5}$/i.test(fillColor) && /e9|e5|f4|ff|d3|c6/.test(fillColor)) {
				// Verificar se é ícone pequeno (24x24 tipicamente)
				if (/viewBox\s*=\s*["']0\s+0\s+24\s+24["']/i.test(svgCode)) {
					// Verificar se tem path complexo (coração)
					if (pathMatch && pathMatch[1].length > 50) {
						return { title: 'Adicionar aos favoritos', desc: '' };
					}
				}
			}
		}

		// =====================================================
		// FASE 3: Análise estrutural de elementos
		// =====================================================
		
		// Contar elementos para determinar estrutura
		const lineCount = (svgCode.match(/<line\b/gi) || []).length;
		const circleCount = (svgCode.match(/<circle\b/gi) || []).length;
		const pathCount = (svgCode.match(/<path\b/gi) || []).length;
		const rectCount = (svgCode.match(/<rect\b/gi) || []).length;
		
		// 🔍 Lupa/Busca: 1 círculo + 1 linha (cabo)
		if (circleCount === 1 && lineCount === 1 && pathCount === 0) {
			// Verificar se a linha é diagonal (cabo da lupa)
			if (/<line[^>]+x1\s*=\s*["']?\d+["']?[^>]+x2\s*=\s*["']?\d+["']?/i.test(svgCode)) {
				return { title: 'Pesquisar', desc: '' };
			}
		}

		// ☰ Menu hamburger: exatamente 3 linhas horizontais
		if (lineCount === 3 && pathCount === 0 && circleCount === 0) {
			// Verificar se as linhas são horizontais (y1 == y2 para cada uma)
			const lines = svgCode.match(/<line[^>]+>/gi) || [];
			let horizontalLines = 0;
			for (const line of lines) {
				const y1Match = line.match(/y1\s*=\s*["']?(\d+)/);
				const y2Match = line.match(/y2\s*=\s*["']?(\d+)/);
				if (y1Match && y2Match && y1Match[1] === y2Match[1]) {
					horizontalLines++;
				}
			}
			if (horizontalLines === 3) {
				return { title: 'Abrir menu de navegação', desc: '' };
			}
		}

		// ✕ Fechar: exatamente 2 linhas cruzando em X
		if (lineCount === 2 && pathCount === 0 && circleCount === 0) {
			return { title: 'Fechar', desc: '' };
		}

		// 🔔 Sino/Notificação: path + círculo pequeno (badge)
		if (pathCount >= 1 && circleCount >= 1) {
			// Verificar se círculo é pequeno (badge de notificação)
			const smallCircle = /<circle[^>]+r\s*=\s*["']?[1-5]["']?/i.test(svgCode);
			if (smallCircle) {
				return { title: 'Ver notificações', desc: '' };
			}
		}

		// =====================================================
		// FASE 4: Keywords no SVG (classes, IDs, comentários)
		// =====================================================
		const keywordPatterns: Array<{ pattern: RegExp; title: string; desc?: string }> = [
			// Favoritos/Coração
			{ pattern: /heart|coração|favorit|❤|love/i, title: 'Adicionar aos favoritos' },
			// Busca
			{ pattern: /search|magnif|lupa|busca|pesquis/i, title: 'Pesquisar' },
			// Menu
			{ pattern: /menu|hamburger|nav/i, title: 'Abrir menu de navegação' },
			// Fechar
			{ pattern: /close|fechar|dismiss|×/i, title: 'Fechar' },
			// Notificações
			{ pattern: /bell|sino|notif|alert/i, title: 'Ver notificações' },
			// Download
			{ pattern: /download|baixar/i, title: 'Baixar arquivo' },
			// Upload
			{ pattern: /upload|enviar.*arquivo/i, title: 'Enviar arquivo' },
			// Editar
			{ pattern: /edit|pencil|lápis|caneta|editar/i, title: 'Editar' },
			// Excluir
			{ pattern: /trash|delete|lixo|excluir|remover/i, title: 'Excluir' },
			// Configurações
			{ pattern: /settings|config|gear|engrenagem|cog/i, title: 'Abrir configurações' },
			// Usuário
			{ pattern: /user|profile|person|avatar|usuário|perfil/i, title: 'Perfil do usuário' },
			// Home
			{ pattern: /home|house|casa|início/i, title: 'Ir para página inicial' },
			// Adicionar
			{ pattern: /plus|add(?!ress)|adicionar/i, title: 'Adicionar novo item' },
			// Check
			{ pattern: /check|confirm|tick|verificar|confirmar/i, title: 'Confirmar' },
			// Email
			{ pattern: /mail|email|envelope|carta/i, title: 'Enviar email' },
			// Telefone
			{ pattern: /phone|telefone|call|ligar/i, title: 'Ligar' },
			// Localização
			{ pattern: /location|pin|map(?!le)|local(?!host)|mapa/i, title: 'Ver localização' },
			// Link
			{ pattern: /(?<!un)link|chain|corrente/i, title: 'Copiar link' },
			// Compartilhar
			{ pattern: /share|compartilhar/i, title: 'Compartilhar' },
			// Play
			{ pattern: /\bplay\b|reproduzir|iniciar/i, title: 'Reproduzir' },
			// Pause
			{ pattern: /pause|pausar/i, title: 'Pausar' },
			// Volume
			{ pattern: /volume|sound|som(?!e)|audio/i, title: 'Ajustar volume' },
			// Pasta
			{ pattern: /folder|pasta|diretório/i, title: 'Abrir pasta' },
			// Documento
			{ pattern: /\bfile\b|document|arquivo|documento/i, title: 'Ver documento' },
			// Segurança
			{ pattern: /lock|secure|cadeado|seguro/i, title: 'Segurança' },
			// Visualizar
			{ pattern: /\beye\b|view(?!box)|olho|visualizar/i, title: 'Visualizar' },
			// Salvar
			{ pattern: /save|salvar|disk|disco/i, title: 'Salvar' },
			// Copiar
			{ pattern: /\bcopy\b|copiar|clipboard/i, title: 'Copiar' },
			// Estrela
			{ pattern: /\bstar\b|estrela|destaque/i, title: 'Marcar como favorito' },
			// Atualizar
			{ pattern: /refresh|reload|atualizar|sync/i, title: 'Atualizar' },
			// Informação
			{ pattern: /\binfo\b|informação/i, title: 'Ver informações' },
			// Ajuda
			{ pattern: /\bhelp\b|ajuda/i, title: 'Obter ajuda' },
			// Calendário
			{ pattern: /calendar|calendário/i, title: 'Abrir calendário' },
			// Relógio
			{ pattern: /clock|relógio|hora/i, title: 'Ver horário' },
			// Chat
			{ pattern: /chat|message|mensagem|comment|comentário/i, title: 'Abrir conversa' },
			// Carrinho
			{ pattern: /cart|carrinho|shop|compras/i, title: 'Ver carrinho de compras' },
			// Logout
			{ pattern: /logout|signout|sair/i, title: 'Sair da conta' },
			// Login
			{ pattern: /login|signin|entrar/i, title: 'Fazer login' },
			// Setas
			{ pattern: /arrow.*left|chevron.*left|previous|anterior/i, title: 'Anterior' },
			{ pattern: /arrow.*right|chevron.*right|next|próximo/i, title: 'Próximo' },
			// Imprimir
			{ pattern: /print|imprimir/i, title: 'Imprimir' },
			// Anexar
			{ pattern: /attach|anexo/i, title: 'Anexar arquivo' },
			// Like
			{ pattern: /\blike\b|curtir|thumb.*up/i, title: 'Curtir' },
		];

		for (const { pattern, title, desc } of keywordPatterns) {
			if (pattern.test(svgCode)) {
				return { title, desc: desc || '' };
			}
		}

		// =====================================================
		// FASE 5: Gráficos e diagramas
		// =====================================================
		
		// Gráfico de pizza - múltiplos paths com arcos (A comando em SVG)
		if (pathCount >= 3) {
			const paths = svgCode.match(/d\s*=\s*["'][^"']+["']/gi) || [];
			let arcPaths = 0;
			for (const p of paths) {
				if (/\sA\s*\d/i.test(p)) arcPaths++;
			}
			if (arcPaths >= 2) {
				return { title: 'Gráfico de distribuição', desc: 'Gráfico circular mostrando proporções de diferentes categorias.' };
			}
		}

		// Gráfico de barras - múltiplos rects verticais
		if (rectCount >= 3 && lineCount <= 2) {
			return { title: 'Gráfico de barras', desc: 'Gráfico de barras comparando valores.' };
		}

		// Diagrama de fluxo - rects + linhas conectando
		if (rectCount >= 2 && lineCount >= 1 && /<text/i.test(svgCode)) {
			return { title: 'Diagrama de fluxo', desc: 'Diagrama mostrando etapas de um processo.' };
		}

		return null;
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
