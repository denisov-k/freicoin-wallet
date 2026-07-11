# Freicoin wallet — TLS terminator. Everything (static app, both WS bridges, snapshots)
# rides one https origin so the self-signed cert is accepted once and wss inherits it.
server {
    if ($host = wallet.testtty.ru) {
        return 301 https://$host$request_uri;
    } # managed by Certbot


    listen 80;
    server_name wallet.testtty.ru;
    return 301 https://$host$request_uri;


}
server {
    listen 443 ssl;
    server_name wallet.testtty.ru;
    ssl_certificate /etc/letsencrypt/live/wallet.testtty.ru/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/wallet.testtty.ru/privkey.pem; # managed by Certbot

    # WebSocket bridges (mainnet / regtest)
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

    # Freimarkets relay (order book, issuance, broadcast) — the merged app hits same-origin /api
    location /api/ {
        proxy_pass http://127.0.0.1:5181/api/;
        proxy_set_header Host $host;
    }

    # mini block explorer
    location /explorer {
        proxy_pass http://127.0.0.1:3060;
    }

    # solo-mining instructions (static)
    location = /mine { alias /var/www/fw-mine/index.html; default_type text/html; }
    location = /about { alias /var/www/fw-landing/index.html; default_type text/html; }

    # the app has moved to the unified Freimarkets origin
    location / {
        return 301 https://f.testtty.ru$request_uri;
    }

}
