// Builds the short Make-ready email report and matching text report for each generated label.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function compact(value, fallback = '-') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function templateLabel(templateType) {
  return {
    normal: 'Normaal label',
    frozen: 'Diepvries label',
    fisheryFrozen: 'Diepvries visserijproduct label'
  }[templateType] || compact(templateType);
}

function statusLabel(reviewRequired) {
  return reviewRequired ? 'Review nodig' : 'Geen reviewpunten';
}

function reviewSummary(reviewItems, maxItems = 6) {
  return (reviewItems || []).slice(0, maxItems).map((item, index) => {
    const notes = (item.notes || [])
      .filter(Boolean)
      .slice(0, 4)
      .map((note) => `   - ${compact(note)}`)
      .join('\n');

    return [
      `${index + 1}. ${compact(item.field)}: ${compact(item.reason)}`,
      notes
    ].filter(Boolean).join('\n');
  });
}

function reviewSummaryHtml(reviewItems, maxItems = 6) {
  return (reviewItems || []).slice(0, maxItems).map((item) => {
    const notes = (item.notes || [])
      .filter(Boolean)
      .slice(0, 4)
      .map((note) => `<li>${escapeHtml(compact(note))}</li>`)
      .join('');
    return `<li><strong>${escapeHtml(compact(item.field))}</strong>: ${escapeHtml(compact(item.reason))}${notes ? `<ul>${notes}</ul>` : ''}</li>`;
  }).join('');
}

function moreReviewItemsLine(reviewItems, maxItems = 6) {
  const extra = Math.max(0, (reviewItems || []).length - maxItems);
  return extra ? `Plus ${extra} extra reviewpunt(en) in de JSON-response/run-log.` : '';
}

function moreReviewItemsHtml(reviewItems, maxItems = 6) {
  const extra = Math.max(0, (reviewItems || []).length - maxItems);
  return extra ? `<p>Plus ${extra} extra reviewpunt(en) in de JSON-response/run-log.</p>` : '';
}

function outputReference(run) {
  return run.sharePointWebUrl || run.sharePointOutputPath || '';
}

export function buildEmailReport(run) {
  const spec = run.spec || {};
  const reviewRequired = Boolean(run.reviewRequired);
  const reviewItems = run.reviewItems || [];
  const product = compact(spec.legalProduct || spec.description);
  const articleNumber = compact(spec.articleNumber);
  const subject = `Label ${articleNumber} - ${statusLabel(reviewRequired).toLowerCase()}`;
  const output = outputReference(run);
  const reviewed = reviewSummary(reviewItems);
  const moreLine = moreReviewItemsLine(reviewItems);

  const textLines = [
    `Label rapportage - ${statusLabel(reviewRequired)}`,
    '',
    `Artikelnummer: ${articleNumber}`,
    `Product: ${product}`,
    `Merk: ${compact(spec.brand)}`,
    `Leverancier: ${compact(spec.supplierNumber)}`,
    `Sjabloon: ${templateLabel(spec.templateType)}`,
    `Run ID: ${compact(run.runId)}`,
    output ? `Output: ${output}` : '',
    '',
    'Kleurcodering in het label:',
    '- Groen: automatisch ingevuld of afkomstig uit Labels_13_talen.xlsx.',
    '- Paars: OpenAI fallback/research met hoge zekerheid, maar niet afkomstig uit de database.',
    '- Rood: niet betrouwbaar in de database gevonden en onzeker/fallback-error/manual-required.',
    '- Ingredientendeclaraties worden per herkende term groen/paars/rood gemarkeerd.',
    '',
    reviewRequired ? `Reviewpunten (${reviewItems.length}):` : 'Reviewpunten: geen.',
    ...reviewed,
    moreLine
  ].filter((line) => line !== '');

  const html = [
    '<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.45; color: #1f2937;">',
    `<h2 style="margin: 0 0 12px;">Label rapportage - ${escapeHtml(statusLabel(reviewRequired))}</h2>`,
    '<table style="border-collapse: collapse; margin-bottom: 14px;">',
    `<tr><td style="padding: 2px 12px 2px 0;"><strong>Artikelnummer</strong></td><td>${escapeHtml(articleNumber)}</td></tr>`,
    `<tr><td style="padding: 2px 12px 2px 0;"><strong>Product</strong></td><td>${escapeHtml(product)}</td></tr>`,
    `<tr><td style="padding: 2px 12px 2px 0;"><strong>Merk</strong></td><td>${escapeHtml(compact(spec.brand))}</td></tr>`,
    `<tr><td style="padding: 2px 12px 2px 0;"><strong>Leverancier</strong></td><td>${escapeHtml(compact(spec.supplierNumber))}</td></tr>`,
    `<tr><td style="padding: 2px 12px 2px 0;"><strong>Sjabloon</strong></td><td>${escapeHtml(templateLabel(spec.templateType))}</td></tr>`,
    `<tr><td style="padding: 2px 12px 2px 0;"><strong>Run ID</strong></td><td>${escapeHtml(compact(run.runId))}</td></tr>`,
    output ? `<tr><td style="padding: 2px 12px 2px 0;"><strong>Output</strong></td><td>${escapeHtml(output)}</td></tr>` : '',
    '</table>',
    '<p><strong>Kleurcodering:</strong> groen = automatisch ingevuld of uit Labels_13_talen.xlsx; paars = AI fallback/research met hoge zekerheid; rood = onzeker/fallback-error/manual-required. Ingredientendeclaraties worden per herkende term gemarkeerd.</p>',
    reviewRequired
      ? `<p><strong>Reviewpunten (${reviewItems.length})</strong></p><ol>${reviewSummaryHtml(reviewItems)}</ol>${moreReviewItemsHtml(reviewItems)}`
      : '<p><strong>Reviewpunten:</strong> geen.</p>',
    '</div>'
  ].join('');

  return {
    subject,
    text: textLines.join('\n'),
    html
  };
}
