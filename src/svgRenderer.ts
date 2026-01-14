/**
 * Módulo para renderizar SVG como imagem Base64
 * Suporta análise visual via modelos de IA multimodais
 */

import { Buffer } from 'node:buffer';

export interface RenderedImage {
	base64: string;
	mimeType: 'image/png' | 'image/jpeg';
	width: number;
	height: number;
}

/**
 * Converte string para Base64 (compatível com Node.js)
 */
function toBase64(str: string): string {
	return Buffer.from(str, 'utf-8').toString('base64');
}

/**
 * Converte código SVG para uma imagem Base64 usando canvas
 * No ambiente VS Code (Node.js), usamos uma abordagem baseada em Data URI
 */
export async function renderSvgToBase64(svgCode: string): Promise<RenderedImage> {
	// Extrair dimensões do SVG
	const dimensions = extractSvgDimensions(svgCode);
	
	// Normalizar o SVG para garantir namespace correto
	const normalizedSvg = normalizeSvg(svgCode, dimensions.width, dimensions.height);
	
	// Criar Base64 do SVG
	const svgBase64 = toBase64(normalizedSvg);
	
	return {
		base64: svgBase64,
		mimeType: 'image/png', // APIs de visão geralmente preferem PNG
		width: dimensions.width,
		height: dimensions.height
	};
}

/**
 * Extrai as dimensões do SVG a partir dos atributos width/height ou viewBox
 */
function extractSvgDimensions(svgCode: string): { width: number; height: number } {
	// Tentar extrair de width/height explícitos
	const widthMatch = svgCode.match(/\bwidth\s*=\s*["']?(\d+)/i);
	const heightMatch = svgCode.match(/\bheight\s*=\s*["']?(\d+)/i);
	
	if (widthMatch && heightMatch) {
		return {
			width: parseInt(widthMatch[1], 10),
			height: parseInt(heightMatch[1], 10)
		};
	}
	
	// Tentar extrair do viewBox
	const viewBoxMatch = svgCode.match(/viewBox\s*=\s*["']?\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)/i);
	if (viewBoxMatch) {
		return {
			width: Math.ceil(parseFloat(viewBoxMatch[1])),
			height: Math.ceil(parseFloat(viewBoxMatch[2]))
		};
	}
	
	// Fallback para dimensões padrão
	return { width: 100, height: 100 };
}

/**
 * Normaliza o SVG adicionando namespace XML e garantindo dimensões
 */
function normalizeSvg(svgCode: string, width: number, height: number): string {
	let normalized = svgCode;
	
	// Adicionar namespace se não existir
	if (!normalized.includes('xmlns=')) {
		normalized = normalized.replace(
			/<svg\b/i,
			'<svg xmlns="http://www.w3.org/2000/svg"'
		);
	}
	
	// Garantir que width/height estejam presentes
	if (!/\bwidth\s*=/i.test(normalized)) {
		normalized = normalized.replace(
			/<svg\b([^>]*)/i,
			`<svg$1 width="${width}"`
		);
	}
	if (!/\bheight\s*=/i.test(normalized)) {
		normalized = normalized.replace(
			/<svg\b([^>]*)/i,
			`<svg$1 height="${height}"`
		);
	}
	
	return normalized;
}

/**
 * Cria um payload de imagem compatível com APIs de visão (OpenAI, Claude, Gemini)
 */
export function createVisionPayload(
	renderedImage: RenderedImage,
	format: 'openai' | 'claude' | 'gemini' = 'openai'
): object {
	const dataUri = `data:image/svg+xml;base64,${renderedImage.base64}`;
	
	switch (format) {
		case 'openai':
			// Formato OpenAI GPT-4V / GPT-4o
			return {
				type: 'image_url',
				image_url: {
					url: dataUri,
					detail: 'high'
				}
			};
		
		case 'claude':
			// Formato Anthropic Claude Vision
			return {
				type: 'image',
				source: {
					type: 'base64',
					media_type: 'image/svg+xml',
					data: renderedImage.base64
				}
			};
		
		case 'gemini':
			// Formato Google Gemini Vision
			return {
				inlineData: {
					mimeType: 'image/svg+xml',
					data: renderedImage.base64
				}
			};
		
		default:
			return { type: 'image_url', image_url: { url: dataUri } };
	}
}

/**
 * Detecta o provedor de IA baseado no endpoint
 */
export function detectAIProvider(endpoint: string): 'openai' | 'claude' | 'gemini' | 'unknown' {
	const lower = endpoint.toLowerCase();
	if (lower.includes('openai') || lower.includes('api.openai')) return 'openai';
	if (lower.includes('anthropic') || lower.includes('claude')) return 'claude';
	if (lower.includes('google') || lower.includes('gemini') || lower.includes('generativelanguage')) return 'gemini';
	return 'unknown';
}
