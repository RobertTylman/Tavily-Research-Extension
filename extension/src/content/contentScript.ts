/**
 * Content Script
 *
 * Two responsibilities:
 *   1. Read the user's text selection on demand (existing).
 *   2. Inject inline traffic-light fact-check annotations into the page DOM
 *      when the background worker pushes ANNOTATE_CLAIM events.
 *
 * Annotations wrap the matched sentence in a highlight span and append a
 * floating circular badge (🔴🟡🟢⚪). Clicking the badge opens a tooltip with
 * the verdict, summary, and top sources.
 *
 * Security note: this script runs in the page's main DOM but isolated from
 * page JS. It never touches API keys.
 */

import { ExtensionMessage, PageClaim, Verdict, VerdictLabel } from '../lib/types';

// ============================================================================
// TEXT SELECTION (existing functionality)
// ============================================================================

function getSelectedText(): string | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const text = selection.toString().trim();
  return text.length > 0 ? text : null;
}

/**
 * Extract the article text directly from the live DOM. We prefer the most
 * common semantic article containers and fall back to the body. Using DOM
 * text (rather than Tavily /extract) means the sentences the LLM picks are
 * guaranteed to exist verbatim where we'll search for them.
 */
function getArticleText(): { text: string; title: string; url: string } {
  const candidates: Array<HTMLElement | null> = [
    document.querySelector('article') as HTMLElement | null,
    document.querySelector('main') as HTMLElement | null,
    document.querySelector('[role="main"]') as HTMLElement | null,
    document.querySelector(
      '#content, .content, #main, .main, .article, .post'
    ) as HTMLElement | null,
    document.body,
  ];
  let chosen: HTMLElement = document.body;
  let chosenLen = 0;
  for (const el of candidates) {
    if (!el) continue;
    const t = el.innerText || '';
    if (t.length > chosenLen) {
      chosen = el;
      chosenLen = t.length;
      // Prefer the first sufficiently large semantic container.
      if (chosenLen > 1500 && el !== document.body) break;
    }
  }
  return {
    text: (chosen.innerText || '').trim(),
    title: document.title,
    url: location.href,
  };
}

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  switch (message.type) {
    case 'GET_SELECTED_TEXT': {
      sendResponse({ type: 'SELECTED_TEXT_RESPONSE', text: getSelectedText() } as ExtensionMessage);
      return false;
    }
    case 'GET_ARTICLE_TEXT': {
      sendResponse(getArticleText());
      return false;
    }
    case 'ANNOTATE_CLAIM': {
      ensureStyles();
      const ok = annotateClaim(message.claim, message.verdict);
      sendResponse({ ok });
      return false;
    }
    case 'CLEAR_ANNOTATIONS': {
      clearAnnotations();
      sendResponse({ ok: true });
      return false;
    }
    default:
      sendResponse({ error: 'Unknown message type' });
      return false;
  }
});

// ============================================================================
// ANNOTATION RENDERING
// ============================================================================

const HIGHLIGHT_CLASS = 'tavily-fc-highlight';
const BADGE_CLASS = 'tavily-fc-badge';
const TOOLTIP_CLASS = 'tavily-fc-tooltip';
const STYLE_ID = 'tavily-fc-styles';

interface ActiveAnnotation {
  claimId: string;
  highlightSpan: HTMLSpanElement;
  badge: HTMLButtonElement;
}

const activeAnnotations: ActiveAnnotation[] = [];
let openTooltip: HTMLDivElement | null = null;

