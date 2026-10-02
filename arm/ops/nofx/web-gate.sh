set -e
SECRET_FILE=/opt/nofx/gate.secret
[ -s "$SECRET_FILE" ] || { openssl rand -hex 24 > "$SECRET_FILE"; chmod 600 "$SECRET_FILE"; }
S=$(cat "$SECRET_FILE")
cat > /etc/nginx/conf.d/nofx.conf <<EOF
# NOFX dashboard on :8443 (container UI at 127.0.0.1:3200). Gate: open /__gate?k=<secret> once -> 30-day cookie.
map \$http_upgrade \$nofx_conn { default upgrade; '' close; }
server {
    listen 8443 ssl;
    server_name arm.yyheart.com;
    ssl_certificate /etc/letsencrypt/live/arm/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/arm/privkey.pem;
    client_max_body_size 10m;
    add_header X-Robots-Tag "noindex, nofollow" always;

    location = /__gate {
        if (\$arg_k = "$S") {
            add_header Set-Cookie "nofx_gate=$S; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax";
            return 302 /traders;
        }
        return 403;
    }
    location / {
        if (\$cookie_nofx_gate != "$S") { return 403; }
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$nofx_conn;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;
    }
}
EOF
nginx -t
systemctl reload nginx
ufw allow 8443/tcp >/dev/null
echo "no cookie:  $(curl -s -o /dev/null -w '%{http_code}' https://arm.yyheart.com:8443/traders)"
echo "bad key:    $(curl -s -o /dev/null -w '%{http_code}' 'https://arm.yyheart.com:8443/__gate?k=nope')"
echo "gate:       $(curl -s -o /dev/null -w '%{http_code}' -c /tmp/gate.jar "https://arm.yyheart.com:8443/__gate?k=$S")"
echo "with cookie $(curl -s -o /dev/null -w '%{http_code}' -b /tmp/gate.jar https://arm.yyheart.com:8443/traders)"
echo "api:        $(curl -s -o /dev/null -w '%{http_code}' -b /tmp/gate.jar https://arm.yyheart.com:8443/api/competition)"
rm -f /tmp/gate.jar
