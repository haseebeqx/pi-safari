import { webURL } from './extraction.ts';

// DuckDuckGo HTML's documented URL controls; deliberately not arbitrary provider parameters.
export const REGIONS = ['wt-wt', 'us-en', 'uk-en', 'ca-en', 'au-en', 'de-de', 'fr-fr', 'in-en', 'jp-jp'] as const;
export const TIMES = ['any', 'd', 'w', 'm', 'y'] as const;
export const PAGE_LIMIT = 30;
const PAGER_LIMIT = 12;
// Caller-supplied CSS selectors that steer the generic extractor. CSS only: no JS, no attributes beyond :(), no forms/clicks.
export interface SearchSelectors { item: string; link?: string; title?: string; snippet?: string }
export interface SearchOptions { query?: string; url?: string; region?: string; time?: string; selectors?: SearchSelectors }
export interface SearchRequest {
  mode: 'ddg' | 'generic';
  url: string;
  query?: string;
  region?: string;
  time?: string;
  selectors?: SearchSelectors;
}
export function validateSelectors(selectors: unknown): SearchSelectors {
  if (typeof selectors !== 'object' || selectors === null || Array.isArray(selectors)) throw Error('selectors must be an object with an item CSS selector.');
  const s = selectors as Record<string, unknown>;
  if (typeof s.item !== 'string' || s.item.trim().length < 1) throw Error('selectors.item is required when selectors are supplied.');
  const out: SearchSelectors = { item: s.item.trim() };
  for (const key of ['link', 'title', 'snippet'] as const) {
    if (s[key] === undefined) continue;
    if (typeof s[key] !== 'string') throw Error(`selectors.${key} must be a CSS selector string.`);
    out[key] = (s[key] as string).trim();
  }
  for (const [key, value] of Object.entries(out)) {
    if (value.length < 1 || value.length > 500) throw Error(`selectors.${key} must be 1..500 characters.`);
    if (/[^a-zA-Z0-9 _~.,:#\[\]>'"*\\()=^$|&%!\-?+]/.test(value)) throw Error(`selectors.${key} contains disallowed characters.`);
  }
  return out;
}
export function searchRequest(options: SearchOptions): SearchRequest {
  const { query, url, region = 'wt-wt', time = 'any' } = options;
  const hasQuery = typeof query === 'string';
  const hasURL = typeof url === 'string';
  if (hasQuery === hasURL) throw Error('Pass exactly one of query (built-in DuckDuckGo HTML search) or url (any HTTP(S) search-results page).');
  if (hasQuery) {
    const q = query as string;
    if (!q.trim() || q.length > 500 || /[\u0000-\u001f\u007f]/.test(q)) throw Error('Search query must be 1..500 characters without control characters.');
    if (!(REGIONS as readonly string[]).includes(region) || !(TIMES as readonly string[]).includes(time)) throw Error('Unsupported search region or time filter.');
    const u = new URL('https://html.duckduckgo.com/html/');
    u.searchParams.set('q', q.trim()); u.searchParams.set('kl', region);
    if (time !== 'any') u.searchParams.set('df', time);
    if (options.selectors !== undefined) throw Error('selectors are only for url mode; the built-in DuckDuckGo search uses fixed markup.');
    return { mode: 'ddg', query: q.trim(), region, time, url: u.href };
  }
  const generic: SearchRequest = { mode: 'generic', url: webURL(url as string) };
  if (options.selectors !== undefined) generic.selectors = validateSelectors(options.selectors);
  return generic;
}
export interface SearchResult { rank: number; title: string; url: string; snippet: string }
export function validateSearch(data: any, expectedUrl: string): { results: SearchResult[]; truncated: boolean } {
  if (!data || data.url !== expectedUrl || !Array.isArray(data.results) || data.results.length > PAGE_LIMIT || typeof data.truncated !== 'boolean') throw Error('Invalid Safari search result.');
  const seen = new Set<string>();
  for (const [i, r] of data.results.entries()) {
    if (!r || r.rank !== i + 1 || typeof r.title !== 'string' || !r.title.trim() || r.title.length > 300 || typeof r.snippet !== 'string' || r.snippet.length > 600 || typeof r.url !== 'string' || r.url.length > 2048 || webURL(r.url) !== r.url || seen.has(r.url)) throw Error('Invalid Safari search entry.');
    seen.add(r.url);
  }
  return { results: data.results, truncated: data.truncated };
}
export function validateGenericSearch(data: any, expectedUrl: string): { results: SearchResult[]; pager: string[]; truncated: boolean } {
  if (!data || data.url !== expectedUrl || !Array.isArray(data.results) || data.results.length > PAGE_LIMIT || !Array.isArray(data.pager) || data.pager.length > PAGER_LIMIT || typeof data.truncated !== 'boolean') throw Error('Invalid Safari search result.');
  const seen = new Set<string>();
  for (const [i, r] of data.results.entries()) {
    if (!r || r.rank !== i + 1 || typeof r.title !== 'string' || !r.title.trim() || r.title.length > 300 || typeof r.snippet !== 'string' || r.snippet.length > 300 || typeof r.url !== 'string' || r.url.length > 2048 || webURL(r.url) !== r.url || seen.has(r.url)) throw Error('Invalid Safari search entry.');
    seen.add(r.url);
  }
  const pages = new Set<string>();
  for (const p of data.pager) {
    if (typeof p !== 'string' || p.length > 8192 || webURL(p) !== p || pages.has(p)) throw Error('Invalid Safari search pager link.');
    pages.add(p);
  }
  return { results: data.results, pager: data.pager, truncated: data.truncated };
}
// Fixed, read-only selectors. No raw query, arbitrary selector, click, form or provider script execution.
export function searchJS(expectedUrl: string): string {
  webURL(expectedUrl);
  return `JSON.stringify((()=>{
    if(location.href!==${JSON.stringify(expectedUrl)})throw Error('Search URL changed');
    const visible=e=>e&&e.getClientRects().length&&getComputedStyle(e).visibility==='visible'&&getComputedStyle(e).display!=='none';
    const text=(e,n)=>(e?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,n);
    const nodes=document.querySelectorAll('.result'); const results=[]; const seen=new Set(); let truncated=nodes.length>100;
    for(const node of Array.from(nodes).slice(0,100)){
      if(!visible(node)||node.matches('.result--ad'))continue;
      const a=node.querySelector('a.result__a[href]'); if(!visible(a))continue;
      let u; try {
        u=new URL(a.href,location.href);
        if(u.protocol==='https:'&&['duckduckgo.com','html.duckduckgo.com'].includes(u.hostname)&&u.pathname==='/l/'&&u.searchParams.has('uddg'))u=new URL(u.searchParams.get('uddg'));
      }catch{continue;}
      if(!/^https?:$/.test(u.protocol)||u.username||u.password||u.href.length>2048||['duckduckgo.com','html.duckduckgo.com'].includes(u.hostname)||seen.has(u.href))continue;
      const title=text(a,300); if(!title)continue; seen.add(u.href);
      if(results.length===${PAGE_LIMIT}){truncated=true;break;}
      const snippet=node.querySelector('.result__snippet');
      results.push({rank:results.length+1,title,url:u.href,snippet:visible(snippet)?text(snippet,600):''});
    }
    return {url:location.href,results,truncated};
  })())`;
}
// Shared read-only guards: exact-URL assertion, visibility and text helpers, and same-site
// clickthrough unwrapping (Bing a1 base64, DuckDuckGo uddg, Yahoo RU=). Same-site: same host,
// or same last two dot labels.
function searchHelpersJS(serpHost: string): string {
  return `const visible=e=>e&&e.getClientRects().length&&getComputedStyle(e).visibility==='visible'&&getComputedStyle(e).display!=='none';
    const text=e=>(e?.innerText||'').replace(/\\s+/g,' ');
    const siteOf=h=>h.split('.').slice(-2).join('.');
    const unwrap=a=>{
      let u; try { u=new URL(a.href,location.href); } catch { return null; }
      if(/^https?:$/.test(u.protocol)&&siteOf(u.hostname.toLowerCase())===${JSON.stringify(serpHost)}){
        let d=null;
        const enc=u.searchParams.get('u')||'';
        if(enc.startsWith('a1')){
          try {
            let b=enc.slice(2).replace(/-/g,'+').replace(/_/g,'/'); while(b.length%4)b+='=';
            const c=new URL(atob(b));
            if(/^https?:$/.test(c.protocol)&&!c.username&&!c.password&&c.href.length<=2048)d=c;
          } catch {}
        }
        if(!d){
          const ud=u.searchParams.get('uddg');
          if(ud){
            try {
              const c=new URL(decodeURIComponent(ud),location.href);
              if(/^https?:$/.test(c.protocol)&&!c.username&&!c.password&&c.href.length<=2048)d=c;
            } catch {}
          }
        }
        if(!d){
          for(const seg of u.pathname.split('/')){
            if(!seg.startsWith('RU='))continue;
            try {
              const c=new URL(decodeURIComponent(seg.slice(3)));
              if(/^https?:$/.test(c.protocol)&&!c.username&&!c.password&&c.href.length<=2048)d=c;
            } catch {}
            break;
          }
        }
        if(d)u=d;
      }
      if(!/^https?:$/.test(u.protocol)||u.username||u.password||u.href.length>2048)return null;
      return u;
    };`;
}
// Pager detection shared by both generic paths: exact next/numbered labels, 12 unique URLs.
function pagerJS(): string {
  return `const pager=[]; const pages=new Set();
    for(const a of anchors){
      if(!visible(a))continue;
      const t=text(a).trim();
      if(!pagerRe.test(t))continue;
      let u; try { u=new URL(a.href,location.href); } catch { continue; }
      if(!/^https?:$/.test(u.protocol)||u.username||u.password||pages.has(u.href))continue;
      pages.add(u.href);
      if(pager.length===${PAGER_LIMIT})break;
      pager.push(u.href);
    }`;
}
// Fixed heuristic extractor for arbitrary search-results pages chosen by the caller as a URL.
// Same safety style as searchJS: read-only, exact-URL assertion, safe helpers only.
// Without selectors: two-tier anchor heuristic (heading-anchored results first, then all
// anchors) for minimal markup. With caller-supplied selectors (generic mode only): item
// selects each result container; link/title/snippet select sub-parts and are optional,
// falling back to the anchor, an inner heading and the box tail. Both paths share the
// same URL guards, dedupe, 30-result cap and pager detection.
export function genericSearchJS(expectedUrl: string, selectors?: SearchSelectors): string {
  webURL(expectedUrl);
  const selectorJS = selectors ? `
    const items=Array.from(document.querySelectorAll(${JSON.stringify(selectors.item)})).slice(0,300);
    const results=[]; const seen=new Set(); let truncated=items.length>300;
    for(const node of items){
      if(!visible(node))continue;
      const a=node.querySelector(${JSON.stringify(selectors.link ?? 'a[href]')});
      if(!a||!a.href||!visible(a))continue;
      const u=unwrap(a); if(!u||seen.has(u.href))continue; seen.add(u.href);
      if(results.length===${PAGE_LIMIT}){truncated=true;break;}
      let title='';
      ${selectors.title ? `const tEl=node.querySelector(${JSON.stringify(selectors.title)}); if(tEl)title=text(tEl).trim().slice(0,300);` : ''}
      if(!title){ const heading=a.querySelector('h1,h2,h3,h4'); title=((heading&&text(heading).trim().length>=8)?text(heading):text(a)).trim().slice(0,300); }
      if(!title)continue;
      let snippet='';
      ${selectors.snippet ? `const sEl=node.querySelector(${JSON.stringify(selectors.snippet)}); if(sEl)snippet=text(sEl).trim().slice(0,300);` : ''}
      if(!snippet){ const box=a.closest('article,li'); const raw=box?text(box):''; const at=raw.indexOf(title); if(at>=0)snippet=raw.slice(at+title.length).trim().slice(0,300); }
      results.push({rank:results.length+1,title,url:u.href,snippet});
    }
    const anchors=Array.from(document.querySelectorAll('a[href]')).slice(0,2000);
    ` : `
    const anchors=Array.from(document.querySelectorAll('a[href]')).slice(0,2000);
    // Tier 1: anchors whose organic title is an h1..h4 (wrapping or wrapped). Tier 2 fallback:
    // generic container heuristic for minimal markup (e.g. DuckDuckGo Lite).
    const headingOf=a=>a.querySelector('h1,h2,h3,h4')||a.closest('h1,h2,h3,h4');
    const tier1=anchors.filter(a=>visible(a)&&!pagerRe.test(text(a).trim())&&headingOf(a));
    const pool=tier1.length?tier1:anchors;
    const results=[]; const seen=new Set(); let truncated=anchors.length>2000;
    for(const a of pool){
      if(!visible(a))continue;
      const label0=text(a).trim();
      if(pagerRe.test(label0))continue;
      const heading=headingOf(a);
      const label=((heading&&text(heading).trim().length>=8)?text(heading).trim():label0);
      if(label.length<8||label.length>300)continue;
      if(/https?:\\/\\//i.test(label)||/^[\\w.-]+\\.[a-z]{2,}(:\\d+)?(\\/\\S*)?$/i.test(label))continue;
      if(!a.closest('article,li,main,section,td')||a.closest('nav,footer,aside,form'))continue;
      const u=unwrap(a); if(!u||seen.has(u.href))continue;
      seen.add(u.href);
      if(results.length===${PAGE_LIMIT}){truncated=true;break;}
      const box=a.closest('article,li');
      let snippet='';
      if(box){
        const raw=text(box); const at=raw.indexOf(label);
        if(at>=0)snippet=raw.slice(at+label.length).trim().slice(0,300);
      }
      results.push({rank:results.length+1,title:label,url:u.href,snippet});
    }
    `;
  return `JSON.stringify((()=>{
    if(location.href!==${JSON.stringify(expectedUrl)})throw Error('Search URL changed');
    ${searchHelpersJS(new URL(expectedUrl).hostname.toLowerCase())}
    const pagerRe=/^(next|next page|\\u203a|\\u00bb|\\u2026|\\d{1,3})$/i;
    ${selectorJS}
    ${pagerJS()}
    return {url:location.href,results,pager,truncated};
  })())`;
}