function annotateClaim(claim: PageClaim, verdict: Verdict): boolean {
  // Avoid double-annotating the same claim if the message arrives twice.
  if (activeAnnotations.some((a) => a.claimId === claim.id)) return true;

  const range = findSentenceRange(claim.originalSentence);
  if (!range) {
    console.warn(
      '[FactChecker] Could not locate sentence in DOM:\n  Looking for:',
      claim.originalSentence,
      '\n  Claim:',
      claim.text
    );
    return false;
  }

  const tier = verdictTier(verdict);
  try {
    const highlightSpan = document.createElement('span');
    highlightSpan.className = `${HIGHLIGHT_CLASS} ${HIGHLIGHT_CLASS}--${tier}`;
    range.surroundContents(highlightSpan);

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = `${BADGE_CLASS} ${BADGE_CLASS}--${tier}`;
    badge.setAttribute('aria-label', `Fact check verdict: ${verdict.verdict}`);
    badge.title = `${verdict.verdict} — click for details`;
    badge.textContent = badgeIcon(tier);
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleTooltip(badge, claim, verdict);
    });

    highlightSpan.insertAdjacentElement('afterend', badge);
    activeAnnotations.push({ claimId: claim.id, highlightSpan, badge });
    console.log('[FactChecker] Annotated:', verdict.verdict, '—', claim.text.slice(0, 80));
    return true;
  } catch (error) {
    // surroundContents throws if the range partially crosses element
    // boundaries (e.g. claim text wraps an inline <a>/<strong>). Fall back
    // to splitting the range into per-text-node highlights so we never lose
    // the annotation entirely.
    console.warn('[FactChecker] surroundContents failed, splitting range:', error);
    return wrapRangeAcrossNodes(range, claim, verdict, tier);
  }
}

/**
 * Wrap a Range that straddles element boundaries by highlighting each text
 * node it intersects, then appending the badge after the last fragment.
 */
function wrapRangeAcrossNodes(
  range: Range,
  claim: PageClaim,
  verdict: Verdict,
  tier: TrafficTier
): boolean {
  const startContainer = range.startContainer as Text;
  const endContainer = range.endContainer as Text;
  if (startContainer.nodeType !== Node.TEXT_NODE || endContainer.nodeType !== Node.TEXT_NODE) {
    return insertFallbackBadge(range, claim, verdict, tier);
  }

  // Collect every text node fully or partially inside the range.
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT,
    null
  );
  const intersected: Text[] = [];
  let node: Node | null = walker.currentNode;
  while ((node = walker.nextNode())) {
    if (range.intersectsNode(node)) intersected.push(node as Text);
  }

  if (intersected.length === 0) {
    return insertFallbackBadge(range, claim, verdict, tier);
  }

  let lastSpan: HTMLSpanElement | null = null;
  for (const text of intersected) {
    const fromOffset = text === startContainer ? range.startOffset : 0;
    const toOffset = text === endContainer ? range.endOffset : (text.nodeValue ?? '').length;
    if (toOffset <= fromOffset) continue;

    const slice = document.createRange();
    try {
      slice.setStart(text, fromOffset);
      slice.setEnd(text, toOffset);
      const span = document.createElement('span');
      span.className = `${HIGHLIGHT_CLASS} ${HIGHLIGHT_CLASS}--${tier}`;
      slice.surroundContents(span);
      lastSpan = span;
    } catch {
      // Skip this fragment; keep going.
    }
  }

  if (!lastSpan) return false;

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = `${BADGE_CLASS} ${BADGE_CLASS}--${tier}`;
  badge.title = `${verdict.verdict} — click for details`;
  badge.textContent = badgeIcon(tier);
  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    toggleTooltip(badge, claim, verdict);
  });
  lastSpan.insertAdjacentElement('afterend', badge);

  activeAnnotations.push({ claimId: claim.id, highlightSpan: lastSpan, badge });
  console.log('[FactChecker] Annotated (split):', verdict.verdict, '—', claim.text.slice(0, 80));
  return true;
}

function insertFallbackBadge(
  range: Range,
  claim: PageClaim,
  verdict: Verdict,
  tier: TrafficTier
): boolean {
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = `${BADGE_CLASS} ${BADGE_CLASS}--${tier}`;
  badge.title = `${verdict.verdict} — click for details`;
  badge.textContent = badgeIcon(tier);
  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    toggleTooltip(badge, claim, verdict);
  });

  const anchor = range.startContainer.parentElement;
  if (!anchor) return false;
  anchor.appendChild(badge);
  activeAnnotations.push({
    claimId: claim.id,
    highlightSpan: anchor as unknown as HTMLSpanElement,
    badge,
  });
  return true;
}

function clearAnnotations(): void {
  for (const annotation of activeAnnotations) {
    // Unwrap the highlight span if it's actually a span we created.
    const span = annotation.highlightSpan;
    if (span.classList?.contains(HIGHLIGHT_CLASS)) {
      const parent = span.parentNode;
      if (parent) {
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
      }
    }
    annotation.badge.remove();
  }
  activeAnnotations.length = 0;
  closeTooltip();
}

