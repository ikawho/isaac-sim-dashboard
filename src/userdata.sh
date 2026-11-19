#!/bin/bash
# Runs on the instance's first boot and sets up a systemd service
# that starts Isaac Sim + web viewer on EVERY boot with the current public IP.
set -euxo pipefail

mkdir -p /opt/isaac
cat > /opt/isaac/env <<'EOF'
OWNER="__OWNER__"
BUCKET="__BUCKET__"
REGION="__REGION__"
IMAGE="__IMAGE__"
EOF

# ---------------------------------------------------------------- Boot script
cat > /opt/isaac/boot.sh <<'BOOT'
#!/bin/bash
set -uo pipefail
source /opt/isaac/env
export HOME=/home/ubuntu
export AWS_DEFAULT_REGION="$REGION"
REPO=/opt/isaac/IsaacSim
WS=/home/ubuntu/workspace
COMPOSE="docker compose -p isim -f $REPO/tools/docker/docker-compose.yml -f /opt/isaac/override.yml"

TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
md() { curl -s -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/$1"; }
IID=$(md instance-id)
PUBLIC_IP=$(md public-ipv4)

status() {
  printf '{"phase":"%s","detail":"%s","publicIp":"%s","ts":%s}' "$1" "$2" "$PUBLIC_IP" "$(date +%s)" \
    | aws s3 cp - "s3://$BUCKET/_status/$IID.json" --content-type application/json --only-show-errors || true
}
fail() { status error "$1 (see boot log)"; exit 1; }

# ---- Boot log: everything this script prints goes to $LOG, and the last 300 lines are copied
# to s3://<bucket>/_status/<instance-id>.log every 15 s, so the dashboard can show it.
LOG=/var/log/isaac-boot.log
exec > >(tee -a "$LOG") 2>&1
echo "===== boot $(date -Is) instance $IID ip $PUBLIC_IP"
push_log() { tail -n 300 "$LOG" | aws s3 cp - "s3://$BUCKET/_status/$IID.log" --content-type text/plain --only-show-errors >/dev/null 2>&1 || true; }
( while true; do push_log; sleep 15; done ) &
LOG_LOOP=$!
trap 'kill $LOG_LOOP 2>/dev/null; push_log' EXIT
trap 'status error "Setup was interrupted (service stopped during setup)"; exit 1' TERM INT
export PS4='+ $(date +%T) '   # timestamps on every traced command
set -x

if [ ! -f /opt/isaac/.installed ]; then
  export DEBIAN_FRONTEND=noninteractive
  # On first boot, cloud-init and unattended-upgrades often hold the apt lock for a while.
  status setup "Waiting for first-boot system updates to finish"
  timeout 900 cloud-init status --wait || true
  APT="apt-get -y -o DPkg::Lock::Timeout=900"

  status setup "Installing packages (apt)"
  timeout 1200 $APT update || true
  timeout 1200 $APT install git acl jq curl ca-certificates || fail "apt-get install failed"

  # Docker (normally present in the Deep Learning AMI)
  if ! command -v docker >/dev/null; then
    status setup "Installing Docker"
    timeout 1200 bash -c 'curl -fsSL https://get.docker.com | sh' || fail "Docker installation failed"
  fi
  # NVIDIA Container Toolkit (normally present)
  if ! command -v nvidia-ctk >/dev/null; then
    status setup "Installing NVIDIA Container Toolkit"
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      > /etc/apt/sources.list.d/nvidia-container-toolkit.list
    { timeout 1200 $APT update && timeout 1200 $APT install nvidia-container-toolkit; } || fail "NVIDIA Container Toolkit installation failed"
  fi
  status setup "Configuring Docker for the GPU"
  nvidia-ctk runtime configure --runtime=docker || true
  timeout 300 systemctl restart docker || fail "Docker restart failed"

  # Docker Compose v2
  if ! docker compose version >/dev/null 2>&1; then
    status setup "Installing Docker Compose"
    timeout 1200 $APT install docker-compose-plugin || {
      mkdir -p /usr/local/lib/docker/cli-plugins
      curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
        -o /usr/local/lib/docker/cli-plugins/docker-compose
      chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    }
  fi

  # Volume mounts as in the Isaac Sim docs (container user 1234:1234)
  mkdir -p $HOME/docker/isaac-sim/{cache/main,cache/computecache,cache/kit,config,data,logs,pkg} $HOME/.cache/ov/hub
  chown -R 1234:1234 $HOME/docker $HOME/.cache/ov/hub

  # Workspace folder synced with S3 (ubuntu + container user may write)
  mkdir -p "$WS"
  chown ubuntu:ubuntu "$WS"
  setfacl -m u:1234:rwx "$WS"; setfacl -d -m u:1234:rwx "$WS"; setfacl -d -m u:1000:rwx "$WS"

  # Isaac Sim repo, only for tools/docker (Compose + web viewer)
  status setup "Downloading Isaac Sim repository (docker tools)"
  VER="${IMAGE##*:}"
  rm -rf "$REPO"
  GIT_LFS_SKIP_SMUDGE=1 timeout 1200 git clone --depth 1 --branch "v$VER" https://github.com/isaac-sim/IsaacSim.git "$REPO" \
    || { rm -rf "$REPO"; GIT_LFS_SKIP_SMUDGE=1 timeout 1200 git clone --depth 1 https://github.com/isaac-sim/IsaacSim.git "$REPO"; } \
    || fail "Could not clone the Isaac Sim repository"
  touch /opt/isaac/.installed
fi

status pulling "Downloading Isaac Sim container (about 20 GB on first start)"
timeout 3600 docker pull "$IMAGE" || fail "docker pull $IMAGE failed"

status syncing "Syncing your files from S3"
aws s3 sync "s3://$BUCKET/users/$OWNER/" "$WS/" --only-show-errors || true
setfacl -R -m u:1234:rwx "$WS" || true

# Extra mount: ~/workspace -> /workspace in the Isaac Sim container
export ISAACSIM_HOST="$PUBLIC_IP" ISAAC_SIM_IMAGE="$IMAGE" ACCEPT_EULA=Y
SVC=$(docker compose -f "$REPO/tools/docker/docker-compose.yml" config --services 2>/dev/null | grep -i isaac | grep -vi -e web -e viewer | head -n1)
SVC=${SVC:-isaac-sim}
cat > /opt/isaac/override.yml <<EOF
services:
  $SVC:
    volumes:
      - $WS:/workspace:rw
EOF

status building "Building web viewer for IP $PUBLIC_IP"
cd "$REPO"
$COMPOSE down --remove-orphans >/dev/null 2>&1 || true
timeout 1800 $COMPOSE build || fail "Building the web viewer failed"
# All services except Isaac Sim itself (= the web viewer)
OTHERS=$($COMPOSE config --services | grep -vxF "$SVC" | tr '\n' ' ')

# Start only Isaac Sim. We do NOT use "compose up" for everything: the viewer depends on the
# Isaac Sim health check, which gives up long before the first start (shader cache) is done.
# Instead we wait for Isaac Sim's own "ready" log line and start the viewer afterwards.
status starting "Isaac Sim is starting (first start builds the shader cache: 15 minutes or more)"
$COMPOSE up -d --no-deps "$SVC" || fail "Starting the Isaac Sim container failed"
CID=$($COMPOSE ps -aq "$SVC")

set +x   # the wait loop would flood the log; print the container log every minute instead
for i in $(seq 1 540); do
  (( i % 6 == 0 )) && { echo "--- Isaac Sim container log ($(date +%T)):"; docker logs --tail 5 "$CID" 2>&1; }
  if docker logs "$CID" 2>&1 | grep -q "Streaming App is loaded"; then
    echo "--- Isaac Sim is ready, starting the web viewer ($OTHERS)"
    $COMPOSE up -d --no-deps $OTHERS || fail "Starting the web viewer failed"
    status ready "Isaac Sim is ready"
    exit 0
  fi
  # Crash detection: container exited, or keeps restarting
  read -r STATE CODE RESTARTS < <(docker inspect -f '{{.State.Status}} {{.State.ExitCode}} {{.RestartCount}}' "$CID" 2>/dev/null || echo "missing 0 0")
  if [[ "$STATE" == exited || "$STATE" == dead || "$STATE" == missing ]] || (( RESTARTS >= 3 )); then
    echo "--- Isaac Sim container stopped: state=$STATE exit code=$CODE restarts=$RESTARTS. Last 80 log lines:"
    docker logs --tail 80 "$CID" 2>&1
    nvidia-smi 2>&1 | head -15
    fail "Isaac Sim crashed (container $STATE, exit code $CODE)"
  fi
  sleep 10
done
echo "--- Isaac Sim not ready after 90 minutes. Last 80 log lines:"
docker logs --tail 80 "$CID" 2>&1
fail "Isaac Sim was not ready within 90 minutes"
BOOT

# ---------------------------------------------------------------- Sync back to S3
cat > /opt/isaac/sync-up.sh <<'SYNC'
#!/bin/bash
source /opt/isaac/env
[ -d /home/ubuntu/workspace ] || exit 0
aws s3 sync /home/ubuntu/workspace/ "s3://$BUCKET/users/$OWNER/" \
  --region "$REGION" --only-show-errors --exclude "*.tmp" --exclude ".~lock*" || true
SYNC
chmod +x /opt/isaac/boot.sh /opt/isaac/sync-up.sh

cat > /etc/systemd/system/isaac-sim.service <<'UNIT'
[Unit]
Description=Isaac Sim + web viewer (dashboard)
After=network-online.target docker.service
# Wants (not Requires): boot.sh restarts Docker during setup; with Requires that restart
# would stop this service and kill boot.sh itself.
Wants=network-online.target docker.service

[Service]
Type=simple
RemainAfterExit=yes
ExecStart=/opt/isaac/boot.sh
ExecStop=/opt/isaac/sync-up.sh
TimeoutStartSec=infinity
TimeoutStopSec=600

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/isaac-sync.service <<'UNIT'
[Unit]
Description=Sync workspace to S3
[Service]
Type=oneshot
ExecStart=/opt/isaac/sync-up.sh
UNIT

cat > /etc/systemd/system/isaac-sync.timer <<'UNIT'
[Unit]
Description=Sync workspace to S3 every 2 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable isaac-sync.timer isaac-sim.service
systemctl start isaac-sync.timer
systemctl start --no-block isaac-sim.service
