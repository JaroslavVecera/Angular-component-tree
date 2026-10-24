import * as path from 'path';
import * as vscode from 'vscode';
import { countNodes, EditorState, planFiles, validateTree } from './generator';

const STATE_KEY = 'angularComponentTree.state';

export function activate(context: vscode.ExtensionContext) {
  const provider = new TreeEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TreeEditorProvider.viewId, provider),
    vscode.commands.registerCommand('angularComponentTree.setTarget', (uri?: vscode.Uri) => provider.setTarget(uri)),
  );
}

export function deactivate() {}

function defaultState(): EditorState {
  return { target: '', style: 'scss', tree: [], selectedId: null };
}

class TreeEditorProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'angularComponentTree.editor';

  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get state(): EditorState {
    return this.context.workspaceState.get<EditorState>(STATE_KEY) ?? defaultState();
  }

  private saveState(state: EditorState) {
    return this.context.workspaceState.update(STATE_KEY, state);
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaUri] };
    view.webview.html = this.getHtml(view.webview, mediaUri);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidDispose(() => (this.view = undefined));
  }

  async setTarget(uri?: vscode.Uri) {
    uri ??= await this.browseWorkspace();
    if (!uri) {
      return;
    }
    const target = toDisplayPath(uri);
    await this.saveState({ ...this.state, target });
    await vscode.commands.executeCommand(`${TreeEditorProvider.viewId}.focus`);
    this.view?.webview.postMessage({ type: 'target', target });
  }

  private async onMessage(msg: { type: string; state?: EditorState }) {
    switch (msg.type) {
      case 'ready': {
        const state = this.state;
        if (!state.target) {
          state.target = await defaultTarget();
          await this.saveState(state);
        }
        this.view?.webview.postMessage({ type: 'init', state });
        break;
      }
      case 'suggest': {
        const items = await suggestFolders(String((msg as { value?: string }).value ?? ''));
        this.view?.webview.postMessage({ type: 'suggestions', items, requestId: (msg as { requestId?: number }).requestId });
        break;
      }
      case 'browseWorkspace': {
        const uri = await this.browseWorkspace();
        if (uri) {
          this.view?.webview.postMessage({ type: 'target', target: toDisplayPath(uri) });
        }
        break;
      }
      case 'state':
        if (msg.state) {
          await this.saveState(msg.state);
        }
        break;
      case 'browse': {
        const uri = await this.pickFolder();
        if (uri) {
          this.view?.webview.postMessage({ type: 'target', target: toDisplayPath(uri) });
        }
        break;
      }
      case 'generate':
        if (msg.state) {
          await this.saveState(msg.state);
          await this.generate(msg.state);
        }
        break;
    }
  }

  /** Quick pick that walks the folder tree, starting at the current target or the workspace root. */
  private async browseWorkspace(): Promise<vscode.Uri | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      return this.pickFolder();
    }

    let current = (this.state.target && resolveTarget(this.state.target)) || folders[0].uri;
    while (!(await isDirectory(current)) && !samePath(vscode.Uri.joinPath(current, '..'), current)) {
      current = vscode.Uri.joinPath(current, '..');
    }

    type FolderItem = vscode.QuickPickItem & { action?: 'use' | 'open' | 'dialog'; uri?: vscode.Uri };
    const qp = vscode.window.createQuickPick<FolderItem>();
    qp.matchOnDescription = true;
    qp.placeholder = 'Enter otevře podsložku · pište pro filtrování nebo název nové podsložky';

    let baseItems: FolderItem[] = [];
    let subfolders: string[] = [];

    const refreshItems = () => {
      const typed = qp.value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const isNew = typed && !subfolders.includes(typed) && /^[^<>:"|?*]+$/.test(typed);
      qp.items = isNew
        ? [{
          label: `$(new-folder) Nová podsložka „${typed}“`,
          description: 'vytvoří se při generování',
          alwaysShow: true,
          action: 'use',
          uri: vscode.Uri.joinPath(current, ...typed.split('/')),
        }, ...baseItems]
        : baseItems;
    };

    const show = async (dir: vscode.Uri) => {
      current = dir;
      qp.busy = true;
      qp.title = `Cílová složka: ${toDisplayPath(dir)}`;
      qp.value = '';
      subfolders = await listSubfolders(dir);

      const parent = vscode.Uri.joinPath(dir, '..');
      const activeFile = vscode.window.activeTextEditor?.document.uri;
      const activeDir = activeFile?.scheme === 'file' ? vscode.Uri.joinPath(activeFile, '..') : undefined;
      const separator = (label: string): FolderItem => ({ label, kind: vscode.QuickPickItemKind.Separator });

      baseItems = [
        { label: '$(check) Použít tuto složku', description: toDisplayPath(dir), alwaysShow: true, action: 'use', uri: dir },
        ...(!samePath(parent, dir) ? [{ label: '$(arrow-up) ..', description: 'o úroveň výš', action: 'open', uri: parent } as FolderItem] : []),
        separator('podsložky'),
        ...subfolders.map((name): FolderItem => ({ label: `$(folder) ${name}`, action: 'open', uri: vscode.Uri.joinPath(dir, name) })),
        separator('přejít'),
        ...folders
          .filter((folder) => !samePath(folder.uri, dir))
          .map((folder): FolderItem => ({ label: `$(root-folder) ${folder.name}`, description: 'kořen workspace', action: 'open', uri: folder.uri })),
        ...(activeDir && !samePath(activeDir, dir)
          ? [{ label: '$(file) Složka otevřeného souboru', description: toDisplayPath(activeDir), action: 'open', uri: activeDir } as FolderItem]
          : []),
        { label: '$(folder-opened) Otevřít systémový dialog…', action: 'dialog' },
      ];
      refreshItems();
      qp.busy = false;
    };

    return new Promise<vscode.Uri | undefined>((resolve) => {
      let settled = false;
      const finish = (uri: vscode.Uri | undefined) => {
        settled = true;
        qp.hide();
        resolve(uri);
      };

      qp.onDidChangeValue(refreshItems);
      qp.onDidAccept(async () => {
        const item = qp.selectedItems[0];
        if (item?.action === 'use') {
          finish(item.uri);
        } else if (item?.action === 'open' && item.uri) {
          await show(item.uri);
        } else if (item?.action === 'dialog') {
          settled = true;
          qp.hide();
          resolve(await this.pickFolder());
        }
      });
      qp.onDidHide(() => {
        if (!settled) {
          resolve(undefined);
        }
        qp.dispose();
      });

      qp.show();
      show(current);
    });
  }

  private async pickFolder(): Promise<vscode.Uri | undefined> {
    const current = this.state.target ? resolveTarget(this.state.target) : undefined;
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Vybrat cílovou složku',
      defaultUri: current ?? vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    return picked?.[0];
  }

  private async generate(state: EditorState) {
    if (!state.tree.length) {
      vscode.window.showWarningMessage('Strom je prázdný, není co generovat.');
      return;
    }
    if (!state.target.trim()) {
      vscode.window.showErrorMessage('Zadej cílovou složku.');
      return;
    }
    const base = resolveTarget(state.target.trim());
    if (!base) {
      vscode.window.showErrorMessage('Relativní cestu nelze vyhodnotit bez otevřeného workspace. Zadej absolutní cestu.');
      return;
    }

    const errors = validateTree(state.tree);
    if (errors.length) {
      vscode.window.showErrorMessage(`Strom obsahuje chyby (${errors.length}).`, { modal: true, detail: errors.join('\n') });
      return;
    }

    const files = planFiles(state.tree, state);
    const uris = files.map((file) => vscode.Uri.joinPath(base, ...file.relativePath.split('/')));

    const existing: string[] = [];
    for (let i = 0; i < files.length; i++) {
      if (await exists(uris[i])) {
        existing.push(files[i].relativePath);
      }
    }

    let skipExisting = false;
    if (existing.length) {
      const overwrite = 'Přepsat';
      const skip = 'Přeskočit existující';
      const detail = existing.slice(0, 15).join('\n') + (existing.length > 15 ? `\n… a dalších ${existing.length - 15}` : '');
      const choice = await vscode.window.showWarningMessage(
        `${existing.length} z ${files.length} souborů už existuje.`,
        { modal: true, detail },
        overwrite,
        skip,
      );
      if (!choice) {
        return;
      }
      skipExisting = choice === skip;
    }

    const encoder = new TextEncoder();
    let written = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        if (skipExisting && existing.includes(files[i].relativePath)) {
          continue;
        }
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uris[i], '..'));
        await vscode.workspace.fs.writeFile(uris[i], encoder.encode(files[i].content));
        written++;
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Generování selhalo: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const { components, services } = countNodes(state.tree);
    const message = `Vygenerováno ${components} komponent a ${services} servis (${written} souborů) do ${state.target}`;
    this.view?.webview.postMessage({ type: 'generated', message });

    const reveal = 'Zobrazit v Exploreru';
    if ((await vscode.window.showInformationMessage(message, reveal)) === reveal) {
      vscode.commands.executeCommand('revealInExplorer', base);
    }
  }

  private getHtml(webview: vscode.Webview, mediaUri: vscode.Uri): string {
    const nonce = createNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'main.css'));
    return `<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Angular Component Tree</title>
</head>
<body>
  <section class="settings">
    <label class="field-label" for="target">Cílová složka</label>
    <div class="target-row">
      <div class="target-input">
        <input id="target" type="text" placeholder="src/app/features" spellcheck="false" autocomplete="off">
        <div id="suggest" class="suggest" hidden></div>
      </div>
      <button id="pick" class="secondary" title="Procházet složky workspace">Procházet</button>
      <button id="browse" class="secondary" title="Otevřít systémový dialog">…</button>
    </div>
    <div class="hint">Relativní cesta se počítá od kořene workspace (<code>.</code> = kořen).</div>
    <label class="check"><input id="scss" type="checkbox"> Generovat styly jako SCSS (jinak CSS)</label>
  </section>

  <section class="tree-section">
    <div class="section-head">
      <span class="section-title">Komponenty</span>
      <span class="spacer"></span>
      <button id="clear" class="link-btn" title="Smazat celý strom">Vymazat</button>
      <button id="addRoot" class="link-btn" title="Přidat komponentu na nejvyšší úroveň">+ Komponenta</button>
    </div>
    <div id="tree" class="tree"></div>
    <div class="hint shortcuts">
      <b>Enter</b> nová položka pod ní · <b>Tab</b> / <b>Shift+Tab</b> zanořit / vynořit ·
      <b>↑ ↓</b> pohyb · <b>Backspace</b> v prázdném názvu smaže · <b>+</b> vnořená komponenta (kebab-case) ·
      <b>+S</b> vnořená service (kebab-case) · klik na komponentu otevře inputy, outputy a modely
    </div>
  </section>

  <section class="footer">
    <div id="summary" class="summary"></div>
    <button id="generate" class="primary">Generovat</button>
    <div id="status" class="status"></div>
  </section>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function samePath(a: vscode.Uri, b: vscode.Uri): boolean {
  const norm = (uri: vscode.Uri) => {
    const p = uri.path.replace(/\/+$/, '');
    return process.platform === 'win32' ? p.toLowerCase() : p;
  };
  return a.scheme === b.scheme && norm(a) === norm(b);
}

/** `src/app` when the workspace looks like an Angular project, otherwise the workspace root. */
async function defaultTarget(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return '';
  }
  return (await isDirectory(vscode.Uri.joinPath(folder.uri, 'src', 'app'))) ? 'src/app' : toDisplayPath(folder.uri);
}

async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

const HIDDEN_FOLDERS = new Set(['node_modules', 'dist', 'out', 'coverage']);

async function listSubfolders(dir: vscode.Uri): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries
      .filter(([name, type]) => (type & vscode.FileType.Directory) !== 0 && !name.startsWith('.') && !HIDDEN_FOLDERS.has(name))
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Completes the last path segment of what is typed in the target field: `src/a` → `src/app/`, `src/app/` → its subfolders.
 * Suggestions end with '/' so accepting one immediately lists the next level.
 */
export async function suggestFolders(value: string): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const typed = value.replace(/\\/g, '/').replace(/^\.\/?/, '');
  const slash = typed.lastIndexOf('/');
  const dirPart = slash >= 0 ? typed.slice(0, slash + 1) : '';
  const prefix = (slash >= 0 ? typed.slice(slash + 1) : typed).toLowerCase();

  let names: string[];
  if (!dirPart && !path.isAbsolute(typed) && folders.length > 1) {
    names = folders.map((folder) => folder.name);
  } else {
    const dir = dirPart ? resolveTarget(dirPart) : folders[0]?.uri;
    names = dir ? await listSubfolders(dir) : [];
  }

  return names
    .filter((name) => name.toLowerCase().startsWith(prefix))
    .slice(0, 50)
    .map((name) => `${dirPart}${name}/`);
}

function toDisplayPath(uri: vscode.Uri): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const root = folders.find((folder) => samePath(folder.uri, uri));
  if (root) {
    return folders.length > 1 ? root.name : '.';
  }
  const relative = vscode.workspace.asRelativePath(uri, folders.length > 1);
  return relative === uri.fsPath || relative === '' ? uri.fsPath : relative.replace(/\\/g, '/');
}

function resolveTarget(target: string): vscode.Uri | undefined {
  if (path.isAbsolute(target)) {
    return vscode.Uri.file(target);
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    return undefined;
  }
  const segments = target.split(/[\\/]+/).filter(Boolean);
  if (folders.length > 1) {
    const named = folders.find((folder) => folder.name === segments[0]);
    if (named) {
      return vscode.Uri.joinPath(named.uri, ...segments.slice(1));
    }
  }
  return vscode.Uri.joinPath(folders[0].uri, ...segments);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
