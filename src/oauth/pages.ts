import { REGION_LABELS } from '../exact/regions.js';
import type { Region } from '../config.js';

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const shell = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}
a.btn{display:block;margin:.5rem 0;padding:.8rem 1rem;border:1px solid #ccc;border-radius:.5rem;text-decoration:none;color:inherit}
a.btn:hover{background:#f4f4f4}@media(prefers-color-scheme:dark){body{background:#161616;color:#eee}a.btn{border-color:#444}a.btn:hover{background:#222}}</style>
</head><body>${body}</body></html>`;

export const regionPage = (signedPending: string, regions: Region[]) =>
  shell('Connect Exact Online', `<h1>Connect Exact Online</h1><p>Where is your Exact Online administration hosted?</p>` +
    regions.map((r) => `<a class="btn" href="/exact/start?p=${encodeURIComponent(signedPending)}&amp;region=${r}">${esc(REGION_LABELS[r])}</a>`).join(''));

export const errorPage = (title: string, message: string) =>
  shell(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p><p>You can close this window and try again from Claude.</p>`);
