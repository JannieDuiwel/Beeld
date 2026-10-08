/** Panel contract: markup, scripts, stylesheets and CSP agree, and the old look is gone. */
const path = require('path'), fs = require('fs');

const root = path.join(__dirname, '..', 'src', 'renderer');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(root, ...p));
const html = read('panel', 'index.html');
const js = read('panel', 'panel.js') + '\n' + read('panel', 'tools.js');
const panelCss = exists('panel', 'panel.css') ? read('panel', 'panel.css') : '';
const kit = (name) => (exists('shared', 'ui-kit', name) ? read('shared', 'ui-kit', name) : '');
const csp = (html.match(/Content-Security-Policy"\s*content="([^"]*)"/) || [, ''])[1];

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name.padEnd(58) + got + (ok ? '' : '   expected ' + want));
};

// Every id the scripts look up must exist in the markup.
const used = [
  ...js.matchAll(/\bel\('([^']+)'\)/g), ...js.matchAll(/\$\('([^']+)'\)/g), ...js.matchAll(/getElementById\('([^']+)'\)/g),
].map((m) => m[1]);
const missingIds = [...new Set(used)].filter((id) => !new RegExp(`id="${id}"`).test(html));
check('every id the scripts look up exists in the markup', missingIds.join(',') || 'none', 'none');

// Every class the markup and the scripts' templates emit is defined by something we ship.
const defined = new Set([...(kit('components.css') + kit('shells.css') + panelCss).matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const classes = new Set();
for (const m of (html + js).matchAll(/class="([^"$]*)"/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
for (const m of js.matchAll(/className\s*=\s*'([^']*)'/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
const undef = [...classes].filter((c) => !defined.has(c));
check('every class used is defined by the kit or panel.css', undef.join(',') || 'none', 'none');

check('no inline <style> block', /<style[\s>]/.test(html), false);
check('CSP keeps its own-origin styles and names no remote origin', /style-src 'self' 'unsafe-inline'/.test(csp) && !/https?:/.test(csp), true);
check('kit and panel stylesheets are linked',
  ['tokens', 'components', 'shells'].every((n) => html.includes(`shared/ui-kit/${n}.css`)) && html.includes('href="panel.css"'), true);
check('panel.css has no hard-coded colours', (panelCss.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) || []).length, 0);
check('panel.css has no gradient, shadow or blur', /gradient|box-shadow|backdrop-filter|blur\(/.test(panelCss), false);
check('no old blue accent anywhere in the panel files', /6ea8fe|#2d4a7a/i.test(html + js + panelCss), false);
check('the old tab and sheet classes are gone', /\bclass="tab on"|\btabbody\b|\bclass="sheet"/.test(html + js), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
