"""Publish one linux/amd64 image and immutable workflow provenance."""
import json,os,re,subprocess
from pathlib import Path
m=json.loads(Path('delivery/manifest.json').read_text())
sha=os.environ['GITHUB_SHA'];run=os.environ['GITHUB_RUN_ID'];attempt=os.environ['GITHUB_RUN_ATTEMPT']
assert re.fullmatch('[a-f0-9]{40}',sha)
repository='registry.neomatik.eu/skymist/'+m['service']
tag=repository+':'+sha+'-'+run+'-'+attempt
tls=Path(os.environ['BUILDKIT_TLS_DIRECTORY'])
subprocess.run(['buildctl','--addr',os.environ['BUILDKIT_HOST'],'--tlscacert',str(tls/'ca.pem'),'--tlscert',str(tls/'cert.pem'),'--tlskey',str(tls/'key.pem'),'build','--frontend','dockerfile.v0','--local','context=.','--local','dockerfile=.','--opt','platform=linux/amd64','--opt','label:org.opencontainers.image.revision='+sha,'--opt','label:io.skymist.workflow-run='+run,'--opt','label:io.skymist.workflow-attempt='+attempt,'--output','type=image,name='+tag+',push=true','--metadata-file','/tmp/image-metadata.json'],check=True)
digest=json.loads(Path('/tmp/image-metadata.json').read_text())['containerimage.digest']
assert re.fullmatch('sha256:[a-f0-9]{64}',digest)
actual=json.loads(subprocess.check_output(['skopeo','inspect','docker://'+tag]))['Digest']
if digest!=actual:raise ValueError('Registry digest mismatch')
m.update(sourceSha=sha,image=repository+'@'+digest,runId=int(run),runAttempt=int(attempt))
Path('candidate.json').write_text(json.dumps(m,indent=2)+'\n')
