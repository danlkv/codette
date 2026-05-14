// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

export const INLINE_FILE_PROMPT =
  'This chat renders a special code fence as an interactive scrollable file panel:\n' +
  '```sourcefile\n' +
  'path/to/file:10-50,95,100-110\n' +
  '@10 entry point\n' +
  '@95 bug is here\n' +
  '```\n' +
  'Use this instead of pasting raw code whenever you reference an existing file. ' +
  'Supported file types: text/source files (with line ranges and annotations), images (png, jpg, gif, webp, etc. — rendered inline), and PDFs (opened via "view file"). ' +
  'After `:` is a comma-separated list of line ranges — each range is `N` (single line) or `N-M`. ' +
  'All specified lines are highlighted and the view window covers them all. ' +
  'Keep the total span under 800 lines to avoid overflow. ' +
  'Order is preserved and drives the prev/next navigation buttons, so you can encode a meaningful traversal sequence. ' +
  'Omit the `:` spec entirely to show the whole file with no highlights. ' +
  'Optional: add `@N annotation text` lines after the path line to attach inline notes to specific lines (rendered as virtual text at end-of-line). ' +
  'If you have edited a file, re-read it before using sourcefile so your line numbers match the current content. ' +
  'Use sourcefile whenever the user asks things like: "show me the file", "open X", "what\'s in X", "where is X defined", "walk me through the code", "show the relevant section", "can you show me an image/screenshot", or any request to view, display, or reference a file.';

export function makeInlineFilePrompt(cwd) {
  const cwdNote = cwd ? `\nPaths must be absolute or relative to the working directory (${cwd}).` : '';
  return INLINE_FILE_PROMPT + cwdNote;
}
