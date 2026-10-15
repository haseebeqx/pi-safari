import { webURL } from './extraction.ts';

// DuckDuckGo HTML's documented URL controls; deliberately not arbitrary provider parameters.
export const REGIONS = ['wt-wt', 'us-en', 'uk-en', 'ca-en', 'au-en', 'de-de', 'fr-fr', 'in-en', 'jp-jp'] as const;
export const TIMES = ['any', 'd', 'w', 'm', 'y'] as const;
export interface SearchOptions { query: string; maxResults?: number; region?: string; time?: string }
export function searchRequest(options: SearchOptions) {
  const { query, maxResults = 5, region = 'wt-wt', time = 'any' } = options;
  if (typeof query !== 'string' || !query.trim() || query.length > 500 || /[\u0000-\u001f\u007f]/.test(query)) throw Error('Search query must be 1..500 characters without control characters.');
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) throw Error('maxResults must be 1..10.');
  if (!(REGIONS as readonly string[]).includes(region) || !(TIMES as readonly string[]).includes(time)) throw Error('Unsupported search region or time filter.');
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query.trim()); url.searchParams.set('kl', region);
  if (time !== 'any') url.searchParams.set('df', time);
  return { query: query.trim(), maxResults, region, time, url: url.href };
}
export interface SearchResult { rank: number; title: string; url: string; snippet: string }
export function validateSearch(data: any, expectedUrl: string, maxResults: number): { results: SearchResult[]; truncated: boolean } {
  if (!data || data.url !== expectedUrl || !Array.isArray(data.results) || data.results.length > maxResults || typeof data.truncated !== 'boolean') throw Error('Invalid Safari search result.');
  const seen = new Set<string>();
  for (const [i, r] of data.results.entries()) {
    if (!r || r.rank !== i + 1 || typeof r.title !== 'string' || !r.title.trim() || r.title.length > 300 || typeof r.snippet !== 'string' || r.snippet.length > 600 || typeof r.url !== 'string' || r.url.length > 2048 || webURL(r.url) !== r.url || seen.has(r.url)) throw Error('Invalid Safari search entry.');
    seen.add(r.url);
  }
  return { results: data.results, truncated: data.truncated };
}
// Fixed, read-only selectors. No raw query, arbitrary selector, click, form or provider script execution.
export function searchJS(expectedUrl: string, maxResults: number): string {
  webURL(expectedUrl);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) throw Error('maxResults must be 1..10.');
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
      if(results.length===${maxResults}){truncated=true;break;}
      const snippet=node.querySelector('.result__snippet');
      results.push({rank:results.length+1,title,url:u.href,snippet:visible(snippet)?text(snippet,600):''});
    }
    return {url:location.href,results,truncated};
  })())`;
}
