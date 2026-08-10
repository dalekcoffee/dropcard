// A status line for the export, owned by this bundle rather than by the app.
//
// Building a package takes a few seconds and reaches the network for typefaces, so a button
// that silently does nothing for four seconds reads as broken. Keeping the UI here means the
// patch into index.html stays to one handler swap, and everything with behaviour in it lives
// where it can be tested.
//
// Colours come from the app's own custom properties where they exist, so it follows the theme,
// with plain fallbacks for when this is dropped into a bare page.

import { downloadResonite } from './export.mjs';

const CSS = `
.dc-res-toast{position:fixed;right:18px;bottom:18px;z-index:2147483000;max-width:min(380px,calc(100vw - 36px));
  display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:12px;
  font:500 13px/1.45 var(--font-sans,system-ui,-apple-system,"Segoe UI",sans-serif);
  color:var(--color-text,#e9e9f2);background:var(--color-surface,#1b1b24);
  border:1px solid var(--color-divider,#33333f);box-shadow:0 10px 30px rgba(0,0,0,.35);
  opacity:0;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease}
.dc-res-toast[data-in]{opacity:1;transform:none}
.dc-res-toast b{display:block;font-weight:650;margin-bottom:2px}
.dc-res-toast small{display:block;opacity:.75;font-weight:450;margin-top:3px}
.dc-res-toast[data-kind=err]{border-color:#c0485a}
.dc-res-toast[data-kind=err] b{color:#ff8fa0}
.dc-res-dot{flex:none;width:9px;height:9px;border-radius:50%;margin-top:5px;
  background:var(--color-accent,#7755cc)}
.dc-res-toast[data-kind=work] .dc-res-dot{animation:dc-res-pulse 1s ease-in-out infinite}
.dc-res-toast[data-kind=ok] .dc-res-dot{background:#46b978}
.dc-res-toast[data-kind=err] .dc-res-dot{background:#e0566e}
.dc-res-x{flex:none;margin:-4px -6px 0 auto;padding:4px 6px;border:0;background:none;cursor:pointer;
  color:inherit;opacity:.55;font-size:15px;line-height:1;font-family:inherit}
.dc-res-x:hover{opacity:1}
@keyframes dc-res-pulse{0%,100%{opacity:.35}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dc-res-toast{transition:none}
  .dc-res-toast[data-kind=work] .dc-res-dot{animation:none}}
`;

let node = null, hideTimer = 0;

function toast() {
  if (node && node.isConnected) return node;
  if (!document.getElementById('dc-res-style')) {
    const s = document.createElement('style');
    s.id = 'dc-res-style'; s.textContent = CSS;
    document.head.appendChild(s);
  }
  node = document.createElement('div');
  node.className = 'dc-res-toast';
  node.setAttribute('role', 'status');
  node.innerHTML = '<span class="dc-res-dot"></span><span class="dc-res-body"></span>' +
                   '<button class="dc-res-x" type="button" aria-label="Dismiss">✕</button>';
  node.querySelector('.dc-res-x').addEventListener('click', hide);
  document.body.appendChild(node);
  requestAnimationFrame(() => node && node.setAttribute('data-in', ''));
  return node;
}

function show(kind, title, detail, autoHideMs) {
  const t = toast();
  t.dataset.kind = kind;
  t.querySelector('.dc-res-body').innerHTML = '';
  const b = document.createElement('b'); b.textContent = title;
  t.querySelector('.dc-res-body').appendChild(b);
  if (detail) { const s = document.createElement('small'); s.textContent = detail;
                t.querySelector('.dc-res-body').appendChild(s); }
  t.querySelector('.dc-res-x').style.display = kind === 'work' ? 'none' : '';
  clearTimeout(hideTimer);
  if (autoHideMs) hideTimer = setTimeout(hide, autoHideMs);
}

function hide() {
  clearTimeout(hideTimer);
  const t = node;
  if (!t) return;
  t.removeAttribute('data-in');
  setTimeout(() => { if (t === node) { t.remove(); node = null; } }, 220);
}

const STEP = {
  capture: 'Reading the card…',
  fonts: 'Fetching the typefaces…',
  build: 'Laying the card out in world…',
  encode: 'Writing the package…',
};

/**
 * Export and download, with the status line. Errors are shown rather than thrown, since there
 * is nothing above this to catch them.
 * @returns the report on success, or null if it failed
 */
export async function downloadWithStatus(opts = {}) {
  const label = opts.bake ? 'Baking the card' : 'Building the card';
  show('work', label, STEP.capture);
  try {
    const { filename, report } = await downloadResonite({
      ...opts,
      onProgress: (step, detail) => {
        if (step === 'note') return;                 // notes are reported at the end
        show('work', label, STEP[step] || detail);
      },
    });
    const bits = [`${report.widthMM}×${report.heightMM}mm`];
    if (!report.baked) bits.push(`${report.fonts} font${report.fonts === 1 ? '' : 's'}`);
    bits.push(`${(report.bytes / 1e6).toFixed(1)} MB`);
    const note = report.noPicture?.length
      ? 'No profile picture, so add-contact points at the empty frame.' : '';
    show('ok', `Saved ${filename}`, `${bits.join(' · ')}. Drag it into Resonite.${note ? ' ' + note : ''}`, 9000);
    return report;
  } catch (e) {
    console.error('[dropcard] Resonite export failed', e);
    const msg = String((e && e.message) || e);
    show('err', 'Export failed',
         /fetch|network|Failed to fetch|TrueType/i.test(msg)
           ? 'Could not fetch the typefaces this card uses. Check your connection, or use ' +
             '"Export baked", which needs no fonts.'
           : msg.slice(0, 200));
    return null;
  }
}
