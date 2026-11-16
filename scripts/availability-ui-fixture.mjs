// Disposable local UI fixture. It contains no credentials and makes no upstream requests.
import { createServer } from 'node:http';
createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5183');
  res.setHeader('Access-Control-Allow-Headers', 'apikey, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  const url = new URL(req.url, 'http://127.0.0.1:5184');
  if (url.pathname !== '/availability') { res.writeHead(404).end(); return; }
  const id = url.searchParams.get('id'), region = url.searchParams.get('region'), type = url.searchParams.get('type');
  let data;
  if (url.searchParams.get('source') === 'watchmode') {
    data = {source:'Watchmode', mediaType:type, externalId:id, region, candidates: region === 'US' && id === '37680' ? [{sourceId:1,name:'Netflix',region:'US',offerType:'sub',titleUrl:'https://www.netflix.com/title/70283145'}] : []};
  } else if (type === 'game' && id === '72') data = {source:'IGDB',matchedTitle:'Portal 2',links:[{name:'Steam',url:'https://store.steampowered.com/app/620',kind:'Store link'}]};
  else if (type === 'game') data = {matches:[{id:'72',title:'Portal 2',year:2011}]};
  else if (id) data = {links:[],source:'JustWatch'};
  else data = {matches:[{id:'37680',title:'Suits',year:2011},{id:'83334',title:'Suits',year:2018}]};
  res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(data));
}).listen(5184, '127.0.0.1', () => process.stdout.write('Fixture service listening on 127.0.0.1:5184\n'));
