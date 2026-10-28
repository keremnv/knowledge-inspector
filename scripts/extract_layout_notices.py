from pathlib import Path
import urllib.request,urllib.parse,tarfile,io,json,hashlib
items=[('lodash','4.17.23'),('lodash','4.17.21'),('lodash','4.17.20'),('ml-matrix','6.12.1'),('tslib','2.8.1'),('is-any-array','2.0.1'),('ml-array-max','1.2.4'),('ml-array-min','1.2.3'),('ml-array-rescale','1.3.7')]
out=Path('THIRD_PARTY/licenses');records=[]
for name,version in items:
 url=f'https://registry.npmjs.org/{urllib.parse.quote(name,safe="")}/{version}';meta=json.load(urllib.request.urlopen(url,timeout=20));data=urllib.request.urlopen(meta['dist']['tarball'],timeout=20).read();f=tarfile.open(fileobj=io.BytesIO(data),mode='r:gz');lic=[x for x in f.getmembers() if x.isfile() and x.name.count('/')==1 and x.name.split('/')[-1].lower().startswith(('license','licence','copying','notice'))];files=[]
 for x in lic:
  target=out/(name+'-'+version+'-'+x.name.split('/')[-1]+'.txt');target.write_bytes(f.extractfile(x).read());files.append(target.name)
 records.append({'package':name,'version':version,'license':meta.get('license'),'tarball':meta['dist']['tarball'],'integrity':meta['dist'].get('integrity'),'files':files});print(name,version,meta.get('license'),files,flush=True)
Path('THIRD_PARTY/layout-matched-artifacts.json').write_text(json.dumps({'method':'Exact SHA-256 comparison of each embedded source map sourcesContent with the named file in published npm tarballs released no later than layout 2.0.0; matching file content does not establish a unique release.','artifacts':records,'matches':json.loads(Path('tmp-review/vendor-matches.json').read_text())},indent=2)+'\n')
