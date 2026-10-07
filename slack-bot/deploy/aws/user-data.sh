#!/bin/bash
# Alpieca on EC2: paste this into "Advanced details -> User data" when launching an
# Amazon Linux 2023 instance. It runs once, on first boot, as root.
#
# Expects:
#   - an instance role allowed to read SSM parameters under /alpieca/ (see README "Deploying on AWS")
#   - secrets stored as SSM parameters: /alpieca/SLACK_BOT_TOKEN, /alpieca/SLACK_APP_TOKEN,
#     /alpieca/GITHUB_TOKEN, /alpieca/ALPIE_API_KEY (and optionally any other variable from .env.example)
#
# Deploy a new version later (from Session Manager):  sudo alpieca-update
set -euo pipefail

REPO_URL="https://github.com/169Pi/devrel.git"
BRANCH="main"
APP_DIR="/opt/alpieca"
PARAM_PATH="/alpieca/"

dnf install -y nodejs22 nodejs22-npm git
useradd --system --create-home --home-dir /var/lib/alpieca --shell /sbin/nologin alpieca || true

git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
chown -R alpieca:alpieca "$APP_DIR"
sudo -H -u alpieca bash -c "cd $APP_DIR/slack-bot && npm-22 ci --omit=dev"

# Loads secrets from Parameter Store into the environment, then starts the bot.
# Secrets never touch the disk; rotate one by updating the parameter and restarting.
cat > /usr/local/bin/alpieca-start <<EOF
#!/bin/bash
set -euo pipefail
TOKEN=\$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
export AWS_DEFAULT_REGION=\$(curl -sf -H "X-aws-ec2-metadata-token: \$TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
while IFS=\$'\t' read -r name value; do
  export "\${name#$PARAM_PATH}=\$value"
done < <(aws ssm get-parameters-by-path --path "$PARAM_PATH" --with-decryption \\
           --query 'Parameters[*].[Name,Value]' --output text)
cd "$APP_DIR/slack-bot"
exec /usr/bin/node-22 src/app.js
EOF

# Pulls the latest code from GitHub and restarts the bot.
cat > /usr/local/bin/alpieca-update <<EOF
#!/bin/bash
set -euo pipefail
sudo -H -u alpieca git -C "$APP_DIR" pull --ff-only
sudo -H -u alpieca bash -c "cd $APP_DIR/slack-bot && npm-22 ci --omit=dev"
systemctl restart alpieca
systemctl --no-pager status alpieca | head -5
EOF
chmod 755 /usr/local/bin/alpieca-start /usr/local/bin/alpieca-update

cat > /etc/systemd/system/alpieca.service <<'EOF'
[Unit]
Description=Alpieca Slack bot
Wants=network-online.target
After=network-online.target

[Service]
User=alpieca
ExecStart=/usr/local/bin/alpieca-start
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now alpieca
