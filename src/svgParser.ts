// =====================================================
// SVG Node Types
// =====================================================

export interface SvgNodeRange {
	start: number; // index in document text where <svg starts
	end: number;   // index AFTER the closing tag
	content: string; // raw svg xml
	hasTitle: boolean;
	hasDesc: boolean;
	hasAriaHidden: boolean;
	tagOpenRange: { start: number; end: number }; // range of opening <svg ...>
}

const SVG_OPEN_RE = /<svg\b[^>]*>/gi;

export function findSvgNodes(text: string): SvgNodeRange[] {
	const results: SvgNodeRange[] = [];
	let match: RegExpExecArray | null;
	while ((match = SVG_OPEN_RE.exec(text))) {
		const openTagStart = match.index;
		const openTagEnd = match.index + match[0].length;
		// naive search for closing </svg>
		const closeIndex = text.indexOf('</svg>', openTagEnd);
		if (closeIndex === -1) continue;
		const end = closeIndex + '</svg>'.length;
		const content = text.slice(openTagStart, end);
		const inner = text.slice(openTagEnd, closeIndex);
		const hasTitle = /<title[\s>]/i.test(inner);
		const hasDesc = /<desc[\s>]/i.test(inner);
		const hasAriaHidden = /aria-hidden\s*=\s*"true"/i.test(match[0]);
		results.push({
			start: openTagStart,
			end,
			content,
			hasTitle,
			hasDesc,
			hasAriaHidden,
			tagOpenRange: { start: openTagStart, end: openTagEnd }
		});
	}
	return results;
}

export function needsAccessibility(node: SvgNodeRange): boolean {
	return !node.hasAriaHidden && !(node.hasTitle || node.hasDesc);
}

// =====================================================
// IMG Node Types
// =====================================================

export interface ImgNodeRange {
	start: number;        // index onde <img começa
	end: number;          // index APÓS o final da tag (> ou />)
	content: string;      // tag <img ...> completa
	src: string;          // valor do atributo src
	alt: string | null;   // valor do alt (null se ausente)
	hasAlt: boolean;      // se o atributo alt existe
	hasAriaHidden: boolean;
	hasRole: boolean;     // se tem role="presentation" ou role="none"
	tagRange: { start: number; end: number };
}

const IMG_RE = /<img\b[^>]*\/?>/gi;

/**
 * Encontra todas as tags <img> no texto
 */
export function findImgNodes(text: string): ImgNodeRange[] {
	const results: ImgNodeRange[] = [];
	let match: RegExpExecArray | null;
	
	while ((match = IMG_RE.exec(text))) {
		const tagStart = match.index;
		const tagEnd = match.index + match[0].length;
		const tagContent = match[0];
		
		// Extrair atributo src
		const srcMatch = tagContent.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
		const src = srcMatch ? srcMatch[1] : '';
		
		// Extrair atributo alt
		const altMatch = tagContent.match(/\balt\s*=\s*["']([^"']*)["']/i);
		const hasAlt = altMatch !== null;
		const alt = hasAlt ? altMatch[1] : null;
		
		// Verificar aria-hidden
		const hasAriaHidden = /aria-hidden\s*=\s*["']true["']/i.test(tagContent);
		
		// Verificar role="presentation" ou role="none"
		const hasRole = /role\s*=\s*["'](presentation|none)["']/i.test(tagContent);
		
		results.push({
			start: tagStart,
			end: tagEnd,
			content: tagContent,
			src,
			alt,
			hasAlt,
			hasAriaHidden,
			hasRole,
			tagRange: { start: tagStart, end: tagEnd }
		});
	}
	
	return results;
}

/**
 * Verifica se uma tag <img> precisa de correção de acessibilidade
 * Regras WCAG 2.2:
 * - Imagem precisa de alt="" (vazio para decorativa, descritivo para informativa)
 * - Ou aria-hidden="true" + role="presentation"/"none" para decorativas
 */
export function imgNeedsAccessibility(node: ImgNodeRange): boolean {
	// Se tem aria-hidden="true", não precisa de alt
	if (node.hasAriaHidden) {
		return false;
	}
	
	// Se tem role="presentation" ou role="none", é decorativa
	if (node.hasRole) {
		return false;
	}
	
	// Se não tem atributo alt, PRECISA de correção
	if (!node.hasAlt) {
		return true;
	}
	
	// alt="" vazio é válido para imagens decorativas
	// Qualquer alt com conteúdo é válido para imagens informativas
	return false;
}
