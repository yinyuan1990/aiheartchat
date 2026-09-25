#!/usr/bin/env bash
# Multi-domain manager, runs ON the server (/opt/arm/ops/domains.sh). Driven by the Windows exe
# (ops/domains-cli.mjs) or by hand:
#   bash domains.sh list                       # current domains, DNS, certificate
#   bash domains.sh set  "a.com b.com c.com"   # make exactly these the public domains (nginx + cert + env + indexer)
#   bash domains.sh add  d.com                 # append one
#   bash domains.sh remove d.com               # drop one
#   bash domains.sh render                     # re-render nginx from .env without touching the certificate
# Every domain must already have `@` and `www` A records → this server (DNS only / grey cloud on Cloudflare);
# a domain whose DNS is not ready is reported and skipped from the certificate, never fatal.
set -euo pipefail
cd /opt/arm
ENV=/opt/arm/.env
TPL=/opt/arm/nginx/arm.conf.tpl
CONF=/etc/nginx/conf.d/arm.conf
CERT=arm
export PYTHONNOUSERSITE=1  # /root/.local has an urllib3 that breaks the distro certbot

IP=$(curl -s --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')

# apex domains (one dot, e.g. x.com) also get www.x.com; subdomains (arm.yyheart.com) are served as-is
with_www() { local d; for d in $1; do echo -n "$d "; [ "$(echo "$d" | tr -cd . | wc -c)" = 1 ] && echo -n "www.$d "; done; echo; }
is_apex() { [ "$(echo "$1" | tr -cd . | wc -c)" = 1 ]; }

current() { grep -E '^PUBLIC_DOMAINS=' "$ENV" | cut -d= -f2- | tr ',' ' ' | xargs -n1 2>/dev/null | awk 'NF' | tr '\n' ' ' | sed 's/ *$//'; }
resolves() { dig +short +time=3 +tries=1 A "$1" @1.1.1.1 | grep -E '^[0-9.]+$' | head -1; }

save_env() { # $1 = space list
  local csv; csv=$(echo "$1" | tr ' ' '\n' | awk 'NF' | paste -sd, -)
  if grep -qE '^PUBLIC_DOMAINS=' "$ENV"; then sed -i "s|^PUBLIC_DOMAINS=.*|PUBLIC_DOMAINS=$csv|" "$ENV"; else echo "PUBLIC_DOMAINS=$csv" >> "$ENV"; fi
  grep -qE '^SERVER_IP=' "$ENV" || echo "SERVER_IP=$IP" >> "$ENV"
}

render() { # $1 = space list; $2 = "http" to emit a bootstrap HTTP-only config (before the first certificate exists)
  local names
  names=$(with_www "$1" | xargs)
  if [ "${2:-}" = "http" ] || [ ! -f "/etc/letsencrypt/live/$CERT/fullchain.pem" ]; then
    # no certificate yet: plain HTTP so certbot --nginx has a server block to work with
    cat > "$CONF" <<EOF
upstream arm_web { server 127.0.0.1:3100; }
upstream arm_api { server 127.0.0.1:3101; }
server {
    listen 80;
    server_name $names;
    location /api/ { proxy_pass http://arm_api; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; }
    location / { proxy_pass http://arm_web; proxy_set_header Host \$host; }
}
EOF
  else
    sed "s|__SERVER_NAMES__|$names|g" "$TPL" > "$CONF"
  fi
  nginx -t >/dev/null 2>&1 || { nginx -t; return 1; }
  systemctl reload nginx
}

issue() { # $1 = space list of domains whose DNS is verified
  local args="" d
  for d in $(with_www "$1"); do args="$args -d $d"; done
  [ -n "$args" ] || { echo "no domain has DNS pointing here yet; certificate unchanged"; return 0; }
  # shellcheck disable=SC2086
  certbot --nginx --cert-name "$CERT" --expand $args --non-interactive --agree-tos --register-unsafely-without-email --redirect >/tmp/certbot.log 2>&1 \
    || { tail -20 /tmp/certbot.log; return 1; }
  grep -E "Successfully|Certificate not yet due|no action" /tmp/certbot.log | head -2 || true
}

apply() { # $1 = space list (the new full set)
  local want="$1" ready="" d r
  echo "server ip: $IP"
  for d in $want; do
    r=$(resolves "$d"); if is_apex "$d"; then rw=$(resolves "www.$d"); else rw=$r; fi
    if [ "$r" = "$IP" ] && [ "$rw" = "$IP" ]; then ready="$ready $d"; echo "  $d: DNS ok"; else echo "  $d: DNS not ready (@=${r:-none} www=${rw:-none}) — listed, but no certificate until it resolves"; fi
  done
  ready=$(echo "$ready" | xargs)
  save_env "$want"
  if [ ! -f "/etc/letsencrypt/live/$CERT/fullchain.pem" ]; then
    render "$want" http
    issue "$ready"
  else
    render "$want"
    issue "$ready"
  fi
  render "$want"   # final: full template with the (possibly new) certificate
  systemctl restart arm-indexer >/dev/null 2>&1 && echo "indexer restarted with PUBLIC_DOMAINS=$(current | tr ' ' ',')"
  echo "DOMAINS_OK"
}

cmd=${1:-list}
case "$cmd" in
  list)
    echo "server ip: $IP"
    echo "domains: $(current)"
    for d in $(current); do echo "  $d  @=$(resolves "$d" || echo none)  www=$(resolves "www.$d" || echo none)  https=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "https://$d/" || echo err)"; done
    echo "certificate:"; certbot certificates --cert-name "$CERT" 2>/dev/null | grep -E "Domains|Expiry" | sed 's/^ */  /' || echo "  (none)"
    ;;
  set)    apply "$(echo "${2:-}" | tr ',' ' ' | xargs)" ;;
  add)    apply "$(echo "$(current) ${2:?domain}" | tr ' ' '\n' | awk 'NF' | awk '!seen[$0]++' | xargs)" ;;
  remove) apply "$(current | tr ' ' '\n' | grep -vx "${2:?domain}" | xargs)" ;;
  render) render "$(current)"; echo "rendered for: $(current)" ;;
  *) echo "usage: domains.sh list | set \"a.com b.com\" | add d.com | remove d.com | render"; exit 2 ;;
esac
