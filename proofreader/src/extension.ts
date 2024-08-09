import * as vscode from 'vscode';
import { proofread, CorrectionResult } from './proofread';
import { computeDiff } from './diff';

let decorationType: vscode.TextEditorDecorationType;
let progressDecorationType: vscode.TextEditorDecorationType;
let diagnosticCollection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
    decorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 255, 0, 0.2)' // 薄い黄色
    });

    progressDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(0, 255, 0, 0.2)' // 薄い緑色
    });

    diagnosticCollection = vscode.languages.createDiagnosticCollection('markdown-proofreader');

    let disposable = vscode.commands.registerCommand('markdown-proofreader.proofread', async () => {
        const prerequisites = await checkPrerequisites();
        if (!prerequisites) return;

        const { editor, apiKey } = prerequisites;

        const confirmation = await vscode.window.showWarningMessage(
            'AIを用いたレビューを実行しますか？この実行ではAPI利用料金が発生します',
            'はい', 'いいえ'
        );
        if (confirmation !== 'はい') {
            return;
        }

        const document = editor.document;
        const text = document.getText();
        const lastLine = document.lineCount - 1;
        const lastLineLength = document.lineAt(lastLine).text.length;
        const fullRange = new vscode.Range(0, 0, lastLine, lastLineLength);

        await performProofread(editor, text, fullRange, apiKey);
    });

    let disposableSelectedRange = vscode.commands.registerCommand('markdown-proofreader.proofreadSelectedRange', async () => {
        const prerequisites = await checkPrerequisites();
        if (!prerequisites) return;

        const { editor, apiKey } = prerequisites;

        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showErrorMessage('テキストが選択されていません。');
            return;
        }

        const confirmation = await vscode.window.showWarningMessage(
            '選択範囲に対してAIを用いたレビューを実行しますか？この実行ではAPI利用料金が発生します',
            'はい', 'いいえ'
        );
        if (confirmation !== 'はい') {
            return;
        }

        const text = editor.document.getText(selection);
        await performProofread(editor, text, selection, apiKey);
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(disposableSelectedRange);

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider('markdown', new ProofreadCodeActionProvider(), {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
        })
    );

    context.subscriptions.push(vscode.commands.registerCommand('markdown-proofreader.removeDiagnostic', 
        (document: vscode.TextDocument, diagnostic: vscode.Diagnostic) => {
            removeDiagnostic(document, diagnostic);
        }
    ));

    context.subscriptions.push(
        vscode.languages.registerHoverProvider('markdown', new ProofreadHoverProvider())
    );
}

async function checkPrerequisites(): Promise<{editor: vscode.TextEditor, apiKey: string} | null> {
    if (!checkApiKey()) {
        const result = await vscode.window.showErrorMessage(
            'API key is not set. Would you like to set it now?',
            'Yes', 'No'
        );
        if (result === 'Yes') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'markdown-proofreader.apiKey');
        }
        return null;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('エディタが開かれていません。');
        return null;
    }

    const document = editor.document;
    if (document.languageId !== 'markdown') {
        vscode.window.showErrorMessage('このファイルはMarkdownではありません。');
        return null;
    }

    const config = vscode.workspace.getConfiguration('markdown-proofreader');
    const apiKey = config.get<string>('apiKey') ?? '';

    return { editor, apiKey };
}

async function performProofread(editor: vscode.TextEditor, text: string, range: vscode.Range, apiKey: string) {
    diagnosticCollection.delete(editor.document.uri);

    // 校正範囲を黄色にする
    editor.setDecorations(decorationType, [range]);

    const correctionStream = await proofread(text, apiKey);
    let lastProcessedLine = range.start.line - 1;

    for await (const correction of correctionStream) {
        if (correction.errors.length != 0) {
            applyProofReadResult(editor, correction, range.start);
        }

        // 処理済みの行を緑色にする
        const currentLine = correction.range.endsAt.lineIndex + range.start.line;
        if (currentLine > lastProcessedLine) {
            const progressRange = new vscode.Range(range.start.line, 0, currentLine + 1, 0);
            editor.setDecorations(progressDecorationType, [progressRange]);
            lastProcessedLine = currentLine;
        }
    }

    editor.setDecorations(decorationType, []);
    editor.setDecorations(progressDecorationType, []);
}

