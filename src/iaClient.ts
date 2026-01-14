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
	 */
	private identifySpecificIcon(svgCode: string, lower: string): { title: string; desc: string } | null {
		// Padrões de ícones comuns - ordem importa (mais específico primeiro)
		const iconPatterns: Array<{ pattern: RegExp; title: string; desc?: string }> = [
			// ❤️ Coração / Favoritos (path com curvas características de coração)
			{ 
				pattern: /d\s*=\s*["'][^"']*[Cc]\s*[\d.]+\s+[\d.]+[^"']*[Cc]\s*[\d.]+\s+[\d.]+[^"']*[Zz]?\s*["']/i,
				title: 'Adicionar aos favoritos',
				desc: ''
			},
			// ❤️ Coração alternativo (bezier curves típicas)
			{ 
				pattern: /21\.35|8\.5\s*2\s*5\.42|bezier|heart/i,
				title: 'Adicionar aos favoritos',
				desc: ''
			},
			// 🔔 Sino / Notificação
			{ 
				pattern: /<path[^>]*d\s*=\s*["']M\s*18\s+8[^"']*9[^"']*["']/i,
				title: 'Notificações',
				desc: ''
			},
			// 🔔 Sino alternativo
			{ 
				pattern: /bell|notif|alert.*circle/i,
				title: 'Ver notificações',
				desc: ''
			},
			// 🔍 Lupa / Busca (círculo + linha diagonal)
			{ 
				pattern: /<circle[^>]+cx\s*=\s*["']?1[01]["']?[^>]*>[\s\S]*<line[^>]+x1\s*=\s*["']?2[01]/i,
				title: 'Pesquisar',
				desc: ''
			},
			// 🔍 Busca alternativo
			{ 
				pattern: /search|magnif|lupa/i,
				title: 'Pesquisar',
				desc: ''
			},
			// ☰ Menu hamburger (3 linhas horizontais paralelas)
			{ 
				pattern: /<line[^>]+y1\s*=\s*["']?6["']?[^>]*>[\s\S]*<line[^>]+y1\s*=\s*["']?12["']?[\s\S]*<line[^>]+y1\s*=\s*["']?18["']?/i,
				title: 'Abrir menu de navegação',
				desc: ''
			},
			// ☰ Menu alternativo (3 rects horizontais)
			{ 
				pattern: /<line[^>]+x1\s*=\s*["']?3["']?[^>]+x2\s*=\s*["']?21["']?/i,
				title: 'Abrir menu de navegação',
				desc: ''
			},
			// ✕ Fechar (duas linhas cruzando em X)
			{ 
				pattern: /<line[^>]+x1\s*=\s*["']?18["']?[^>]+y1\s*=\s*["']?6["']?[^>]+x2\s*=\s*["']?6["']?[^>]+y2\s*=\s*["']?18["']?/i,
				title: 'Fechar',
				desc: ''
			},
			// ✕ Fechar alternativo
			{ 
				pattern: /close|dismiss|×|x.*x/i,
				title: 'Fechar',
				desc: ''
			},
			// ⬇️ Download / Seta para baixo
			{ 
				pattern: /download|arrow.*down|seta.*baixo/i,
				title: 'Baixar arquivo',
				desc: ''
			},
			// ⬆️ Upload / Seta para cima
			{ 
				pattern: /upload|arrow.*up|seta.*cima/i,
				title: 'Enviar arquivo',
				desc: ''
			},
			// ✏️ Editar / Lápis
			{ 
				pattern: /edit|pencil|lápis|caneta/i,
				title: 'Editar',
				desc: ''
			},
			// 🗑️ Lixeira / Excluir
			{ 
				pattern: /trash|delete|lixo|excluir|remove/i,
				title: 'Excluir',
				desc: ''
			},
			// ⚙️ Configurações / Engrenagem
			{ 
				pattern: /settings|config|gear|engrenagem|cog/i,
				title: 'Abrir configurações',
				desc: ''
			},
			// 👤 Usuário / Perfil
			{ 
				pattern: /user|profile|person|avatar|usuário/i,
				title: 'Perfil do usuário',
				desc: ''
			},
			// 🏠 Casa / Home
			{ 
				pattern: /home|house|casa|início/i,
				title: 'Ir para página inicial',
				desc: ''
			},
			// ➕ Adicionar / Plus
			{ 
				pattern: /\+|plus|add|adicionar/i,
				title: 'Adicionar novo item',
				desc: ''
			},
			// ✓ Check / Confirmar
			{ 
				pattern: /check|confirm|tick|verificar|confirmar/i,
				title: 'Confirmar',
				desc: ''
			},
			// 📧 Email / Envelope
			{ 
				pattern: /mail|email|envelope|carta/i,
				title: 'Enviar email',
				desc: ''
			},
			// 📞 Telefone
			{ 
				pattern: /phone|telefone|call|ligar/i,
				title: 'Ligar',
				desc: ''
			},
			// 📍 Localização / Pin
			{ 
				pattern: /location|pin|map|local|mapa/i,
				title: 'Ver localização',
				desc: ''
			},
			// 🔗 Link / Corrente
			{ 
				pattern: /link|chain|corrente/i,
				title: 'Copiar link',
				desc: ''
			},
			// 📤 Compartilhar
			{ 
				pattern: /share|compartilhar/i,
				title: 'Compartilhar',
				desc: ''
			},
			// ▶️ Play / Reproduzir
			{ 
				pattern: /play|reproduzir|iniciar/i,
				title: 'Reproduzir',
				desc: ''
			},
			// ⏸️ Pause / Pausar
			{ 
				pattern: /pause|pausar/i,
				title: 'Pausar',
				desc: ''
			},
			// 🔊 Volume / Som
			{ 
				pattern: /volume|sound|som|audio/i,
				title: 'Ajustar volume',
				desc: ''
			},
			// 📊 Gráfico de barras
			{ 
				pattern: /chart|graph|gráfico|estatística/i,
				title: 'Ver estatísticas',
				desc: ''
			},
			// 📁 Pasta / Folder
			{ 
				pattern: /folder|pasta|diretório/i,
				title: 'Abrir pasta',
				desc: ''
			},
			// 📄 Documento / Arquivo
			{ 
				pattern: /file|document|arquivo|documento/i,
				title: 'Ver documento',
				desc: ''
			},
			// 🖼️ Imagem
			{ 
				pattern: /image|picture|imagem|foto/i,
				title: 'Ver imagem',
				desc: ''
			},
			// 🎬 Vídeo
			{ 
				pattern: /video|vídeo|filme/i,
				title: 'Ver vídeo',
				desc: ''
			},
			// 🔒 Cadeado / Segurança
			{ 
				pattern: /lock|secure|cadeado|seguro/i,
				title: 'Segurança',
				desc: ''
			},
			// 👁️ Olho / Visualizar
			{ 
				pattern: /eye|view|olho|visualizar/i,
				title: 'Visualizar',
				desc: ''
			},
			// ↩️ Desfazer / Voltar
			{ 
				pattern: /undo|back|voltar|desfazer/i,
				title: 'Voltar',
				desc: ''
			},
			// ↪️ Refazer / Avançar
			{ 
				pattern: /redo|forward|avançar|refazer/i,
				title: 'Avançar',
				desc: ''
			},
			// 💾 Salvar
			{ 
				pattern: /save|salvar|disk|disco/i,
				title: 'Salvar',
				desc: ''
			},
			// 📋 Copiar
			{ 
				pattern: /copy|copiar|clipboard/i,
				title: 'Copiar',
				desc: ''
			},
			// 📥 Colar
			{ 
				pattern: /paste|colar/i,
				title: 'Colar',
				desc: ''
			},
			// ⭐ Estrela / Destaque
			{ 
				pattern: /star|estrela|destaque|favorito/i,
				title: 'Marcar como favorito',
				desc: ''
			},
			// 🔄 Atualizar / Refresh
			{ 
				pattern: /refresh|reload|atualizar|sync/i,
				title: 'Atualizar',
				desc: ''
			},
			// ℹ️ Informação
			{ 
				pattern: /info|information|informação/i,
				title: 'Ver informações',
				desc: ''
			},
			// ❓ Ajuda
			{ 
				pattern: /help|ajuda|\?/i,
				title: 'Obter ajuda',
				desc: ''
			},
			// ⚠️ Aviso / Alerta
			{ 
				pattern: /warning|alert|aviso|atenção/i,
				title: 'Aviso importante',
				desc: ''
			},
			// ❌ Erro
			{ 
				pattern: /error|erro|danger/i,
				title: 'Erro',
				desc: ''
			},
			// ✅ Sucesso
			{ 
				pattern: /success|sucesso|done|concluído/i,
				title: 'Sucesso',
				desc: ''
			},
			// 📅 Calendário
			{ 
				pattern: /calendar|calendário|data|date/i,
				title: 'Abrir calendário',
				desc: ''
			},
			// ⏰ Relógio / Tempo
			{ 
				pattern: /clock|time|relógio|hora/i,
				title: 'Ver horário',
				desc: ''
			},
			// 🏷️ Tag / Etiqueta
			{ 
				pattern: /tag|label|etiqueta/i,
				title: 'Adicionar etiqueta',
				desc: ''
			},
			// 💬 Chat / Mensagem
			{ 
				pattern: /chat|message|mensagem|comment|comentário/i,
				title: 'Abrir conversa',
				desc: ''
			},
			// 🛒 Carrinho de compras
			{ 
				pattern: /cart|carrinho|shop|compras/i,
				title: 'Ver carrinho de compras',
				desc: ''
			},
			// 💳 Pagamento / Cartão
			{ 
				pattern: /payment|credit|card|cartão|pagamento/i,
				title: 'Fazer pagamento',
				desc: ''
			},
			// 🔑 Chave / Login
			{ 
				pattern: /key|chave|login|senha/i,
				title: 'Fazer login',
				desc: ''
			},
			// 🚪 Sair / Logout
			{ 
				pattern: /logout|exit|sair/i,
				title: 'Sair da conta',
				desc: ''
			},
			// ⬅️ Seta esquerda
			{ 
				pattern: /arrow.*left|seta.*esquerda|chevron.*left|previous|anterior/i,
				title: 'Anterior',
				desc: ''
			},
			// ➡️ Seta direita
			{ 
				pattern: /arrow.*right|seta.*direita|chevron.*right|next|próximo/i,
				title: 'Próximo',
				desc: ''
			},
			// 📱 Mobile / Celular
			{ 
				pattern: /mobile|celular|smartphone/i,
				title: 'Ver versão mobile',
				desc: ''
			},
			// 💻 Desktop / Computador
			{ 
				pattern: /desktop|computer|computador/i,
				title: 'Ver versão desktop',
				desc: ''
			},
			// 🖨️ Imprimir
			{ 
				pattern: /print|imprimir/i,
				title: 'Imprimir',
				desc: ''
			},
			// 📎 Anexo / Clip
			{ 
				pattern: /attach|anexo|clip/i,
				title: 'Anexar arquivo',
				desc: ''
			},
			// 🎨 Cor / Paleta
			{ 
				pattern: /color|palette|cor|paleta/i,
				title: 'Escolher cor',
				desc: ''
			},
			// 📝 Nota / Anotação
			{ 
				pattern: /note|nota|anotação/i,
				title: 'Adicionar nota',
				desc: ''
			},
			// 🔧 Ferramentas
			{ 
				pattern: /tool|ferramenta|wrench/i,
				title: 'Ferramentas',
				desc: ''
			},
			// 📦 Pacote / Box
			{ 
				pattern: /package|box|pacote|caixa/i,
				title: 'Ver pacote',
				desc: ''
			},
			// 🌐 Mundo / Global
			{ 
				pattern: /globe|world|mundo|global|idioma|language/i,
				title: 'Alterar idioma',
				desc: ''
			},
			// 🌙 Modo escuro / Lua
			{ 
				pattern: /moon|dark.*mode|modo.*escuro|lua/i,
				title: 'Ativar modo escuro',
				desc: ''
			},
			// ☀️ Modo claro / Sol
			{ 
				pattern: /sun|light.*mode|modo.*claro|sol/i,
				title: 'Ativar modo claro',
				desc: ''
			},
			// 🎵 Música
			{ 
				pattern: /music|música|song/i,
				title: 'Reproduzir música',
				desc: ''
			},
			// 🎤 Microfone
			{ 
				pattern: /mic|microphone|microfone/i,
				title: 'Ativar microfone',
				desc: ''
			},
			// 📹 Câmera
			{ 
				pattern: /camera|câmera|webcam/i,
				title: 'Ativar câmera',
				desc: ''
			},
			// 📡 Wi-Fi / Conexão
			{ 
				pattern: /wifi|connection|conexão|network|rede/i,
				title: 'Ver conexão',
				desc: ''
			},
			// 🔋 Bateria
			{ 
				pattern: /battery|bateria/i,
				title: 'Ver bateria',
				desc: ''
			},
			// 🎁 Presente / Gift
			{ 
				pattern: /gift|presente/i,
				title: 'Ver presentes',
				desc: ''
			},
			// 🏆 Troféu / Conquista
			{ 
				pattern: /trophy|conquista|achievement/i,
				title: 'Ver conquistas',
				desc: ''
			},
			// 👍 Like / Curtir
			{ 
				pattern: /like|curtir|thumb.*up/i,
				title: 'Curtir',
				desc: ''
			},
			// 👎 Dislike / Não curtir
			{ 
				pattern: /dislike|thumb.*down/i,
				title: 'Não curtir',
				desc: ''
			},
			// 🔀 Embaralhar / Shuffle
			{ 
				pattern: /shuffle|embaralhar|random/i,
				title: 'Embaralhar',
				desc: ''
			},
			// 🔁 Repetir / Loop
			{ 
				pattern: /repeat|loop|repetir/i,
				title: 'Repetir',
				desc: ''
			},
			// ⏭️ Próxima faixa
			{ 
				pattern: /skip.*next|próxima.*faixa/i,
				title: 'Próxima faixa',
				desc: ''
			},
			// ⏮️ Faixa anterior
			{ 
				pattern: /skip.*prev|faixa.*anterior/i,
				title: 'Faixa anterior',
				desc: ''
			},
			// 📌 Fixar / Pin
			{ 
				pattern: /pin|fixar|thumbtack/i,
				title: 'Fixar item',
				desc: ''
			},
			// 🔖 Bookmark / Marcador
			{ 
				pattern: /bookmark|marcador/i,
				title: 'Adicionar marcador',
				desc: ''
			},
			// 📊 Pizza chart - detectar pelo padrão de arcos
			{
				pattern: /<path[^>]+d\s*=\s*["']M\s*\d+\s+\d+\s*L[^"']*A\s*\d+/i,
				title: 'Gráfico de distribuição',
				desc: 'Gráfico circular mostrando proporções de diferentes categorias.'
			},
			// 📈 Gráfico de barras - múltiplos rects verticais
			{
				pattern: /<rect[^>]+height\s*=\s*["']?\d{2,}["']?[^>]*>[\s\S]*<rect[^>]+height\s*=\s*["']?\d{2,}["']?/i,
				title: 'Gráfico de barras',
				desc: 'Gráfico de barras comparando valores de diferentes categorias.'
			},
			// Fluxograma - múltiplos rects com linhas conectando
			{
				pattern: /<rect[^>]+rx\s*=\s*["']?\d["']?[^>]*>[\s\S]*<line[^>]+>[\s\S]*<rect/i,
				title: 'Diagrama de fluxo',
				desc: 'Diagrama mostrando etapas de um processo.'
			},
		];

		// Verificar cada padrão
		for (const { pattern, title, desc } of iconPatterns) {
			if (pattern.test(svgCode) || pattern.test(lower)) {
				return { title, desc: desc || '' };
			}
		}

		// Se não encontrou padrão específico mas parece ser um ícone de ação
		// Tentar detectar pela estrutura do SVG
		
		// Ícone com fill de cor sólida específica (provavelmente um ícone colorido como coração)
		if (/<(path|circle|rect)[^>]+fill\s*=\s*["']#[ef][0-9a-f]{4,5}["']/i.test(svgCode)) {
			// Cores avermelhadas/rosadas geralmente indicam coração/favorito
			if (/fill\s*=\s*["']#[ef][0-9][0-5]/i.test(svgCode)) {
				return { title: 'Adicionar aos favoritos', desc: '' };
			}
		}

		// Ícone com path que tem curvas bezier complexas (típico de ícones de coração)
		if (/<path[^>]+d\s*=\s*["'][^"']*c\s*[\d.-]+\s*[\d.-]+[^"']*c\s*[\d.-]+\s*[\d.-]+[^"']*["']/i.test(svgCode)) {
			// Verificar se tem formato de coração (curvas simétricas)
			const pathMatch = svgCode.match(/d\s*=\s*["']([^"']+)["']/i);
			if (pathMatch && pathMatch[1].toLowerCase().includes('c') && /21\.35|8\.5/.test(pathMatch[1])) {
				return { title: 'Adicionar aos favoritos', desc: '' };
			}
		}

		return null; // Não identificou um ícone específico
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
