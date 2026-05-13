// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

// Map file extension → shiki language id
const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
  lua: 'lua',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  java: 'java',
  cs: 'csharp',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish',
  json: 'json', jsonl: 'json', jsonc: 'jsonc',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html',
  svelte: 'svelte',
  vue: 'vue',
  md: 'markdown', mdx: 'mdx',
  sql: 'sql',
  tf: 'terraform', hcl: 'hcl',
  dockerfile: 'dockerfile',
  vim: 'viml',
  r: 'r',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  ex: 'elixir', exs: 'elixir',
  hs: 'haskell',
  nix: 'nix',
  mojo: 'mojo', '🔥': 'mojo',
};

// Paired theme families: selecting a family auto-applies dark/light variant based on UI theme
export const THEME_PAIRS = {
  'github':     { dark: 'github-dark',               light: 'github-light' },
  'rose-pine':  { dark: 'rose-pine',                 light: 'rose-pine-dawn' },
  'solarized':  { dark: 'solarized-dark',            light: 'solarized-light' },
  'vitesse':    { dark: 'vitesse-dark',              light: 'vitesse-light' },
  'catppuccin': { dark: 'catppuccin-mocha',          light: 'catppuccin-latte' },
  'github-hc':  { dark: 'github-dark-high-contrast', light: 'github-light-high-contrast' },
};

// Theme id → shiki bundle import
const THEME_IMPORTS = {
  'github-dark':     () => import('shiki/themes/github-dark.mjs'),
  'github-light':    () => import('shiki/themes/github-light.mjs'),
  'one-dark-pro':    () => import('shiki/themes/one-dark-pro.mjs'),
  'catppuccin-mocha': () => import('shiki/themes/catppuccin-mocha.mjs'),
  'catppuccin-latte': () => import('shiki/themes/catppuccin-latte.mjs'),
  'nord':            () => import('shiki/themes/nord.mjs'),
  'dracula':         () => import('shiki/themes/dracula.mjs'),
  'tokyo-night':     () => import('shiki/themes/tokyo-night.mjs'),
  'rose-pine':                  () => import('shiki/themes/rose-pine.mjs'),
  'rose-pine-dawn':             () => import('shiki/themes/rose-pine-dawn.mjs'),
  'github-dark-high-contrast':  () => import('shiki/themes/github-dark-high-contrast.mjs'),
  'github-light-high-contrast': () => import('shiki/themes/github-light-high-contrast.mjs'),
  'solarized-dark':             () => import('shiki/themes/solarized-dark.mjs'),
  'solarized-light':            () => import('shiki/themes/solarized-light.mjs'),
  'vitesse-dark':               () => import('shiki/themes/vitesse-dark.mjs'),
  'vitesse-light':              () => import('shiki/themes/vitesse-light.mjs'),
};