function applyProofReadResult(editor: vscode.TextEditor, result: CorrectionResult, offset: vscode.Position) {
    const currentDiagnostics = diagnosticCollection.get(editor.document.uri) || [];
    const newDiagnostics = [...currentDiagnostics];

    const range = new vscode.Range(
        new vscode.Position(result.range.startsAt.lineIndex + offset.line, result.range.startsAt.columnIndex + (result.range.startsAt.lineIndex === 0 ? offset.character : 0)),
        new vscode.Position(result.range.endsAt.lineIndex + offset.line, result.range.endsAt.columnIndex + (result.range.endsAt.lineIndex === 0 ? offset.character : 0))
    );
    const diagnostic = new vscode.Diagnostic(
        range,
        result.errors.join('\n'),
        vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = 'Markdown Proofreader';
    (diagnostic as any).correctedSentence = result.correctedSentence;
    
    newDiagnostics.push(diagnostic);
    diagnosticCollection.set(editor.document.uri, newDiagnostics);
}

function removeDiagnostic(document: vscode.TextDocument | undefined, diagnosticToRemove: vscode.Diagnostic) {
    if (!document) return;
    
    const currentDiagnostics = diagnosticCollection.get(document.uri) || [];
    const updatedDiagnostics = currentDiagnostics.filter(d => d !== diagnosticToRemove);
    diagnosticCollection.set(document.uri, updatedDiagnostics);
}

class ProofreadCodeActionProvider implements vscode.CodeActionProvider {
    provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {
        const diagnostics = context.diagnostics.filter(diag => diag.source === 'Markdown Proofreader');
       
        return diagnostics.flatMap(diagnostic => {
            // 修正を適用するアクション
            const fix = new vscode.CodeAction('修正を適用', vscode.CodeActionKind.QuickFix);
            fix.edit = new vscode.WorkspaceEdit();
            fix.edit.replace(document.uri, diagnostic.range, (diagnostic as any).correctedSentence);
            fix.diagnostics = [diagnostic];
            fix.isPreferred = true;

            // 警告を自動的に削除するコマンドを追加
            fix.command = {
                title: 'Remove diagnostic',
                command: 'markdown-proofreader.removeDiagnostic',
                arguments: [document, diagnostic]
            };

            // 修正を無視するアクション
            const ignore = new vscode.CodeAction('修正を無視', vscode.CodeActionKind.QuickFix);
            ignore.diagnostics = [diagnostic];
            ignore.command = {
                title: 'Ignore correction',
                command: 'markdown-proofreader.removeDiagnostic',
                arguments: [document, diagnostic]
            };

            return [fix, ignore];
        });
    }
}

export class ProofreadHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        const diagnostics = vscode.languages.getDiagnostics(document.uri);
        for (const diagnostic of diagnostics) {
            if (diagnostic.range.contains(position) && diagnostic.source === 'Markdown Proofreader') {
                const originalText = document.getText(diagnostic.range);
                const correctedText = (diagnostic as any).correctedSentence;
               
                const content = new vscode.MarkdownString();
                content.appendMarkdown('\n\n**提案内容:**\n');
                content.appendMarkdown(this.formatDiff(originalText, correctedText));
               
                return new vscode.Hover(content);
            }
        }
    }

    private formatDiff(text1: string, text2: string): string {
        const diff = computeDiff(text1, text2);
        let result = '';
        for (const part of diff) {
            switch (part.type) {
                case 'equal':
                    result += part.value;
                    break;
                case 'insert':
                    result += ` **${part.value}** `;
                    break;
                case 'delete':
                    result += ` **~~${part.value}~~** `;
                    break;
            }
        }
        return result;
    }
}

function checkApiKey(): boolean {
    const config = vscode.workspace.getConfiguration('markdown-proofreader');
    const apiKey = config.get<string>('apiKey');
    return !!apiKey;
}

export function deactivate() {
    if (diagnosticCollection) {
        diagnosticCollection.clear();
        diagnosticCollection.dispose();
    }
}