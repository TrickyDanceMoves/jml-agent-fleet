'use strict';

// Shared, self-contained markdown renderer for agent replies. Mirrors the main
// console's renderer so the docked/overlay agent chat renders the same prose
// (headings, lists, tables, code, bold/italic/links) plus the risk/delete
// colour cues - instead of raw markdown text.
// Exposed as window.JMLMarkdown.render(text).
(function (global) {
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function inlineMarkdown(text) {
    return escHtml(text)
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/✅/g, '<span class="md-check">✅</span>')
      .replace(/❌/g, '<span class="md-cross">❌</span>')
      .replace(/⚠️/g, '<span class="md-warn">⚠️</span>');
  }

  function _riskClass(level) {
    const l = String(level).toLowerCase();
    if (l === 'critical') return 'risk-critical';
    if (l === 'high') return 'risk-high';
    if (l === 'medium' || l === 'moderate' || l === 'elevated') return 'risk-medium';
    return 'risk-low';
  }

  function colorizeAgentHtml(html) {
    const LVL = 'critical|high|medium|moderate|elevated|low|minimal';
    html = html.replace(new RegExp(`<strong>(${LVL})(\\s+risk)?</strong>`, 'gi'),
      (m, lvl, rest) => `<strong class="${_riskClass(lvl)}">${lvl}${rest || ''}</strong>`);
    return html.split(/(<[^>]+>)/).map(seg => {
      if (seg.startsWith('<')) return seg;
      return seg
        .replace(new RegExp(`\\b(${LVL})(\\s+risk)\\b`, 'gi'),
          (m, lvl, rest) => `<span class="${_riskClass(lvl)}">${lvl}${rest}</span>`)
        .replace(new RegExp(`\\b(risk(?:\\s+(?:level|score|rating))?\\s*[:\\u2013\\u2014]\\s*)(${LVL})\\b`, 'gi'),
          (m, pre, lvl) => `${pre}<span class="${_riskClass(lvl)}">${lvl}</span>`)
        .replace(/\b(permanently delete|deletion|deleted|delete)\b/gi,
          m => `<span class="op-delete">${m}</span>`);
    }).join('');
  }

  function render(text) {
    const lines = String(text == null ? '' : text).split('\n');
    const out = [];
    let i = 0;
    const isBullet = l => /^\s*[-*•]\s/.test(l);
    const isNumList = l => /^\s*\d+\.\s/.test(l);
    const isTaskItem = l => /^\s*[-*]\s+\[[ xX]\]\s/.test(l);
    const isBlockq = l => /^\s*>\s?/.test(l);

    while (i < lines.length) {
      const line = lines[i].trimEnd();
      if (!line.trim()) { i++; continue; }

      const hm = line.match(/^(#{1,3})\s+(.+)/);
      if (hm) { out.push('<div class="md-h' + hm[1].length + '">' + inlineMarkdown(hm[2]) + '</div>'); i++; continue; }

      if (/^[-*]{3,}$/.test(line.trim())) { out.push('<div class="md-hr"></div>'); i++; continue; }

      if (isBlockq(line)) {
        const bq = [];
        while (i < lines.length && isBlockq(lines[i])) { bq.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push('<div class="md-blockquote">' + inlineMarkdown(bq.join(' ')) + '</div>');
        continue;
      }

      if (line.trim().startsWith('|')) {
        const tableLines = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) { tableLines.push(lines[i]); i++; }
        const rows = tableLines.filter(l => !/^\s*\|[\s\-:|]+\|\s*$/.test(l));
        if (rows.length) {
          const parseRow = l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
          const [header, ...body] = rows;
          out.push('<div class="md-table-wrap"><table class="md-table">');
          out.push('<thead><tr>' + parseRow(header).map(c => '<th>' + inlineMarkdown(c) + '</th>').join('') + '</tr></thead>');
          if (body.length) {
            out.push('<tbody>');
            body.forEach(r => out.push('<tr>' + parseRow(r).map(c => '<td>' + inlineMarkdown(c) + '</td>').join('') + '</tr>'));
            out.push('</tbody>');
          }
          out.push('</table></div>');
        }
        continue;
      }

      if (isTaskItem(line)) {
        out.push('<ul class="md-list">');
        while (i < lines.length && isTaskItem(lines[i])) {
          const done = /^\s*[-*]\s+\[[xX]\]/.test(lines[i]);
          const body = lines[i].replace(/^\s*[-*]\s+\[[ xX]\]\s*/, '');
          out.push('<li><span class="md-task-check">' + (done ? '☑' : '☐') + '</span>'
            + '<span class="' + (done ? 'md-task-done' : '') + '">' + inlineMarkdown(body) + '</span></li>');
          i++;
        }
        out.push('</ul>');
        continue;
      }

      if (isBullet(line)) {
        out.push('<ul class="md-list">');
        while (i < lines.length && isBullet(lines[i])) { out.push('<li>' + inlineMarkdown(lines[i].replace(/^\s*[-*•]\s+/, '')) + '</li>'); i++; }
        out.push('</ul>');
        continue;
      }

      if (isNumList(line)) {
        out.push('<ol class="md-list">');
        while (i < lines.length && isNumList(lines[i])) { out.push('<li>' + inlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>'); i++; }
        out.push('</ol>');
        continue;
      }

      if (/^```/.test(line)) {
        const lang = line.replace(/^```/, '').trim();
        const codeLines = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
        i++;
        out.push('<pre' + (lang ? ' data-lang="' + escHtml(lang) + '"' : '') + '><code>' + escHtml(codeLines.join('\n')) + '</code></pre>');
        continue;
      }

      out.push('<p class="md-p">' + inlineMarkdown(line) + '</p>');
      i++;
    }
    return colorizeAgentHtml(out.join(''));
  }

  global.JMLMarkdown = { render: render, inline: inlineMarkdown };
})(typeof window !== 'undefined' ? window : this);
