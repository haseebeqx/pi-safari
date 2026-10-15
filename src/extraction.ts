export const MAX_OUTPUT = 48 * 1024;
export function bound(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_OUTPUT) throw new Error('Safari output exceeded 48 KiB; request smaller limits.');
  return text;
}
export function webURL(url: string): string {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || url.length > 8192) throw new Error('Only HTTP(S) URLs without embedded credentials are allowed.');
  return u.href;
}

export function readyJS(expectedUrl: string): string {
  return `location.href===${JSON.stringify(expectedUrl)} && document.readyState==='complete'`;
}
// This script only extracts data. It never clicks, dispatches events, sets markers,
// or navigates the source context, regardless of its provenance or replacement.
export function linkJS(selector: string, expectedUrl: string): string {
  if (selector.length < 1 || selector.length > 500) throw new Error('CSS selector must be 1..500 characters.');
  webURL(expectedUrl);
  return `JSON.stringify((()=>{if(location.href!==${JSON.stringify(expectedUrl)})throw Error('Page URL changed; read again');const es=document.querySelectorAll(${JSON.stringify(selector)});if(es.length!==1)throw Error('Selector must match exactly one element');const e=es[0];if(!e.matches('a[href]'))throw Error('Selector must match a link');if(!e.getClientRects().length||getComputedStyle(e).visibility!=='visible'||getComputedStyle(e).display==='none')throw Error('Link hidden');const u=new URL(e.href);if(!/^https?:$/.test(u.protocol)||u.username||u.password)throw Error('Only HTTP(S) links without credentials are allowed');return {href:u.href}})())`;
}
export function readJS(chars: number, links: number): string {
  if (!Number.isInteger(chars) || chars < 1 || chars > 12000 || !Number.isInteger(links) || links < 0 || links > 40) throw new Error('maxChars must be 1..12000; maxLinks must be 0..40.');
  return `JSON.stringify((()=>{const text=document.body?.innerText||''; const links=Array.from(document.querySelectorAll('a[href]')).filter(a=>a.getClientRects().length&&getComputedStyle(a).visibility==='visible'&&getComputedStyle(a).display!=='none'); return {url:location.href.slice(0,2048),title:document.title.slice(0,300),readyState:document.readyState,text:text.slice(0,${chars}),textTruncated:text.length>${chars},links:links.slice(0,${links}).map((a,index)=>({index,text:(a.innerText||a.textContent||'').slice(0,120),href:a.href.slice(0,1024)})),linksTruncated:links.length>${links}}})())`;
}
