import * as vscode from 'vscode';
import { buildPrompt } from './prompt';

export interface IAResponseSuggestion {
	isDecorative: boolean;
	titleText?: string;
	descText?: string;
}

export interface IAClientOptions {
	apiKey?: string;
	endpoint?: string;
	model?: string;
}

export class IAClient {
	constructor(private readonly opts: IAClientOptions) {}

	async suggestForSvg(svgCode: string): Promise<IAResponseSuggestion> {
		// If no endpoint/key provided, use heuristic mock to keep UX responsive.
		if (!this.opts.endpoint || !this.opts.apiKey) {
			return this.mockHeuristic(svgCode);
		}

		const body = {
			model: this.opts.model || 'auto',
			prompt: buildPrompt(svgCode)
		};

		try {
			const resp = await fetch(this.opts.endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.opts.apiKey}`
				},
				body: JSON.stringify(body)
			});
			if (!resp.ok) {
				throw new Error(`HTTP ${resp.status}`);
			}
			const text = await resp.text();
			// Try to locate JSON in potentially verbose response.
			const match = text.match(/\{[\s\S]*\}/);
			if (!match) throw new Error('No JSON found in response');
			const parsed = JSON.parse(match[0]);
			return {
				isDecorative: !!parsed.isDecorative,
				titleText: parsed.titleText || '',
				descText: parsed.descText || ''
			};
		} catch (err) {
			vscode.window.showWarningMessage(
				`Falha na chamada de IA, usando heurística local: ${(err as Error).message}`
			);
			return this.mockHeuristic(svgCode);
		}
	}

	private mockHeuristic(svgCode: string): IAResponseSuggestion {
		const lower = svgCode.toLowerCase();
		const looksLikeChart = /(rect|line|path).+?(rect|line|path)/s.test(lower) && /axis|chart|bar|graph/.test(lower);
		const hasText = /<text[\s>]/.test(lower);
		const isDecorative = !hasText && !looksLikeChart;
		if (isDecorative) {
			return { isDecorative, titleText: '', descText: '' };
		}
		// Build a simple title from viewBox or size
		const titlePieces: string[] = [];
		if (/viewbox="(.*?)"/i.test(svgCode)) titlePieces.push('Ícone');
		if (looksLikeChart) titlePieces.push('Gráfico');
		if (hasText) titlePieces.push('Texto');
		const title = (titlePieces[0] ? titlePieces.join(' ') : 'Gráfico SVG').slice(0, 60);
		const desc = looksLikeChart
			? 'Gráfico ou diagrama com múltiplos elementos visuais.'
			: '';
		return { isDecorative, titleText: title, descText: desc };
	}
}

export function createIAClient(): IAClient {
	const config = vscode.workspace.getConfiguration();
	const apiKey = config.get<string>('svgA11yAssist.apiKey') || process.env.SVG_A11Y_API_KEY || '';
	const endpoint = config.get<string>('svgA11yAssist.endpoint') || '';
	const model = config.get<string>('svgA11yAssist.model') || '';
	return new IAClient({ apiKey, endpoint, model });
}
