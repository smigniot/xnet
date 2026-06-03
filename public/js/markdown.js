// markdown.js
// -----------
// A deliberately tiny Markdown -> HTML renderer. It escapes ALL HTML first,
// then re-introduces a safe subset of formatting. Because raw input is escaped
// up front, user messages can never inject markup or scripts.

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(s) {
  // links: [text](http...)   -- only http/https, escaped.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, text, url) =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  // bold, italic, inline code, strikethrough
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s;
}

export function renderMarkdown(src) {
  const escaped = escapeHtml(src);
  const lines = escaped.split('\n');
  const out = [];
  let inCode = false;
  let inList = false;
  let codeBuf = [];

  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const line of lines) {
    const fence = line.trim().startsWith('```');
    if (fence) {
      if (inCode) {
        out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    if (/^#{1,3}\s+/.test(line)) {
      closeList();
      const level = line.match(/^#+/)[0].length;
      out.push(`<h${level}>${inline(line.replace(/^#+\s+/, ''))}</h${level}>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inCode) out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);
  closeList();
  return out.join('\n');
}