// Language id → shiki bundle import
const LANG_IMPORTS = {
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx:        () => import('shiki/langs/tsx.mjs'),
  jsx:        () => import('shiki/langs/jsx.mjs'),
  lua:        () => import('shiki/langs/lua.mjs'),
  python:     () => import('shiki/langs/python.mjs'),
  ruby:       () => import('shiki/langs/ruby.mjs'),
  rust:       () => import('shiki/langs/rust.mjs'),
  go:         () => import('shiki/langs/go.mjs'),
  c:          () => import('shiki/langs/c.mjs'),
  cpp:        () => import('shiki/langs/cpp.mjs'),
  java:       () => import('shiki/langs/java.mjs'),
  csharp:     () => import('shiki/langs/csharp.mjs'),
  bash:       () => import('shiki/langs/bash.mjs'),
  fish:       () => import('shiki/langs/fish.mjs'),
  json:       () => import('shiki/langs/json.mjs'),
  jsonc:      () => import('shiki/langs/jsonc.mjs'),
  yaml:       () => import('shiki/langs/yaml.mjs'),
  toml:       () => import('shiki/langs/toml.mjs'),
  css:        () => import('shiki/langs/css.mjs'),
  scss:       () => import('shiki/langs/scss.mjs'),
  less:       () => import('shiki/langs/less.mjs'),
  html:       () => import('shiki/langs/html.mjs'),
  svelte:     () => import('shiki/langs/svelte.mjs'),
  vue:        () => import('shiki/langs/vue.mjs'),
  markdown:   () => import('shiki/langs/markdown.mjs'),
  mdx:        () => import('shiki/langs/mdx.mjs'),
  sql:        () => import('shiki/langs/sql.mjs'),
  terraform:  () => import('shiki/langs/terraform.mjs'),
  hcl:        () => import('shiki/langs/hcl.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  viml:       () => import('shiki/langs/viml.mjs'),
  r:          () => import('shiki/langs/r.mjs'),
  swift:      () => import('shiki/langs/swift.mjs'),
  kotlin:     () => import('shiki/langs/kotlin.mjs'),
  elixir:     () => import('shiki/langs/elixir.mjs'),
  haskell:    () => import('shiki/langs/haskell.mjs'),
  nix:        () => import('shiki/langs/nix.mjs'),
  mojo:       () => import('shiki/langs/mojo.mjs'),
};

// Store promises, not resolved values — prevents concurrent duplicate loads
let highlighterPromise = null;
const themePromises = new Map();  // themeId → Promise
const langPromises = new Map();   // langId  → Promise

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import('shiki/core'),
      import('shiki/engine/oniguruma'),
    ]).then(([{ createHighlighterCore }, { createOnigurumaEngine }]) =>
      createHighlighterCore({
        themes: [],
        langs: [],
        engine: createOnigurumaEngine(import('shiki/wasm')),
      })
    );
  }
  return highlighterPromise;
}

async function ensureTheme(hl, themeId) {
  if (themePromises.has(themeId)) return themePromises.get(themeId);
  const load = THEME_IMPORTS[themeId];
  if (!load) return;
  const p = load().then(m => hl.loadTheme(m));
  themePromises.set(themeId, p);
  return p;
}

async function ensureLang(hl, langId) {
  if (!langId) return;
  if (langPromises.has(langId)) return langPromises.get(langId);
  const load = LANG_IMPORTS[langId];
  if (!load) return;
  const p = load().then(m => hl.loadLanguage(m));
  langPromises.set(langId, p);
  return p;
}

export function langFromPath(path) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  // special case: Dockerfile with no extension
  if (!ext || path.toLowerCase().endsWith('dockerfile')) return 'dockerfile';
  return EXT_LANG[ext] ?? null;
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Highlight code and return per-line HTML strings.
 * Falls back to plain escaped text if lang/theme unknown.
 *
 * @param {string} code - full source text
 * @param {string|null} lang - shiki language id (e.g. 'lua')
 * @param {string} themeId - shiki theme id (e.g. 'github-dark')
 * @returns {Promise<string[]>} - one HTML string per line
 */
export async function highlightLines(code, lang, themeId) {
  const hl = await getHighlighter();
  await ensureTheme(hl, themeId);
  const resolvedLang = lang && LANG_IMPORTS[lang] ? lang : 'text';
  if (resolvedLang !== 'text') await ensureLang(hl, resolvedLang);

  const result = hl.codeToTokens(code, { lang: resolvedLang, theme: themeId });
  const lines = result.tokens.map(lineTokens =>
    lineTokens.map(t => {
      const style = t.color ? ` style="color:${t.color}"` : '';
      const fontStyle = t.fontStyle;
      // fontStyle flags: 1=italic, 2=bold, 4=underline
      let extra = style;
      if (fontStyle & 2) extra += ' class="shiki-bold"';
      return `<span${extra}>${esc(t.content)}</span>`;
    }).join('')
  );
  return { lines, bg: result.bg ?? 'transparent', fg: result.fg ?? null };
}

export { THEME_IMPORTS };
