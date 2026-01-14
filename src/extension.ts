import * as vscode from 'vscode';
import { createIAClient } from './iaClient';
import { findSvgNodes, needsAccessibility, SvgNodeRange } from './svgParser';

const DIAGNOSTIC_CODE = 'svg-missing-a11y';

let collection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
	collection = vscode.languages.createDiagnosticCollection('svgA11y');
	context.subscriptions.push(collection);

	const iaClient = createIAClient();

	function refreshDiagnostics(doc: vscode.TextDocument) {
		if (!['html', 'javascriptreact', 'typescriptreact'].includes(doc.languageId)) {
			return;
		}
		const text = doc.getText();
		const nodes = findSvgNodes(text);
		const diags: vscode.Diagnostic[] = [];
		nodes.forEach((n) => {
			if (needsAccessibility(n)) {
				const range = new vscode.Range(doc.positionAt(n.start), doc.positionAt(n.tagOpenRange.end));
				const diag = new vscode.Diagnostic(
					range,
					'SVG sem <title>/<desc> ou aria-hidden: potencial falha de acessibilidade.',
					vscode.DiagnosticSeverity.Warning
				);
				diag.source = 'SVG A11Y Assist';
				diag.code = DIAGNOSTIC_CODE;
				diags.push(diag);
			}
		});
		collection.set(doc.uri, diags);
	}

	if (vscode.window.activeTextEditor) {
		refreshDiagnostics(vscode.window.activeTextEditor.document);
	}

	context.subscriptions.push(
			vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) =>
				refreshDiagnostics(e.document)
			),
		vscode.workspace.onDidOpenTextDocument(refreshDiagnostics)
	);

	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			[{ language: 'html' }, { language: 'javascriptreact' }, { language: 'typescriptreact' }],
			new SvgA11yCodeActionProvider(iaClient),
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('svgA11yAssist.generateAccessibility', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			await applyFixForEditor(editor, iaClient);
		})
	);
}

export function deactivate() {
	collection?.dispose();
}

class SvgA11yCodeActionProvider implements vscode.CodeActionProvider {
	constructor(private readonly iaClient: ReturnType<typeof createIAClient>) {}

	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext
	): vscode.ProviderResult<vscode.CodeAction[]> {
		const diagnostics = context.diagnostics.filter((d: vscode.Diagnostic) => d.code === DIAGNOSTIC_CODE);
		if (!diagnostics.length) return;
		const action = new vscode.CodeAction(
			'Gerar Acessibilidade para SVG com IA',
			vscode.CodeActionKind.QuickFix
		);
		action.command = {
			command: 'svgA11yAssist.generateAccessibility',
			title: 'Gerar Acessibilidade para SVG com IA'
		};
		action.diagnostics = diagnostics;
		action.isPreferred = true;
		return [action];
	}
}

