"""Keep ephemeral builder and registry credentials in private files, never arguments."""
import base64
import json
import os
from pathlib import Path
import shutil
import sys


def main():
    roots = [Path(os.environ['BUILDKIT_TLS_DIRECTORY']), Path(os.environ['DOCKER_CONFIG'])]
    if roots != [Path('/tmp/service-buildkit-tls'), Path('/tmp/service-registry')]:
        raise ValueError('Unexpected credential directory')
    if sys.argv[1:] == ['--remove']:
        for root in roots:
            if root.exists():
                shutil.rmtree(root)
        return
    os.umask(0o077)
    for root in roots:
        root.mkdir(mode=0o700, exist_ok=False)
    for name, variable in [('ca.pem', 'BUILDKIT_CA'), ('cert.pem', 'BUILDKIT_CERT'), ('key.pem', 'BUILDKIT_KEY')]:
        value = os.environ[variable]
        if not value.strip():
            raise ValueError('Missing credential: ' + variable)
        (roots[0] / name).write_text(value)
    auth = base64.b64encode((os.environ['REGISTRY_USER'] + ':' + os.environ['REGISTRY_PASSWORD']).encode()).decode()
    (roots[1] / 'config.json').write_text(json.dumps({'auths': {'registry.neomatik.eu': {'auth': auth}}}))


if __name__ == '__main__':
    main()
