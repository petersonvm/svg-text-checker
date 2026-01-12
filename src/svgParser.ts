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
