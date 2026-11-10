#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" != 0 ]; then exec sudo --preserve-env=GITHUB_PATH,GITHUB_WORKSPACE bash "$0"; fi
# Job containers are ephemeral and have no Docker daemon or host mounts.
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl git jq python3 python3-venv skopeo gh build-essential xz-utils
# ARC's checkout and job container have different UIDs. Trust only this job's
# repository, rather than disabling Git's ownership protection globally.
git config --global --add safe.directory "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE must identify the checked-out repository}"
python3 -m venv /tmp/skymist-ci-python
/tmp/skymist-ci-python/bin/pip install PyYAML==6.0.2 jsonschema==4.25.1 pytest==8.4.2 httpx==0.28.1
curl --fail --location --retry 3 https://get.helm.sh/helm-v3.19.0-linux-amd64.tar.gz -o /tmp/helm-v3.19.0-linux-amd64.tar.gz
curl --fail --location --retry 3 https://get.helm.sh/helm-v3.19.0-linux-amd64.tar.gz.sha256sum -o /tmp/helm.sha256
(cd /tmp && sha256sum --check helm.sha256)
tar -xzf /tmp/helm-v3.19.0-linux-amd64.tar.gz -C /tmp
install /tmp/linux-amd64/helm /usr/local/bin/helm
curl --fail --location --retry 3 https://dl.k8s.io/release/v1.36.4/bin/linux/amd64/kubectl -o /tmp/kubectl
curl --fail --location --retry 3 https://dl.k8s.io/release/v1.36.4/bin/linux/amd64/kubectl.sha256 -o /tmp/kubectl.sha256
(cd /tmp && echo "$(cat kubectl.sha256)  kubectl" | sha256sum --check)
install /tmp/kubectl /usr/local/bin/kubectl
echo /tmp/skymist-ci-python/bin >> "$GITHUB_PATH"

# Match the authenticated rootless daemon; pin the release artifact checksum.
curl --fail --location --retry 3 https://github.com/moby/buildkit/releases/download/v0.25.1/buildkit-v0.25.1.linux-amd64.tar.gz -o /tmp/cataclysm-buildkit.tar.gz
printf '%s\n' '85aa27c480fc9159705d21a3e66abe305f8dc708b8aeecd1e87bbc5c3de98642  /tmp/cataclysm-buildkit.tar.gz' | sha256sum --check
tar -xzf /tmp/cataclysm-buildkit.tar.gz -C /tmp bin/buildctl
install /tmp/bin/buildctl /usr/local/bin/buildctl