// ============================================================================
// DOM SENTENCE MATCHING
// ============================================================================

/**
 * Find a Range covering the given sentence in the document body.
 * Handles whitespace normalization and text-node fragmentation.
 * Skips already-annotated regions.
 */
function findSentenceRange(sentence: string): Range | null {
  const target = normalizeWhitespace(sentence);
  if (target.length < 4) return null;

  // Walk all text nodes inside the body, accumulating their normalized text
  // until we find the target as a substring. Then map back to a Range.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue || node.nodeValue.trim().length === 0) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // Skip script/style and our own annotation chrome.
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT')
        return NodeFilter.FILTER_REJECT;
      if (parent.closest(`.${BADGE_CLASS}, .${TOOLTIP_CLASS}`)) return NodeFilter.FILTER_REJECT;
      // Skip hidden subtrees.
      if (parent.offsetParent === null && parent.tagName !== 'BODY') {
        // offsetParent null often means hidden, but BODY itself can be null —
        // be permissive at the BODY level.
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden')
          return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  // Collect text nodes with running offsets in the normalized concatenation.
  interface Slot {
    node: Text;
    /** Normalized text contributed by this node (single-spaced). */
    norm: string;
    /** Offset (within normalized concatenation) where this node starts. */
    start: number;
  }
  const slots: Slot[] = [];
  let combined = '';

  let textNode: Node | null;
  while ((textNode = walker.nextNode())) {
    const node = textNode as Text;
    const raw = node.nodeValue ?? '';
    const norm = normalizeWhitespace(raw);
    if (norm.length === 0) continue;
    // Insert a space between nodes if the previous combined doesn't already end with one.
    if (combined.length > 0 && !combined.endsWith(' ')) combined += ' ';
    const start = combined.length;
    combined += norm;
    slots.push({ node, norm, start });
  }

  const idx = combined.indexOf(target);
  if (idx === -1) return null;

  const targetEnd = idx + target.length;

  // Find the slots that cover [idx, targetEnd) and convert back into a Range
  // anchored on the original (un-normalized) text nodes.
  let startSlot: Slot | null = null;
  let endSlot: Slot | null = null;
  let startOffsetInSlotNorm = 0;
  let endOffsetInSlotNorm = 0;

  for (const slot of slots) {
    const slotEnd = slot.start + slot.norm.length;
    if (startSlot === null && slotEnd > idx) {
      startSlot = slot;
      startOffsetInSlotNorm = idx - slot.start;
    }
    if (slotEnd >= targetEnd) {
      endSlot = slot;
      endOffsetInSlotNorm = targetEnd - slot.start;
      break;
    }
  }

  if (!startSlot || !endSlot) return null;

  const startRawOffset = mapNormalizedOffsetToRaw(
    startSlot.node.nodeValue ?? '',
    startOffsetInSlotNorm
  );
  const endRawOffset = mapNormalizedOffsetToRaw(endSlot.node.nodeValue ?? '', endOffsetInSlotNorm);

  const range = document.createRange();
  try {
    range.setStart(
      startSlot.node,
      Math.max(0, Math.min(startRawOffset, (startSlot.node.nodeValue ?? '').length))
    );
    range.setEnd(
      endSlot.node,
      Math.max(0, Math.min(endRawOffset, (endSlot.node.nodeValue ?? '').length))
    );
  } catch {
    return null;
  }
  return range;
}

/**
 * Given a raw text node value and an offset measured in its normalized
 * (single-spaced, trimmed) form, return the equivalent offset in the raw text.
 */
function mapNormalizedOffsetToRaw(raw: string, normalizedOffset: number): number {
  let normIdx = 0;
  let lastWasSpace = true; // matches behavior of trim-leading-whitespace
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const isSpace = /\s/.test(ch);
    if (isSpace) {
      if (lastWasSpace) continue;
      lastWasSpace = true;
      if (normIdx === normalizedOffset) return i;
      normIdx += 1; // counts as one normalized space
    } else {
      lastWasSpace = false;
      if (normIdx === normalizedOffset) return i;
      normIdx += 1;
    }
  }
  return raw.length;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ============================================================================
// TOOLTIP
// ============================================================================

function toggleTooltip(badge: HTMLButtonElement, claim: PageClaim, verdict: Verdict): void {
  if (openTooltip && openTooltip.dataset.claimId === claim.id) {
    closeTooltip();
    return;
  }
  closeTooltip();

  const tooltip = document.createElement('div');
  tooltip.className = TOOLTIP_CLASS;
  tooltip.dataset.claimId = claim.id;

  const tier = verdictTier(verdict);
  const tierLabel: Record<TrafficTier, string> = {
    green: 'Supported',
    yellow: 'Mixed / Low confidence',
    red: 'False',
    gray: 'Insufficient evidence',
  };

  const header = document.createElement('div');
  header.className = `${TOOLTIP_CLASS}__header ${TOOLTIP_CLASS}__header--${tier}`;
  header.innerHTML = `<span>${escapeHtml(badgeIcon(tier))}</span> <strong>${escapeHtml(tierLabel[tier])}</strong> <span class="${TOOLTIP_CLASS}__confidence">${Math.round(verdict.confidence * 100)}%</span>`;
  tooltip.appendChild(header);

  const claimText = document.createElement('div');
  claimText.className = `${TOOLTIP_CLASS}__claim`;
  claimText.textContent = claim.text;
  tooltip.appendChild(claimText);

  if (verdict.summary || verdict.explanation) {
    const summary = document.createElement('div');
    summary.className = `${TOOLTIP_CLASS}__summary`;
    summary.textContent = verdict.summary || verdict.explanation;
    tooltip.appendChild(summary);
  }

  const sources = (verdict.citations || []).slice(0, 3);
  if (sources.length > 0) {
    const sourcesEl = document.createElement('div');
    sourcesEl.className = `${TOOLTIP_CLASS}__sources`;
    sourcesEl.textContent = 'Sources:';
    const list = document.createElement('ol');
    for (const src of sources) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = src.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = src.title || src.source;
      li.appendChild(a);
      list.appendChild(li);
    }
    sourcesEl.appendChild(list);
    tooltip.appendChild(sourcesEl);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = `${TOOLTIP_CLASS}__close`;
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTooltip();
  });
  tooltip.appendChild(close);

  document.body.appendChild(tooltip);
  positionTooltip(tooltip, badge);
  openTooltip = tooltip;

  // Dismiss on outside click.
  setTimeout(() => {
    document.addEventListener('click', dismissOnOutsideClick, { once: true });
  }, 0);
}

