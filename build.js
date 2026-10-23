const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const htmlPath = path.join(root, 'public', 'index.html');
const cssPath = path.join(root, 'public', 'styles.css');
const jsPath = path.join(root, 'public', 'app.js');
const outputPath = path.join(root, 'ollama-commons.html');

let html = fs.readFileSync(htmlPath, 'utf8');
let css = fs.readFileSync(cssPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');

// Keep the output self-contained: Google Fonts are optional, so omit the remote
// import and let the local system font stack take over in the single-file build.
css = css.replace(/^@import\s+url\([^;]+;\s*/m, '');
html = html.replace(/\s*<link rel="stylesheet" href="\/styles\.css"\s*\/>/, `\n  <style>\n${css}\n  </style>`);
html = html.replace(/\s*<script src="\/app\.js" defer><\/script>/, `\n  <script>\n${js}\n  </script>`);

fs.writeFileSync(outputPath, html);
fs.writeFileSync(path.join(root, 'index.html'), html);
console.log(`Built GitHub Pages entry point: index.html`);
console.log(`Built standalone copy: ${path.basename(outputPath)}`);
console.log('Built static server directory and model-search page.');
