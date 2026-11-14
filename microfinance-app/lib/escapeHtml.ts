const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes a value for use as text (or a quoted attribute) in an HTML email body. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** escapeHtml, then keeps the author's line breaks as <br>. */
export function escapeHtmlMultiline(value: unknown): string {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, '<br>');
}