function dismissOnOutsideClick(e: MouseEvent): void {
  if (!openTooltip) return;
  if (e.target instanceof Node && openTooltip.contains(e.target)) {
    document.addEventListener('click', dismissOnOutsideClick, { once: true });
    return;
  }
  closeTooltip();
}

function closeTooltip(): void {
  if (openTooltip) {
    openTooltip.remove();
    openTooltip = null;
  }
}

function positionTooltip(tooltip: HTMLElement, badge: HTMLElement): void {
  const rect = badge.getBoundingClientRect();
  const tooltipWidth = 320;
  const margin = 8;
  let left = rect.left + window.scrollX;
  if (left + tooltipWidth > window.scrollX + window.innerWidth - margin) {
    left = window.scrollX + window.innerWidth - tooltipWidth - margin;
  }
  if (left < window.scrollX + margin) left = window.scrollX + margin;

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${rect.bottom + window.scrollY + 6}px`;
  tooltip.style.width = `${tooltipWidth}px`;
}

// ============================================================================
// VERDICT → TRAFFIC LIGHT
// ============================================================================

type TrafficTier = 'green' | 'yellow' | 'red' | 'gray';

function verdictTier(verdict: Verdict): TrafficTier {
  const label: VerdictLabel = verdict.verdict;
  if (label === 'INSUFFICIENT_EVIDENCE') return 'gray';
  if (label === 'MISLEADING') return 'yellow';
  if (label === 'FALSE') return verdict.confidence >= 0.5 ? 'red' : 'yellow';
  if (label === 'SUPPORTED') return verdict.confidence >= 0.5 ? 'green' : 'yellow';
  return 'gray';
}

function badgeIcon(tier: TrafficTier): string {
  switch (tier) {
    case 'green':
      return '✓';
    case 'red':
      return '✗';
    case 'yellow':
      return '!';
    case 'gray':
      return '?';
  }
}

// ============================================================================
// STYLES (injected once)
// ============================================================================

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      border-radius: 3px;
      padding: 0 1px;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    .${HIGHLIGHT_CLASS}--green  { background: rgba(76, 175, 80, 0.18); border-bottom: 2px solid #4CAF50; }
    .${HIGHLIGHT_CLASS}--yellow { background: rgba(255, 193, 7, 0.22); border-bottom: 2px solid #FFC107; }
    .${HIGHLIGHT_CLASS}--red    { background: rgba(244, 67, 54, 0.18); border-bottom: 2px solid #F44336; }
    .${HIGHLIGHT_CLASS}--gray   { background: rgba(158, 158, 158, 0.18); border-bottom: 2px solid #9E9E9E; }

    .${BADGE_CLASS} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      margin-left: 4px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      color: white;
      vertical-align: middle;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      transition: transform 120ms ease;
    }
    .${BADGE_CLASS}:hover { transform: scale(1.15); }
    .${BADGE_CLASS}--green  { background: #4CAF50; }
    .${BADGE_CLASS}--yellow { background: #FFC107; color: #3a2c00; }
    .${BADGE_CLASS}--red    { background: #F44336; }
    .${BADGE_CLASS}--gray   { background: #9E9E9E; }

    .${TOOLTIP_CLASS} {
      position: absolute;
      z-index: 2147483647;
      background: #ffffff;
      color: #1a1a1a;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      padding: 12px 14px 14px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      line-height: 1.45;
    }
    .${TOOLTIP_CLASS}__header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      margin-bottom: 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid #f0f0f0;
    }
    .${TOOLTIP_CLASS}__header--green  strong { color: #2e7d32; }
    .${TOOLTIP_CLASS}__header--yellow strong { color: #b58100; }
    .${TOOLTIP_CLASS}__header--red    strong { color: #c62828; }
    .${TOOLTIP_CLASS}__header--gray   strong { color: #616161; }
    .${TOOLTIP_CLASS}__confidence {
      margin-left: auto;
      margin-right: 18px;
      font-size: 11px;
      color: #777;
      font-weight: 600;
    }
    .${TOOLTIP_CLASS}__claim {
      font-weight: 600;
      margin-bottom: 6px;
      color: #1a1a1a;
    }
    .${TOOLTIP_CLASS}__summary {
      color: #4a4a4a;
      margin-bottom: 8px;
    }
    .${TOOLTIP_CLASS}__sources {
      font-size: 12px;
      color: #4a4a4a;
    }
    .${TOOLTIP_CLASS}__sources ol {
      margin: 4px 0 0 18px;
      padding: 0;
    }
    .${TOOLTIP_CLASS}__sources a {
      color: #1565c0;
      text-decoration: none;
    }
    .${TOOLTIP_CLASS}__sources a:hover { text-decoration: underline; }
    .${TOOLTIP_CLASS}__close {
      position: absolute;
      top: 4px;
      right: 6px;
      background: none;
      border: none;
      font-size: 18px;
      line-height: 1;
      color: #888;
      cursor: pointer;
      padding: 4px 6px;
    }
    .${TOOLTIP_CLASS}__close:hover { color: #222; }

    @media (prefers-color-scheme: dark) {
      .${TOOLTIP_CLASS} {
        background: #1f2937;
        color: #f1f5f9;
        border-color: #374151;
      }
      .${TOOLTIP_CLASS}__header { border-bottom-color: #374151; }
      .${TOOLTIP_CLASS}__claim { color: #f1f5f9; }
      .${TOOLTIP_CLASS}__summary,
      .${TOOLTIP_CLASS}__sources { color: #cbd5e1; }
      .${TOOLTIP_CLASS}__sources a { color: #60a5fa; }
    }
  `;
  document.head.appendChild(style);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================================
// SELECTION CHANGE LISTENER (existing)
// ============================================================================

let lastSelection: string | null = null;

document.addEventListener('selectionchange', () => {
  const currentSelection = getSelectedText();
  if (currentSelection !== lastSelection) {
    lastSelection = currentSelection;
  }
});

console.log('[FactChecker] Content script loaded');
