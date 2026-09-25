#!/usr/bin/env bash
echo '== nginx sites =='
ls /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null
grep -rhE 'server_name|listen|proxy_pass|root ' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | sed 's/^[ \t]*//' | sort -u
echo; echo '== certbot =='
ls /etc/letsencrypt/live 2>/dev/null
echo; echo '== /root/eco-deploy =='
ls -la /root/eco-deploy
echo; echo '== /root/eco-keys (names only) =='
ls -la /root/eco-keys | awk '{print $1, $5, $9}'
echo; echo '== /opt/solanft =='
ls -la /opt/solanft | head -30
echo; echo '== compose files =='
find /opt /root -maxdepth 3 -iname 'docker-compose*.y*ml' -o -maxdepth 3 -iname 'compose*.y*ml' 2>/dev/null
echo; echo '== docker resources =='
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' 2>/dev/null
docker system df 2>/dev/null
echo; echo '== docker networks =='
docker network ls --format '{{.Name}}'