async function applyFixForEditor(
	editor: vscode.TextEditor,
	iaClient: ReturnType<typeof createIAClient>
) {
	const doc = editor.document;
	const text = doc.getText();
	const nodes = findSvgNodes(text).filter(needsAccessibility);
	if (!nodes.length) {
		vscode.window.showInformationMessage('Nenhum SVG elegível encontrado.');
		return;
	}
	// For simplicity process the first one under cursor or first one.
	const cursor = editor.selection.active;
	let target = nodes[0];
	for (const n of nodes) {
		if (cursor.isAfterOrEqual(doc.positionAt(n.start)) && cursor.isBeforeOrEqual(doc.positionAt(n.end))) {
			target = n; break;
		}
	}

	// Criar item na barra de status
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarItem.text = '$(sync~spin) Consultando IA...';
	statusBarItem.tooltip = 'SVG A11Y Assist está analisando o SVG com IA';
	statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	statusBarItem.show();

	const config = vscode.workspace.getConfiguration('svgA11yAssist');
	const useVision = config.get<boolean>('useVision') ?? false;
	const progressTitle = useVision 
		? '$(eye) Analisando SVG com IA (Modo Visão)...' 
		: '$(hubot) Analisando SVG com IA...';

	try {
		await vscode.window.withProgress(
			{ 
				location: vscode.ProgressLocation.Notification, 
				title: 'SVG A11Y Assist',
				cancellable: true 
			},
			async (progress, token) => {
				// Etapa 1: Preparando
				progress.report({ message: 'Preparando análise...', increment: 10 });
				
				if (token.isCancellationRequested) {
					return;
				}

				// Etapa 2: Enviando para IA
				progress.report({ 
					message: useVision 
						? 'Renderizando SVG e enviando para IA...' 
						: 'Enviando código para IA...', 
					increment: 20 
				});
				
				statusBarItem.text = useVision 
					? '$(sync~spin) Renderizando SVG...' 
					: '$(sync~spin) Enviando para IA...';

				const suggestion = await iaClient.suggestForSvg(target.content);

				if (token.isCancellationRequested) {
					return;
				}

				// Etapa 3: Aplicando correção
				progress.report({ message: 'Aplicando correção...', increment: 50 });
				statusBarItem.text = '$(check) Aplicando correção...';

				const edit = buildWorkspaceEditForSuggestion(doc, target, suggestion);
				await vscode.workspace.applyEdit(edit);
				await doc.save();

				// Etapa 4: Concluído
				progress.report({ message: 'Concluído!', increment: 20 });
				
				// Mostrar resultado com detalhes WCAG quando disponível
				let resultMessage: string;
				if (suggestion.wcagAnalysis) {
					const wcag = suggestion.wcagAnalysis;
					const tipo = wcag.tipoImagem.classificacao;
					const status = wcag.conformidade.status === 'conforme' ? '✅' : '⚠️';
					resultMessage = suggestion.isDecorative 
						? `${status} WCAG 1.1.1: Imagem ${tipo} → aria-hidden="true"`
						: `${status} WCAG 1.1.1: Imagem ${tipo} → "${suggestion.titleText}"`;
				} else {
					resultMessage = suggestion.isDecorative 
						? '✅ SVG marcado como decorativo (aria-hidden="true")'
						: `✅ Acessibilidade adicionada: "${suggestion.titleText}"`;
				}
				
				vscode.window.showInformationMessage(resultMessage);
			}
		);
	} catch (error) {
		vscode.window.showErrorMessage(`Erro ao processar SVG: ${(error as Error).message}`);
	} finally {
		statusBarItem.dispose();
	}
}

import type { IAResponseSuggestion } from './iaClient';

function buildWorkspaceEditForSuggestion(
	doc: vscode.TextDocument,
	node: SvgNodeRange,
	suggestion: IAResponseSuggestion
): vscode.WorkspaceEdit {
	const edit = new vscode.WorkspaceEdit();
	const openingTagRange = new vscode.Range(
		doc.positionAt(node.tagOpenRange.start),
		doc.positionAt(node.tagOpenRange.end)
	);
	const openingTagText = doc.getText(openingTagRange);
	if (suggestion.isDecorative) {
		// Add aria-hidden="true" if not present
		if (!/aria-hidden=/i.test(openingTagText)) {
					const newOpen = openingTagText.replace(
						/<svg(\b[^>]*)>/i,
						(_m: string, attrs: string) => `<svg${attrs} aria-hidden="true">`
					);
			edit.replace(doc.uri, openingTagRange, newOpen);
		}
		return edit;
	}
	// Informative: need title (and maybe desc) and role/img + aria-labelledby
	const titleId = generateTitleId(openingTagText);
	let newOpen = openingTagText;
		if (!/role=/i.test(newOpen)) {
			newOpen = newOpen.replace(
				/<svg(\b[^>]*)>/i,
				(_m: string, attrs: string) => `<svg${attrs} role="img">`
			);
		}
	if (!/aria-labelledby=/i.test(newOpen)) {
			newOpen = newOpen.replace(
				/<svg(\b[^>]*)>/i,
				(_m: string, attrs: string) => `<svg${attrs} aria-labelledby="${titleId}">`
			);
	}
	edit.replace(doc.uri, openingTagRange, newOpen);
	// Insert title/desc after opening tag.
	const insertPos = doc.positionAt(node.tagOpenRange.end);
	const titleText = suggestion.titleText?.trim() || 'Gráfico';
	const descText = suggestion.descText?.trim();
	const parts = [`<title id="${titleId}">${escapeHtml(titleText)}</title>`];
	if (descText) parts.push(`<desc>${escapeHtml(descText)}</desc>`);
	edit.insert(doc.uri, insertPos, '\n  ' + parts.join('\n  ') + '\n');
	return edit;
}

function generateTitleId(openingTag: string): string {
	const base = 'svg-title-' + Math.random().toString(36).slice(2, 8);
	return base;
}

function escapeHtml(str: string): string {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
