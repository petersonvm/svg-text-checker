import * as vscode from 'vscode';
import { createIAClient } from './iaClient';
import { findSvgNodes, needsAccessibility, SvgNodeRange, findImgNodes, imgNeedsAccessibility, ImgNodeRange } from './svgParser';

const DIAGNOSTIC_CODE_SVG = 'svg-missing-a11y';
const DIAGNOSTIC_CODE_IMG = 'img-missing-alt';

let collection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
	collection = vscode.languages.createDiagnosticCollection('a11yAssist');
	context.subscriptions.push(collection);

	const iaClient = createIAClient();

	function refreshDiagnostics(doc: vscode.TextDocument) {
		if (!['html', 'javascriptreact', 'typescriptreact'].includes(doc.languageId)) {
			return;
		}
		const text = doc.getText();
		const diags: vscode.Diagnostic[] = [];
		
		// Diagnósticos para SVG
		const svgNodes = findSvgNodes(text);
		svgNodes.forEach((n) => {
			if (needsAccessibility(n)) {
				const range = new vscode.Range(doc.positionAt(n.start), doc.positionAt(n.tagOpenRange.end));
				const diag = new vscode.Diagnostic(
					range,
					'SVG sem <title>/<desc> ou aria-hidden: potencial falha de acessibilidade.',
					vscode.DiagnosticSeverity.Warning
				);
				diag.source = 'A11Y Assist';
				diag.code = DIAGNOSTIC_CODE_SVG;
				diags.push(diag);
			}
		});
		
		// Diagnósticos para IMG
		const imgNodes = findImgNodes(text);
		imgNodes.forEach((n) => {
			if (imgNeedsAccessibility(n)) {
				const range = new vscode.Range(doc.positionAt(n.start), doc.positionAt(n.end));
				const diag = new vscode.Diagnostic(
					range,
					'Imagem sem atributo alt: violação WCAG 1.1.1 (Conteúdo Não-textual).',
					vscode.DiagnosticSeverity.Warning
				);
				diag.source = 'A11Y Assist';
				diag.code = DIAGNOSTIC_CODE_IMG;
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

	// Registrar CodeActionProvider para SVG e IMG
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			[{ language: 'html' }, { language: 'javascriptreact' }, { language: 'typescriptreact' }],
			new A11yCodeActionProvider(iaClient),
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
		)
	);

	// Comando para corrigir SVG
	context.subscriptions.push(
		vscode.commands.registerCommand('a11yAssist.fixSvg', async (diagnosticRange?: vscode.Range) => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			await applyFixForSvg(editor, iaClient, diagnosticRange);
		})
	);

	// Comando para corrigir IMG
	context.subscriptions.push(
		vscode.commands.registerCommand('a11yAssist.fixImg', async (diagnosticRange?: vscode.Range) => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			await applyFixForImg(editor, iaClient, diagnosticRange);
		})
	);
}

export function deactivate() {
	collection?.dispose();
}

class A11yCodeActionProvider implements vscode.CodeActionProvider {
	constructor(private readonly iaClient: ReturnType<typeof createIAClient>) {}

	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext
	): vscode.ProviderResult<vscode.CodeAction[]> {
		const actions: vscode.CodeAction[] = [];
		
		// Ações para SVG
		const svgDiagnostics = context.diagnostics.filter((d: vscode.Diagnostic) => d.code === DIAGNOSTIC_CODE_SVG);
		for (const diagnostic of svgDiagnostics) {
			const action = new vscode.CodeAction(
				'🎨 Gerar acessibilidade para SVG com IA',
				vscode.CodeActionKind.QuickFix
			);
			action.command = {
				command: 'a11yAssist.fixSvg',
				title: 'Gerar acessibilidade para SVG com IA',
				arguments: [diagnostic.range]
			};
			action.diagnostics = [diagnostic];
			action.isPreferred = true;
			actions.push(action);
		}
		
		// Ações para IMG
		const imgDiagnostics = context.diagnostics.filter((d: vscode.Diagnostic) => d.code === DIAGNOSTIC_CODE_IMG);
		for (const diagnostic of imgDiagnostics) {
			const action = new vscode.CodeAction(
				'🖼️ Gerar alt para imagem com IA',
				vscode.CodeActionKind.QuickFix
			);
			action.command = {
				command: 'a11yAssist.fixImg',
				title: 'Gerar alt para imagem com IA',
				arguments: [diagnostic.range]
			};
			action.diagnostics = [diagnostic];
			action.isPreferred = true;
			actions.push(action);
		}
		
		return actions;
	}
}

// =====================================================
// Fix para SVG
// =====================================================

