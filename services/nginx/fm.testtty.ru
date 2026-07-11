# Freimarkets — unified wallet + market on one origin. One https origin carries the static app,
# the WS light-client bridges (main/regtest/nv3), snapshots and the /api relay.
server {
    server_name fm.testtty.ru;

    # WebSocket light-client bridges (mainnet / regtest / Freimarkets-nv3)
    location /ws/main {
        proxy_pass http://127.0.0.1:3041;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
    location /ws/regtest {
        proxy_pass http://127.0.0.1:3040;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
    location /ws/nv3 {
        proxy_pass http://127.0.0.1:3055;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

    # header/filter snapshots (Range passes through)
    location /snap/ {
        proxy_pass http://127.0.0.1:3050/;
        proxy_set_header Range $http_range;
    }

    # Freimarkets relay (order book, issuance, broadcast)
    location /api/ {
        proxy_pass http://127.0.0.1:5181/api/;
        proxy_set_header Host $host;
    }

    # the unified app (single index.html)
    location / {
        proxy_pass http://127.0.0.1:5173;
    }

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/fm.testtty.ru/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/fm.testtty.ru/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot

}

server {
    if ($host = fm.testtty.ru) {
        return 301 https://$host$request_uri;
    } # managed by Certbot


    listen 80;
    server_name fm.testtty.ru;
    return 404; # managed by Certbot


}