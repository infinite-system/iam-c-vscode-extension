import * as vscode from "vscode";

const C_LIKE_LANGS = ["c", "cpp", "objective-c", "objective-cpp"];
const INCLUDE = "**/*.{c,cc,cpp,cxx,m,mm,h,hh,hpp,hxx}";
const DEFAULT_EXCLUDE = "**/{.git,node_modules,dist,build,out,target}/**";

type FileCache = {
  text: string;
  lineStarts: number[];
  versionTag: number; // synthetic; bumps when we refresh
};

type MacroDef = {
  uri: vscode.Uri;
  globalPrefix?: string; // e.g. iam_Kernel (not strictly needed, but kept)
};

type MacroIndex = {
  built: boolean;
  building?: Promise<void>;
  bump: number;

  // alias "Kernel" -> macro def sites (usually one: Kernel.c)
  aliasToMacroFiles: Map<string, MacroDef[]>;

  // uri -> cached text + lineStarts
  fileCache: Map<string, FileCache>;
};

const idx: MacroIndex = {
  built: false,
  bump: 1,
  aliasToMacroFiles: new Map(),
  fileCache: new Map(),
};

function langOk(doc?: vscode.TextDocument) {
  return !!doc && C_LIKE_LANGS.includes(doc.languageId);
}

function escapeRegexLiteral(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetToPos(lineStarts: number[], offset: number): vscode.Position {
  // binary search
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = lineStarts[mid];
    const next = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Infinity;
    if (offset < s) hi = mid - 1;
    else if (offset >= next) lo = mid + 1;
    else return new vscode.Position(mid, offset - s);
  }
  return new vscode.Position(0, offset);
}

async function getFileText(uri: vscode.Uri): Promise<FileCache> {
  const key = uri.toString();
  const cached = idx.fileCache.get(key);
  if (cached && cached.versionTag === idx.bump) return cached;

  const buf = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(buf).toString("utf8");
  const fc: FileCache = { text, lineStarts: computeLineStarts(text), versionTag: idx.bump };
  idx.fileCache.set(key, fc);
  return fc;
}

// Parse IAMC_USE_CLASS(iam_Kernel, Kernel) => Kernel -> iam_Kernel
function parseUseClassMappings(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const re =
    /\bIAMC_USE_CLASS\s*\(\s*([A-Za-z0-9_]\w*)\s*,\s*([A-Za-z0-9_]\w*)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) map.set(m[2], m[1]);
  return map;
}

// Detect: Kernel_(constructor) when cursor is anywhere inside that span.
// Also returns the span of the *fn token* so click on "constructor" works.
function extractAliasMacroCallAtPos(
  line: string,
  ch: number
): { alias: string; fn: string; fnStart: number; fnEnd: number } | null {
  const re = /([A-Za-z0-9_]\w*)_\(\s*([A-Za-z0-9_]\w*)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const fullStart = m.index;
    const fullEnd = fullStart + m[0].length;
    if (ch < fullStart || ch > fullEnd) continue;

    const alias = m[1];
    const fn = m[2];

    // compute fn substring range within the match
    const within = m[0].indexOf(fn);
    const fnStart = fullStart + within;
    const fnEnd = fnStart + fn.length;

    return { alias, fn, fnStart, fnEnd };
  }
  return null;
}

function looksLikeDefinition(text: string, matchStart: number): boolean {
  // After Alias_(fn)(... ) we expect '{' before ';'
  const window = text.slice(matchStart, Math.min(text.length, matchStart + 4000));
  const brace = window.indexOf("{");
  const semi = window.indexOf(";");
  return brace !== -1 && (semi === -1 || brace < semi);
}

function findMethodDefinitionInText(
  text: string,
  alias: string,
  fn: string
): { startOffset: number; endOffset: number } | null {
  const re = new RegExp(
    `\\b${escapeRegexLiteral(alias)}_\\(\\s*${escapeRegexLiteral(fn)}\\s*\\)\\s*\\(`,
    "g"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    if (!looksLikeDefinition(text, start)) continue;
    return { startOffset: start, endOffset: start + m[0].length };
  }
  return null;
}

