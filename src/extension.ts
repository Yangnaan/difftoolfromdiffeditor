import * as vscode from 'vscode';
import { exec, ExecException } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

interface GitExtension {
    readonly enabled: boolean;
    getAPI(version: 1): any;
}

class TempFileManager {
    private tempFiles: string[] = [];

    async createTempFile(content: string, originalUri: vscode.Uri, prefix = 'diff_'): Promise<string> {
        const tempDir = os.tmpdir();
        const ext = path.extname(originalUri.fsPath);
        const baseName = path.basename(originalUri.fsPath, ext);
        const tempFileName = `${prefix}${baseName}_${Date.now()}${ext}`;
        const tempFilePath = path.join(tempDir, tempFileName);

        await fs.promises.writeFile(tempFilePath, content);
        this.tempFiles.push(tempFilePath);
        
        console.log(`Created temp file: ${tempFilePath}`);
        return tempFilePath;
    }

    cleanup(): void {
        this.tempFiles.forEach(file => {
            try {
                if (fs.existsSync(file)) {
                    fs.unlinkSync(file);
                    console.log(`Deleted temp file: ${file}`);
                }
            } catch (err) {
                console.warn(`Failed to delete temp file ${file}: ${err}`);
            }
        });
        this.tempFiles = [];
    }
}

async function getEditorContent(uri: vscode.Uri): Promise<string> {
    try {
        // 尝试从打开的编辑器中获取内容
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() === uri.toString()) {
                return editor.document.getText();
            }
        }

        // 如果编辑器未打开，尝试直接读取文件
        if (uri.scheme === 'file') {
            return await fs.promises.readFile(uri.fsPath, 'utf-8');
        }

        // 其他情况使用VS Code API读取
        const document = await vscode.workspace.openTextDocument(uri);
        return document.getText();
    } catch (error) {
        console.error(`Failed to get content for ${uri.toString()}: ${error}`);
        return '';
    }
}

async function getDiffContents(tab: vscode.Tab, tempManager: TempFileManager): Promise<{ 
    original: { path: string; uri: vscode.Uri }; 
    modified: { path: string; uri: vscode.Uri } 
} | null> {
    const input = tab.input as any;
    let originalUri: vscode.Uri | undefined;
    let modifiedUri: vscode.Uri | undefined;

    if (input.original && input.modified) {
        originalUri = input.original;
        modifiedUri = input.modified;
    } else if (input.left?.uri && input.right?.uri) {
        originalUri = input.left.uri;
        modifiedUri = input.right.uri;
    } else if (input.leftUri && input.rightUri) {
        originalUri = input.leftUri;
        modifiedUri = input.rightUri;
    }

    if (!originalUri || !modifiedUri) return null;

    const originalContent = await getEditorContent(originalUri);
    const modifiedContent = await getEditorContent(modifiedUri);

    return {
        original: {
            path: await tempManager.createTempFile(originalContent, originalUri, 'original_'),
            uri: originalUri
        },
        modified: {
            path: await tempManager.createTempFile(modifiedContent, modifiedUri, 'modified_'),
            uri: modifiedUri
        }
    };
}

function executeDifftool(originalPath: string, modifiedPath: string, repoRoot: string): Promise<void> {
    return new Promise((resolve, reject) => {
        // 使用相对路径避免空格等问题
        const relOriginal = path.relative(repoRoot, originalPath).replace(/\\/g, '/');
        const relModified = path.relative(repoRoot, modifiedPath).replace(/\\/g, '/');

        const command = `git difftool --no-prompt "${relOriginal}" "${relModified}"`;
        console.log(`Executing in ${repoRoot}: ${command}`);

        const child = exec(command, { cwd: repoRoot }, (error) => {
            if (error) {
                // 忽略正常退出和用户取消的错误
                if (error.code === 0 || error.code === 1) {
                    resolve();
                } else {
                    console.error(`Difftool error: ${error.message}`);
                    reject(error);
                }
            } else {
                resolve();
            }
        });

        // 监听进程退出
        child.on('exit', (code) => {
            if (code === 0 || code === 1) {
                resolve();
            } else {
                reject(new Error(`Difftool exited with code ${code}`));
            }
        });
    });
}

export async function activate(context: vscode.ExtensionContext) {
    const tempManager = new TempFileManager();
    let isRunning = false;

    const disposable = vscode.commands.registerCommand('git-difftool-button.openInGitDifftool', async () => {
        if (isRunning) {
            vscode.window.showWarningMessage('已有difftool实例正在运行');
            return;
        }

        isRunning = true;
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;

        try {
            if (!tab || !isDiffEditorTab(tab)) {
                vscode.window.showErrorMessage('请在Git差异视图中使用此功能');
                return;
            }

            const contents = await getDiffContents(tab, tempManager);
            if (!contents) {
                vscode.window.showErrorMessage('无法获取对比内容');
                return;
            }

            const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
            if (!gitExtension) throw new Error('Git扩展未加载');

            const git = gitExtension.getAPI(1);
            const repository = git.repositories[0];
            if (!repository) throw new Error('未找到Git仓库');

            await executeDifftool(
                contents.original.path,
                contents.modified.path,
                repository.rootUri.fsPath
            );
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : '未知错误';
            console.error('Error:', error);
            
            // 不显示git difftool的正常退出错误
            if (!message.includes('Command failed: git difftool')) {
                vscode.window.showErrorMessage(`比较失败: ${message}`);
            }
        } finally {
            // 延迟清理临时文件
            setTimeout(() => {
                tempManager.cleanup();
                isRunning = false;
            }, 100); // 100毫秒后清理
        }
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(new vscode.Disposable(() => {
        tempManager.cleanup();
    }));
}

function isDiffEditorTab(tab: vscode.Tab | undefined): boolean {
    if (!tab?.input || typeof tab.input !== 'object') return false;
    const input = tab.input as any;
    return (input.original && input.modified) || 
           (input.left?.uri && input.right?.uri) || 
           (input.leftUri && input.rightUri);
}

export function deactivate() {
    // 清理逻辑已包含在Disposable中
}