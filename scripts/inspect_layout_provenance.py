import urllib.request,urllib.parse,tarfile,io,json,re,concurrent.futures,hashlib
from pathlib import Path
root=Path.cwd();Path('tmp-review').mkdir(exist_ok=True);vendor=root/'node_modules/@antv/layout/lib/node_modules'
paths={'lodash':['lodash/_baseOrderBy.js.map','lodash/_setCacheHas.js.map'],'ml-matrix':['ml-matrix/matrix2.js.map'],'tslib':['tslib/tslib.es6.js.map'],'is-any-array':['is-any-array/lib-esm/index.js.map'],'ml-array-max':['ml-array-max/lib-es6/index.js.map'],'ml-array-min':['ml-array-min/lib-es6/index.js.map'],'ml-array-rescale':['ml-array-rescale/lib-es6/index.js.map']}
def get(url):return urllib.request.urlopen(url,timeout=20).read()
layout=json.loads(get('https://registry.npmjs.org/%40antv%2flayout'))
cutoff=layout['time']['2.0.0'];print('layout published',cutoff,flush=True)
def work(item):
 name,maps=item; rec={'package':name,'maps':{}}
 for m in maps:
  d=json.loads((vendor/m).read_text());source=d['sources'][0].rsplit('node_modules/',1)[1];rel=source[len(name)+1:];content=d['sourcesContent'][0].encode();rec['maps'][m]={'source':rel,'sha256':hashlib.sha256(content).hexdigest(),'matches':[]};
 pack=json.loads(get('https://registry.npmjs.org/'+urllib.parse.quote(name,safe='')));versions=[(t,v) for v,t in pack.get('time',{}).items() if re.fullmatch(r'\d+\.\d+\.\d+',v) and t<=cutoff and v in pack['versions']];versions.sort(reverse=True)
 # 20 latest stable versions plus security-era and historic branches.
 for t,version in versions[:20]:
  try:
   z=pack['versions'][version];data=get(z['dist']['tarball']);tf=tarfile.open(fileobj=io.BytesIO(data),mode='r:gz');members={m.name:m for m in tf.getmembers() if m.isfile()}
   for entry in rec['maps'].values():
    path='package/'+entry['source'];member=members.get(path)
    if member and hashlib.sha256(tf.extractfile(member).read()).hexdigest()==entry['sha256']:
     entry['matches'].append({'version':version,'declared_license':z.get('license'),'integrity':z['dist'].get('integrity')})
  except Exception as e:rec.setdefault('errors',[]).append(str(e))
 return rec
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: results=list(pool.map(work,paths.items()))
Path('tmp-review/vendor-matches.json').write_text(json.dumps({'layout_release':cutoff,'packages':results},indent=2)+'\n')
for r in results:
 for path,m in r['maps'].items():print(r['package'],m['source'],[x['version'] for x in m['matches'][:8]],flush=True)