async function buildMacroIndex(): Promise<void> {
  if (idx.built) return;
  if (idx.building) return idx.building;

  idx.building = (async () => {
    idx.aliasToMacroFiles.clear();
    idx.fileCache.clear();

    const exclude =
      vscode.workspace.getConfiguration("iamcNav").get<string>("exclude") ??
      DEFAULT_EXCLUDE;

    const files = await vscode.workspace.findFiles(INCLUDE, exclude);

    // Look for:
    //   #define Kernel_(fn) iam_Kernel_##fn
    //   #define Shape_(fn)  iam_geometry_Shape##_##fn
    const re = /^\s*#define\s+([A-Za-z0-9_]\w*)_\s*\(\s*fn\s*\)\s+([A-Za-z0-9_]\w*)/gm;

    for (const uri of files) {
      const { text } = await getFileText(uri);
      let m: RegExpExecArray | null;
      re.lastIndex = 0;

      while ((m = re.exec(text))) {
        const alias = m[1];
        const globalPrefix = m[2];

        const arr = idx.aliasToMacroFiles.get(alias) ?? [];
        arr.push({ uri, globalPrefix });
        idx.aliasToMacroFiles.set(alias, arr);
      }
    }

    idx.built = true;
  })();

  return idx.building;
}

async function resolveAliasFnToLocation(
  alias: string,
  fn: string,
  preferUri?: vscode.Uri
): Promise<vscode.Location | null> {
  // 1) if preferUri provided (same file), try it first
  if (preferUri) {
    const fc = await getFileText(preferUri);
    const hit = findMethodDefinitionInText(fc.text, alias, fn);
    if (hit) {
      const start = offsetToPos(fc.lineStarts, hit.startOffset);
      const end = offsetToPos(fc.lineStarts, hit.endOffset);
      return new vscode.Location(preferUri, new vscode.Range(start, end));
    }
  }

  // 2) try macro-def files for alias (Kernel.c, GrandParent.c, etc.)
  const defs = idx.aliasToMacroFiles.get(alias) ?? [];
  for (const def of defs) {
    const fc = await getFileText(def.uri);
    const hit = findMethodDefinitionInText(fc.text, alias, fn);
    if (!hit) continue;

    const start = offsetToPos(fc.lineStarts, hit.startOffset);
    const end = offsetToPos(fc.lineStarts, hit.endOffset);
    return new vscode.Location(def.uri, new vscode.Range(start, end));
  }

  return null;
}

class IamCDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Definition | null> {
    if (!langOk(document)) return null;

    // Make sure index is ready quickly
    await buildMacroIndex();

    const fullText = document.getText();
    const useClass = parseUseClassMappings(fullText);

    const lineText = document.lineAt(position.line).text;

    // A) Kernel_(constructor) style: click on "constructor" part
    const macroCall = extractAliasMacroCallAtPos(lineText, position.character);
    if (macroCall) {
      // If user is clicking on constructor token specifically, still resolve whole alias+fn.
      return await resolveAliasFnToLocation(
        macroCall.alias,
        macroCall.fn,
        document.uri // prefer current file
      );
    }

    // B) Kernel_init style: Local_method, where Local is introduced by IAMC_USE_CLASS(..., Local)
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]\w*/);
    if (!wordRange) return null;

    const word = document.getText(wordRange);
    const mm = word.match(/^([A-Za-z0-9_]\w*)_([A-Za-z0-9_]\w*)$/);
    if (!mm) return null;

    const local = mm[1];
    const fn = mm[2];

    // Only handle locals that the current file defines via IAMC_USE_CLASS
    // (prevents random foo_bar jumping)
    if (!useClass.has(local)) return null;

    return await resolveAliasFnToLocation(local, fn);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const selector: vscode.DocumentSelector = C_LIKE_LANGS.map((language) => ({
    language,
    scheme: "*",
  }));

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, new IamCDefinitionProvider())
  );

  // Rebuild index on saves (cheap: we just bump cache + rebuild lazily)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!langOk(doc)) return;
      idx.built = false;
      idx.building = undefined;
      idx.bump++;
    })
  );

  // Kick index build immediately so first click is instant
  buildMacroIndex().catch(() => {});
}

export function deactivate() {}
