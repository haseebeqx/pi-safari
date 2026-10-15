import { webURL } from './extraction.ts';
export interface Query { selector?: string; text?: string; limit?: number }
export function queryJS(query: Query, inspect = false): string {
  const { selector, text, limit = 20 } = query;
  if (selector !== undefined && (typeof selector !== 'string' || !selector.length || selector.length > 500)) throw Error('selector must be 1..500 characters.');
  if (text !== undefined && (typeof text !== 'string' || !text.length || text.length > 300)) throw Error('text must be 1..300 characters.');
  if (!selector && !text) throw Error('Provide selector or text.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw Error('limit must be 1..50.');
  return `JSON.stringify((()=>{
    const all=document.querySelectorAll(${JSON.stringify(selector ?? '*')});
    const matches=[]; let scanned=0; let truncated=false;
    for(const e of all){
      if(scanned++>=2000){truncated=true;break;}
      if(!e.getClientRects().length||getComputedStyle(e).visibility!=='visible'||getComputedStyle(e).display==='none')continue;
      const label=(e.getAttribute('aria-label')||e.innerText||e.textContent||'').slice(0,500);
      if(${JSON.stringify(text ?? '')}&&!label.toLocaleLowerCase().includes(${JSON.stringify((text ?? '').toLocaleLowerCase())}))continue;
      if(matches.length>=${inspect ? 2 : limit}){truncated=true;break;}
      const r=e.getBoundingClientRect();
      matches.push({tag:e.tagName.toLowerCase(),id:(e.id||'').slice(0,200),role:(e.getAttribute('role')||'').slice(0,100),name:label,
        type:(e.getAttribute('type')||'').slice(0,100),disabled:!!e.disabled,checked:!!e.checked,
        attributes:Object.fromEntries(['aria-label','aria-expanded','aria-checked','placeholder','title','href'].map(k=>[k,(e.getAttribute(k)||'').slice(0,500)])),
        rect:{x:r.x,y:r.y,width:r.width,height:r.height}});
    }
    ${inspect ? "if(matches.length!==1||truncated)throw Error('Inspect requires exactly one visible match within scan bound');" : ''}
    return {matches,scanned:Math.min(scanned,2000),truncated,scanLimit:2000};
  })())`;
}
export function waitJS(query: Query, expectedUrl: string): string {
  webURL(expectedUrl);
  // Reuse the bounded, fixed query; caller controls data, never executable source.
  return `JSON.stringify((()=>{if(location.href!==${JSON.stringify(expectedUrl)})throw Error('Page URL changed');const data=JSON.parse(${queryJS({ ...query, limit: 1 })});return {matched:data.matches.length>0,truncated:data.truncated};})())`;
}