async function applyFixForSvg(
	editor: vscode.TextEditor,
	iaClient: ReturnType<typeof createIAClient>,
	diagnosticRange?: vscode.Range
) {
	const doc = editor.document;
	const text = doc.getText();
	const nodes = findSvgNodes(text).filter(needsAccessibility);
	if (!nodes.length) {
		vscode.window.showInformationMessage('Nenhum SVG elegível encontrado.');
		return;
	}
	
	// Se temos o range do diagnóstico, encontrar o SVG correspondente
	// Caso contrário, usar a posição do cursor
	let target = nodes[0];
	
	if (diagnosticRange) {
		// Encontrar o SVG que corresponde ao range do diagnóstico
		const diagnosticStart = doc.offsetAt(diagnosticRange.start);
		for (const n of nodes) {
			if (n.start === diagnosticStart) {
				target = n;
				break;
			}
		}
	} else {
		// Fallback: usar posição do cursor
		const cursor = editor.selection.active;
		for (const n of nodes) {
			if (cursor.isAfterOrEqual(doc.positionAt(n.start)) && cursor.isBeforeOrEqual(doc.positionAt(n.end))) {
				target = n;
				break;
			}
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

// =====================================================
// Fix para IMG
// =====================================================

async function applyFixForImg(
	editor: vscode.TextEditor,
	iaClient: ReturnType<typeof createIAClient>,
	diagnosticRange?: vscode.Range
) {
	const doc = editor.document;
	const text = doc.getText();
	const nodes = findImgNodes(text).filter(imgNeedsAccessibility);
	
	if (!nodes.length) {
		vscode.window.showInformationMessage('Nenhuma imagem elegível encontrada.');
		return;
	}
	
	// Encontrar a imagem correspondente ao diagnóstico
	let target = nodes[0];
	
	if (diagnosticRange) {
		const diagnosticStart = doc.offsetAt(diagnosticRange.start);
		for (const n of nodes) {
			if (n.start === diagnosticStart) {
				target = n;
				break;
			}
		}
	} else {
		const cursor = editor.selection.active;
		for (const n of nodes) {
			if (cursor.isAfterOrEqual(doc.positionAt(n.start)) && cursor.isBeforeOrEqual(doc.positionAt(n.end))) {
				target = n;
				break;
			}
		}
	}

	// Criar item na barra de status
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarItem.text = '$(sync~spin) Analisando imagem...';
	statusBarItem.tooltip = 'A11Y Assist está analisando a imagem';
	statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	statusBarItem.show();

	const config = vscode.workspace.getConfiguration('svgA11yAssist');
	const useVision = config.get<boolean>('useVision') ?? false;

	try {
		await vscode.window.withProgress(
			{ 
				location: vscode.ProgressLocation.Notification, 
				title: 'A11Y Assist',
				cancellable: true 
			},
			async (progress, token) => {
				progress.report({ message: 'Preparando análise...', increment: 10 });
				
				if (token.isCancellationRequested) return;

				progress.report({ 
					message: useVision 
						? 'Enviando imagem para IA...' 
						: 'Analisando nome do arquivo...', 
					increment: 20 
				});
				
				statusBarItem.text = useVision 
					? '$(sync~spin) Enviando para IA...' 
					: '$(sync~spin) Analisando...';

				// Passar o URI do documento para resolver caminhos relativos de imagens locais
				const suggestion = await iaClient.suggestForImg(target.src, target.content, doc.uri);

				if (token.isCancellationRequested) return;

				progress.report({ message: 'Aplicando correção...', increment: 50 });
				statusBarItem.text = '$(check) Aplicando correção...';

				const edit = buildWorkspaceEditForImg(doc, target, suggestion);
				await vscode.workspace.applyEdit(edit);
				await doc.save();

				progress.report({ message: 'Concluído!', increment: 20 });
				
				let resultMessage: string;
				if (suggestion.isDecorative) {
					resultMessage = '✅ Imagem marcada como decorativa (alt="")';
				} else {
					resultMessage = `✅ Alt adicionado: "${suggestion.titleText}"`;
				}
				
				vscode.window.showInformationMessage(resultMessage);
			}
		);
	} catch (error) {
		vscode.window.showErrorMessage(`Erro ao processar imagem: ${(error as Error).message}`);
	} finally {
		statusBarItem.dispose();
	}
}

function buildWorkspaceEditForImg(
	doc: vscode.TextDocument,
	node: ImgNodeRange,
	suggestion: IAResponseSuggestion
): vscode.WorkspaceEdit {
	const edit = new vscode.WorkspaceEdit();
	const tagRange = new vscode.Range(
		doc.positionAt(node.tagRange.start),
		doc.positionAt(node.tagRange.end)
	);
	const tagText = doc.getText(tagRange);
	
	let newTag = tagText;
	const altValue = suggestion.isDecorative ? '' : escapeHtml(suggestion.titleText?.trim() || 'Imagem');
	
	if (suggestion.isDecorative) {
		// Imagem decorativa: alt="" 
		// Adicionar alt="" antes do fechamento da tag
		if (tagText.endsWith('/>')) {
			newTag = tagText.replace(/\s*\/?>$/, ` alt="" />`);
		} else {
			newTag = tagText.replace(/\s*>$/, ` alt="">`);
		}
	} else {
		// Imagem informativa: alt="descrição"
		if (tagText.endsWith('/>')) {
			newTag = tagText.replace(/\s*\/?>$/, ` alt="${altValue}" />`);
		} else {
			newTag = tagText.replace(/\s*>$/, ` alt="${altValue}">`);
		}
	}
	
	edit.replace(doc.uri, tagRange, newTag);
	return edit;
}
