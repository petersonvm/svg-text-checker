import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
	 * Analisa uma tag <img> e sugere texto alt apropriado
	 * Usa visão de IA para URLs externas E arquivos locais, heurística como fallback
	 * @param imgSrc - O atributo src da imagem
	 * @param imgTag - A tag HTML completa da imagem
	 * @param documentUri - URI do documento para resolver caminhos relativos
	 */
	async suggestForImg(imgSrc: string, imgTag: string, documentUri?: vscode.Uri): Promise<IAResponseSuggestion> {
		// Se não tem endpoint/key, usar heurística baseada no nome do arquivo
		if (!this.opts.endpoint || !this.opts.apiKey) {
			console.log('[A11Y] Sem endpoint/apiKey, usando heurística');
			return this.mockImgHeuristic(imgSrc, imgTag);
		}

		// Ler configuração de visão dinamicamente (pode ter mudado desde a criação do cliente)
		const config = vscode.workspace.getConfiguration('svgA11yAssist');
		const useVision = config.get<boolean>('useVision') ?? this.opts.useVision;
		
		console.log(`[A11Y] suggestForImg - useVision: ${useVision}, imgSrc: ${imgSrc}, hasDocUri: ${!!documentUri}`);

		// Verificar se é URL externa (http/https) ou caminho local
		const isExternalUrl = imgSrc.startsWith('http://') || imgSrc.startsWith('https://') || imgSrc.startsWith('data:');

		// Se modo visão está habilitado
		if (useVision) {
			if (isExternalUrl) {
				console.log('[A11Y] Usando visão para URL externa');
				// URL externa: enviar diretamente para IA
				return this.suggestImgWithVision(imgSrc, imgTag);
			} else if (documentUri) {
				console.log('[A11Y] Usando visão para arquivo local');
				// Arquivo local: ler e enviar como base64
				return this.suggestLocalImgWithVision(imgSrc, imgTag, documentUri);
			} else {
				console.log('[A11Y] useVision ativo mas sem documentUri, caindo para texto');
			}
		}

		console.log('[A11Y] Usando análise de texto');
		// Fallback: análise via texto com LLM
		return this.suggestImgWithText(imgSrc, imgTag);
	}

	/**
	 * Análise de imagem via prompt de texto (envia nome do arquivo/URL para o LLM)
	 */
	private async suggestImgWithText(imgSrc: string, imgTag: string): Promise<IAResponseSuggestion> {
		try {
			const provider = detectAIProvider(this.opts.endpoint!);
			const prompt = this.buildImgTextPrompt(imgSrc, imgTag);
			
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
					body = {
						model: this.opts.model || 'auto',
						messages: [
							{ role: 'user', content: prompt }
						]
					};
			}

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
				`Falha na análise de imagem com IA, usando heurística: ${(err as Error).message}`
			);
			return this.mockImgHeuristic(imgSrc, imgTag);
		}
	}

	/**
	 * Análise de imagem local via visão (lê o arquivo e envia como base64)
	 */
	private async suggestLocalImgWithVision(imgSrc: string, imgTag: string, documentUri: vscode.Uri): Promise<IAResponseSuggestion> {
		try {
			// Resolver o caminho da imagem relativo ao documento
			const documentDir = path.dirname(documentUri.fsPath);
			const imagePath = path.resolve(documentDir, imgSrc);
			
			console.log(`[A11Y] suggestLocalImgWithVision - documentDir: ${documentDir}`);
			console.log(`[A11Y] suggestLocalImgWithVision - imagePath: ${imagePath}`);

			// Verificar se o arquivo existe
			if (!fs.existsSync(imagePath)) {
				console.log(`[A11Y] Arquivo não encontrado: ${imagePath}`);
				vscode.window.showWarningMessage(`Arquivo de imagem não encontrado: ${imagePath}`);
				return this.mockImgHeuristic(imgSrc, imgTag);
			}

			console.log(`[A11Y] Arquivo encontrado, lendo...`);
			
			// Ler o arquivo e converter para base64
			const imageBuffer = fs.readFileSync(imagePath);
			const base64Image = imageBuffer.toString('base64');
			
			console.log(`[A11Y] Imagem lida, tamanho base64: ${base64Image.length} caracteres`);

			// Detectar o tipo MIME baseado na extensão
			const ext = path.extname(imagePath).toLowerCase();
			const mimeType = this.getMimeType(ext);

			// Detectar provedor de IA
			const provider = detectAIProvider(this.opts.endpoint!);
			
			console.log(`[A11Y] Provider: ${provider}, MimeType: ${mimeType}`);

			// Criar payload de imagem com base64
			const imagePayload = this.buildImgBase64Payload(base64Image, mimeType, provider);

			// Prompt para análise
			const prompt = this.buildImgVisionPrompt();

			// Montar body da requisição
			const body = this.buildImgVisionRequestBody(imagePayload, prompt, provider);
			
			console.log(`[A11Y] Enviando requisição para: ${this.opts.endpoint}`);

			let headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.opts.apiKey}`
			};

			if (provider === 'claude') {
				headers['anthropic-version'] = '2023-06-01';
				headers['x-api-key'] = this.opts.apiKey!;
				delete headers['Authorization'];
			}

			const resp = await fetch(this.opts.endpoint!, {
				method: 'POST',
				headers,
				body: JSON.stringify(body)
			});

			console.log(`[A11Y] Resposta HTTP: ${resp.status}`);

			if (!resp.ok) {
				const errorText = await resp.text();
				console.log(`[A11Y] Erro na resposta: ${errorText.slice(0, 500)}`);
				throw new Error(`HTTP ${resp.status}: ${errorText.slice(0, 200)}`);
			}

			const responseText = await resp.text();
			console.log(`[A11Y] Resposta da LLM: ${responseText.slice(0, 500)}`);

			return this.parseVisionResponse(responseText, provider);
		} catch (err) {
			console.log(`[A11Y] Erro: ${(err as Error).message}`);
			vscode.window.showWarningMessage(
				`Falha na análise de imagem local, usando heurística: ${(err as Error).message}`
			);
			return this.mockImgHeuristic(imgSrc, imgTag);
		}
	}

	/**
	 * Retorna o tipo MIME baseado na extensão do arquivo
	 */
	private getMimeType(ext: string): string {
		const mimeTypes: Record<string, string> = {
			'.jpg': 'image/jpeg',
			'.jpeg': 'image/jpeg',
			'.png': 'image/png',
			'.gif': 'image/gif',
			'.webp': 'image/webp',
			'.svg': 'image/svg+xml',
			'.bmp': 'image/bmp',
			'.ico': 'image/x-icon'
		};
		return mimeTypes[ext] || 'image/jpeg';
	}

	/**
	 * Cria payload de imagem base64 para modelos de visão
	 */
	private buildImgBase64Payload(
		base64: string,
		mimeType: string,
		provider: 'openai' | 'claude' | 'gemini' | 'unknown'
	): object {
		switch (provider) {
			case 'openai':
				return {
					type: 'image_url',
					image_url: { 
						url: `data:${mimeType};base64,${base64}`,
						detail: 'high'
					}
				};
			case 'claude':
				return {
					type: 'image',
					source: {
						type: 'base64',
						media_type: mimeType,
						data: base64
					}
				};
			case 'gemini':
				return {
					inlineData: {
						mimeType: mimeType,
						data: base64
					}
				};
			default:
				return {
					type: 'image_url',
					image_url: { 
						url: `data:${mimeType};base64,${base64}` 
					}
				};
		}
	}

	/**
	 * Prompt para análise de imagem via texto (sem visão)
	 */
	private buildImgTextPrompt(imgSrc: string, imgTag: string): string {
		// Extrair nome do arquivo
		const fileName = imgSrc.split('/').pop()?.split('?')[0] || imgSrc;
		
		return `Você é um Analista de Conformidade WCAG 2.2 Sênior especializado em acessibilidade web.

TAREFA:
Analise o caminho/URL desta imagem e a tag HTML para sugerir um texto alternativo (alt) apropriado.

INFORMAÇÕES DA IMAGEM:
- Caminho/URL: ${imgSrc}
- Nome do arquivo: ${fileName}
- Tag HTML completa: ${imgTag}

DETERMINE:
1. Se a imagem é DECORATIVA (não transmite informação)
2. Se é INFORMATIVA (transmite conteúdo importante)
3. Se é um ÍCONE funcional (indica ação)
4. Se é um LOGO (identidade visual)
5. Se é uma IMAGEM COMPLEXA (gráfico, diagrama)

RESPONDA APENAS COM JSON:
{
  "isDecorative": boolean,
  "titleText": "texto alt sugerido (vazio se decorativa)",
  "descText": "descrição longa se for imagem complexa"
}

REGRAS IMPORTANTES:
- Se o nome contém "icon", "spacer", "background", "decorative", "pattern" → provavelmente decorativa
- Se o nome contém "logo" → extraia o nome da marca e use "Logo [marca]"
- Se o nome contém "banner", "hero", "product" → descreva o propósito
- Se o nome é um hash/código (ex: "abc123def.jpg") → use "[Descrição da imagem]" como placeholder
- Texto alt deve ser conciso (max 125 caracteres)
- Não comece com "Imagem de" ou "Foto de"
- Seja específico e descreva o PROPÓSITO da imagem, não sua aparência`;
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
	 * Analisa uma imagem usando modelo de visão de IA
	 */
	private async suggestImgWithVision(imgSrc: string, imgTag: string): Promise<IAResponseSuggestion> {
		try {
			const provider = detectAIProvider(this.opts.endpoint!);
			
			// Criar o prompt específico para análise de imagem
			const imgPrompt = this.buildImgVisionPrompt();
			
			// Determinar se a imagem é URL externa ou caminho local
			let imageUrl = imgSrc;
			
			// Se for caminho relativo, não podemos analisar com visão
			if (!imgSrc.startsWith('http://') && !imgSrc.startsWith('https://') && !imgSrc.startsWith('data:')) {
				// Fallback para heurística
				return this.mockImgHeuristic(imgSrc, imgTag);
			}

			// Montar payload de imagem para URL
			const imagePayload = this.buildImgVisionPayload(imageUrl, provider);
			
			// Montar body da requisição
			const body = this.buildImgVisionRequestBody(imagePayload, imgPrompt, provider);

			let headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.opts.apiKey}`
			};

			if (provider === 'claude') {
				headers['anthropic-version'] = '2023-06-01';
				headers['x-api-key'] = this.opts.apiKey!;
				delete headers['Authorization'];
			}

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
				`Falha na análise de imagem com IA, usando heurística: ${(err as Error).message}`
			);
			return this.mockImgHeuristic(imgSrc, imgTag);
		}
	}

	/**
	 * Prompt específico para análise de imagens
	 */
	private buildImgVisionPrompt(): string {
		return `Você é um Analista de Conformidade WCAG 2.2 Sênior. Analise esta imagem e forneça um texto alternativo (alt) apropriado.

TAREFA:
Determine se a imagem é:
1. DECORATIVA: Não transmite informação, apenas estética
2. INFORMATIVA: Transmite informação importante
3. FUNCIONAL: É parte de um link ou botão
4. COMPLEXA: Gráfico, diagrama ou infográfico que precisa de descrição longa

RESPONDA APENAS COM JSON:
{
  "isDecorative": boolean,
  "titleText": "texto alt sugerido (vazio se decorativa)",
  "descText": "descrição longa se for imagem complexa"
}

REGRAS:
- Se decorativa: isDecorative=true, titleText=""
- Se informativa: texto alt conciso e descritivo (max 125 caracteres)
- Se complexa: titleText com resumo + descText com detalhes
- Não comece com "Imagem de" ou "Foto de"
- Seja específico e descritivo`;
	}

	/**
	 * Cria payload de imagem para modelos de visão
	 */
	private buildImgVisionPayload(
		imageUrl: string,
		provider: 'openai' | 'claude' | 'gemini' | 'unknown'
	): object {
		switch (provider) {
			case 'openai':
				return {
					type: 'image_url',
					image_url: { url: imageUrl }
				};
			case 'claude':
				return {
					type: 'image',
					source: {
						type: 'url',
						url: imageUrl
					}
				};
			case 'gemini':
				return {
					inline_data: {
						mime_type: 'image/jpeg',
						data: imageUrl
					}
				};
			default:
				return {
					type: 'image_url',
					image_url: { url: imageUrl }
				};
		}
	}

	/**
	 * Monta body para requisição de visão de imagem
	 */
	private buildImgVisionRequestBody(
		imagePayload: object,
		prompt: string,
		provider: 'openai' | 'claude' | 'gemini' | 'unknown'
	): object {
		switch (provider) {
			case 'openai':
				return {
					model: this.opts.model || 'gpt-4o',
					messages: [{
						role: 'user',
						content: [
							{ type: 'text', text: prompt },
							imagePayload
						]
					}],
					max_tokens: 500
				};

			case 'claude':
				return {
					model: this.opts.model || 'claude-3-5-sonnet-20241022',
					max_tokens: 500,
					messages: [{
						role: 'user',
						content: [
							imagePayload,
							{ type: 'text', text: prompt }
						]
					}]
				};

			case 'gemini':
				return {
					contents: [{
						parts: [
							imagePayload,
							{ text: prompt }
						]
					}],
					generationConfig: { maxOutputTokens: 500 }
				};

			default:
				return {
					model: this.opts.model || 'auto',
					messages: [{
						role: 'user',
						content: [
							{ type: 'text', text: prompt },
							imagePayload
						]
					}]
				};
		}
	}

	/**
	 * Heurística para sugerir alt baseado no nome do arquivo e contexto
	 */
	private mockImgHeuristic(imgSrc: string, imgTag: string): IAResponseSuggestion {
		const lower = imgTag.toLowerCase();
		const srcLower = imgSrc.toLowerCase();
		
		// Extrair nome do arquivo
		const fileName = imgSrc.split('/').pop()?.split('?')[0] || '';
		const fileNameNoExt = fileName.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
		
		// =====================================================
		// FASE 1: Detectar imagens decorativas
		// =====================================================
		
		// Padrões comuns de imagens decorativas
		const decorativePatterns = [
			/decorativ[eo]/i,
			/spacer/i,
			/blank/i,
			/pixel/i,
			/transparent/i,
			/bg[-_]?image/i,
			/background/i,
			/divider/i,
			/separator/i,
			/border/i,
			/shadow/i,
			/gradient/i,
			/pattern/i,
			/texture/i,
			/1x1/i,
			/placeholder/i
		];
		
		for (const pattern of decorativePatterns) {
			if (pattern.test(srcLower) || pattern.test(lower)) {
				return { isDecorative: true, titleText: '', descText: '' };
			}
		}

		// =====================================================
		// FASE 2: Detectar ícones
		// =====================================================
		
		const iconPatterns: Array<{ pattern: RegExp; title: string }> = [
			{ pattern: /icon[-_]?search|search[-_]?icon|lupa|magnif/i, title: 'Pesquisar' },
			{ pattern: /icon[-_]?menu|menu[-_]?icon|hamburger/i, title: 'Menu' },
			{ pattern: /icon[-_]?close|close[-_]?icon|x[-_]?icon/i, title: 'Fechar' },
			{ pattern: /icon[-_]?home|home[-_]?icon|casa/i, title: 'Página inicial' },
			{ pattern: /icon[-_]?user|user[-_]?icon|avatar|profile/i, title: 'Perfil do usuário' },
			{ pattern: /icon[-_]?cart|cart[-_]?icon|carrinho|shopping/i, title: 'Carrinho de compras' },
			{ pattern: /icon[-_]?heart|heart[-_]?icon|favorit/i, title: 'Favoritos' },
			{ pattern: /icon[-_]?star|star[-_]?icon|estrela/i, title: 'Avaliação' },
			{ pattern: /icon[-_]?settings|settings[-_]?icon|config|gear|engrenagem/i, title: 'Configurações' },
			{ pattern: /icon[-_]?bell|bell[-_]?icon|notif|sino/i, title: 'Notificações' },
			{ pattern: /icon[-_]?mail|mail[-_]?icon|email|envelope/i, title: 'Email' },
			{ pattern: /icon[-_]?phone|phone[-_]?icon|telefone|call/i, title: 'Telefone' },
			{ pattern: /icon[-_]?download/i, title: 'Baixar' },
			{ pattern: /icon[-_]?upload/i, title: 'Enviar arquivo' },
			{ pattern: /icon[-_]?edit|edit[-_]?icon|pencil|lápis/i, title: 'Editar' },
			{ pattern: /icon[-_]?delete|delete[-_]?icon|trash|lixo/i, title: 'Excluir' },
			{ pattern: /icon[-_]?add|add[-_]?icon|plus|\+/i, title: 'Adicionar' },
			{ pattern: /icon[-_]?check|check[-_]?icon|tick/i, title: 'Confirmar' },
			{ pattern: /icon[-_]?arrow[-_]?left|prev|anterior/i, title: 'Anterior' },
			{ pattern: /icon[-_]?arrow[-_]?right|next|próximo/i, title: 'Próximo' },
			{ pattern: /icon[-_]?play/i, title: 'Reproduzir' },
			{ pattern: /icon[-_]?pause/i, title: 'Pausar' },
			{ pattern: /icon[-_]?share|compartilhar/i, title: 'Compartilhar' },
			{ pattern: /icon[-_]?link/i, title: 'Copiar link' },
			{ pattern: /icon[-_]?copy|copiar/i, title: 'Copiar' },
			{ pattern: /icon[-_]?save|salvar/i, title: 'Salvar' },
			{ pattern: /icon[-_]?print|imprimir/i, title: 'Imprimir' },
			{ pattern: /icon[-_]?location|pin|mapa/i, title: 'Localização' },
			{ pattern: /icon[-_]?calendar|calendário/i, title: 'Calendário' },
			{ pattern: /icon[-_]?clock|relógio|hora/i, title: 'Horário' },
			{ pattern: /icon[-_]?lock|cadeado|seguro/i, title: 'Segurança' },
			{ pattern: /icon[-_]?eye|visualizar|olho/i, title: 'Visualizar' },
			{ pattern: /icon[-_]?info|informação/i, title: 'Informações' },
			{ pattern: /icon[-_]?help|ajuda/i, title: 'Ajuda' },
			{ pattern: /icon[-_]?chat|message|mensagem/i, title: 'Mensagens' },
			{ pattern: /icon[-_]?logout|sair/i, title: 'Sair' },
			{ pattern: /icon[-_]?login|entrar/i, title: 'Entrar' }
		];

		for (const { pattern, title } of iconPatterns) {
			if (pattern.test(srcLower) || pattern.test(lower)) {
				return { isDecorative: false, titleText: title, descText: '' };
			}
		}

		// =====================================================
		// FASE 3: Detectar logos e marcas
		// =====================================================
		
		const logoPatterns = [
			/logo[-_]?/i,
			/brand[-_]?/i,
			/marca[-_]?/i,
			/[-_]logo\./i,
			/[-_]brand\./i
		];
		
		for (const pattern of logoPatterns) {
			if (pattern.test(srcLower)) {
				// Extrair nome da marca do arquivo
				const brandMatch = srcLower.match(/logo[-_]?([a-z0-9]+)/i) || 
				                   srcLower.match(/([a-z0-9]+)[-_]?logo/i);
				const brandName = brandMatch ? brandMatch[1].charAt(0).toUpperCase() + brandMatch[1].slice(1) : '';
				return { 
					isDecorative: false, 
					titleText: brandName ? `Logo ${brandName}` : 'Logo da empresa',
					descText: '' 
				};
			}
		}

		// =====================================================
		// FASE 4: Detectar tipos de imagem pelo nome
		// =====================================================
		
		const contentPatterns: Array<{ pattern: RegExp; prefix: string }> = [
			{ pattern: /banner[-_]?/i, prefix: 'Banner promocional' },
			{ pattern: /hero[-_]?/i, prefix: 'Imagem principal' },
			{ pattern: /product[-_]?|produto[-_]?/i, prefix: 'Produto' },
			{ pattern: /team[-_]?|equipe[-_]?/i, prefix: 'Membro da equipe' },
			{ pattern: /testimonial[-_]?|depoimento[-_]?/i, prefix: 'Depoimento de cliente' },
			{ pattern: /gallery[-_]?|galeria[-_]?/i, prefix: 'Imagem da galeria' },
			{ pattern: /slide[-_]?|carousel[-_]?/i, prefix: 'Slide' },
			{ pattern: /thumbnail[-_]?|thumb[-_]?/i, prefix: 'Miniatura' },
			{ pattern: /avatar[-_]?/i, prefix: 'Foto de perfil' },
			{ pattern: /photo[-_]?|foto[-_]?/i, prefix: 'Fotografia' },
			{ pattern: /chart[-_]?|graph[-_]?|gráfico[-_]?/i, prefix: 'Gráfico' },
			{ pattern: /diagram[-_]?|diagrama[-_]?/i, prefix: 'Diagrama' },
			{ pattern: /map[-_]?|mapa[-_]?/i, prefix: 'Mapa' },
			{ pattern: /infographic[-_]?|infográfico[-_]?/i, prefix: 'Infográfico' }
		];

		for (const { pattern, prefix } of contentPatterns) {
			if (pattern.test(srcLower)) {
				const desc = fileNameNoExt.replace(pattern, '').trim();
				return { 
					isDecorative: false, 
					titleText: desc ? `${prefix}: ${desc}` : prefix,
					descText: '' 
				};
			}
		}

		// =====================================================
		// FASE 5: Fallback - usar nome do arquivo
		// =====================================================
		
		if (fileNameNoExt && fileNameNoExt.length > 2) {
			// Limpar e formatar o nome do arquivo
			const cleanName = fileNameNoExt
				.replace(/[0-9]+/g, ' ')  // remover números
				.replace(/\s+/g, ' ')     // normalizar espaços
				.trim();
			
			if (cleanName.length > 2) {
				return { 
					isDecorative: false, 
					titleText: cleanName.charAt(0).toUpperCase() + cleanName.slice(1),
					descText: '' 
				};
			}
		}

		// Não foi possível determinar - retornar placeholder para revisão manual
		return { 
			isDecorative: false, 
			titleText: '[Descrição da imagem]',
			descText: '' 
		};
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
		const textCount = (svgCode.match(/<text\b/gi) || []).length;

		// =====================================================
		// FASE 3A: Gráficos e diagramas (PRIORIDADE sobre ícones)
		// =====================================================
		
		// 📊 Gráfico de barras: múltiplos rects (barras) + linhas (eixos)
		if (rectCount >= 3 && lineCount >= 1) {
			return { title: 'Gráfico de barras', desc: 'Gráfico de barras comparando valores de diferentes categorias.' };
		}

		// 📊 Gráfico de barras alternativo: múltiplos rects sem linhas
		if (rectCount >= 4 && lineCount === 0 && pathCount === 0) {
			return { title: 'Gráfico de barras', desc: 'Gráfico de barras comparando valores.' };
		}

		// 📈 Gráfico de pizza: múltiplos paths com arcos (A comando em SVG)
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

		// 📋 Diagrama de fluxo: rects + linhas + texto
		if (rectCount >= 2 && lineCount >= 1 && textCount >= 1) {
			return { title: 'Diagrama de fluxo', desc: 'Diagrama mostrando etapas de um processo.' };
		}

		// =====================================================
		// FASE 3B: Ícones simples (apenas se não for gráfico)
		// =====================================================
		
		// 🔍 Lupa/Busca: 1 círculo + 1 linha (cabo) - SEM rects
		if (circleCount === 1 && lineCount === 1 && pathCount === 0 && rectCount === 0) {
			return { title: 'Pesquisar', desc: '' };
		}

		// ☰ Menu hamburger: exatamente 3 linhas horizontais - SEM rects
		if (lineCount === 3 && pathCount === 0 && circleCount === 0 && rectCount === 0) {
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

		// ✕ Fechar: exatamente 2 linhas cruzando em X - SEM rects
		if (lineCount === 2 && pathCount === 0 && circleCount === 0 && rectCount === 0) {
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

		return null;
	}
}

/**
 * Carrega configurações de um arquivo .env na raiz do workspace
 */
function loadEnvConfig(): Record<string, string> {
	const envVars: Record<string, string> = {};
	
	try {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		console.log(`[A11Y] loadEnvConfig - workspaceFolders: ${workspaceFolders?.length || 0}`);
		
		if (!workspaceFolders || workspaceFolders.length === 0) {
			console.log('[A11Y] Nenhum workspace folder encontrado');
			return envVars;
		}
		
		const workspaceRoot = workspaceFolders[0].uri.fsPath;
		console.log(`[A11Y] workspaceRoot: ${workspaceRoot}`);
		
		const envPath = path.join(workspaceRoot, '.env');
		console.log(`[A11Y] Procurando .env em: ${envPath}`);
		console.log(`[A11Y] Arquivo existe: ${fs.existsSync(envPath)}`);
		
		if (fs.existsSync(envPath)) {
			const envContent = fs.readFileSync(envPath, 'utf-8');
			console.log(`[A11Y] Conteúdo do .env (primeiros 200 chars): ${envContent.slice(0, 200)}`);
			const lines = envContent.split('\n');
			
			for (const line of lines) {
				const trimmed = line.trim();
				// Ignorar comentários e linhas vazias
				if (!trimmed || trimmed.startsWith('#')) continue;
				
				const eqIndex = trimmed.indexOf('=');
				if (eqIndex > 0) {
					const key = trimmed.substring(0, eqIndex).trim();
					let value = trimmed.substring(eqIndex + 1).trim();
					// Remover aspas se presentes
					if ((value.startsWith('"') && value.endsWith('"')) || 
					    (value.startsWith("'") && value.endsWith("'"))) {
						value = value.slice(1, -1);
					}
					envVars[key] = value;
					console.log(`[A11Y] Variável carregada: ${key} = ${key.includes('KEY') ? '***' : value}`);
				}
			}
			console.log(`[A11Y] Total de variáveis carregadas: ${Object.keys(envVars).length}`);
		} else {
			console.log(`[A11Y] Arquivo .env NÃO encontrado em: ${envPath}`);
		}
	} catch (err) {
		console.log(`[A11Y] Erro ao carregar .env: ${(err as Error).message}`);
	}
	
	return envVars;
}

export function createIAClient(): IAClient {
	// Carregar variáveis do arquivo .env
	const envConfig = loadEnvConfig();
	
	// Ler configurações do VS Code
	const config = vscode.workspace.getConfiguration('svgA11yAssist');
	
	// Prioridade: VS Code settings > .env > variáveis de ambiente do sistema
	const apiKey = config.get<string>('apiKey') 
		|| envConfig['SVG_A11Y_API_KEY'] 
		|| envConfig['OPENAI_API_KEY']
		|| envConfig['ANTHROPIC_API_KEY']
		|| envConfig['GOOGLE_API_KEY']
		|| process.env.SVG_A11Y_API_KEY 
		|| '';
		
	const endpoint = config.get<string>('endpoint') 
		|| envConfig['SVG_A11Y_ENDPOINT']
		|| envConfig['OPENAI_ENDPOINT']
		|| '';
		
	const model = config.get<string>('model') 
		|| envConfig['SVG_A11Y_MODEL']
		|| '';
		
	// Prioridade: VS Code settings > .env > false
	const vscodeUseVision = config.get<boolean>('useVision');
	const envUseVision = envConfig['SVG_A11Y_USE_VISION'] === 'true';
	const useVision = vscodeUseVision !== undefined ? vscodeUseVision : envUseVision;
	
	console.log(`[A11Y] createIAClient - apiKey presente: ${!!apiKey && apiKey.length > 0}`);
	console.log(`[A11Y] createIAClient - endpoint: ${endpoint}`);
	console.log(`[A11Y] createIAClient - useVision: ${useVision}`);
	
	return new IAClient({ apiKey, endpoint, model, useVision });
}
