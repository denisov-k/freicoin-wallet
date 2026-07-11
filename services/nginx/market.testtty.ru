# Freimarkets market — its own TLS origin. Serves the market page and proxies the relay API
# (/api -> :5181) and the market P2P bridge (/ws -> :3055), so the page stays same-origin
# (no mixed content) and the light client + relay both ride wss/https.
server {
    if ($host = market.testtty.ru) {
        return 301 https://$host$request_uri;
    } # managed by Certbot


    listen 80;
    server_name market.testtty.ru;
    return 301 https://$host$request_uri;


}
server {
    listen 443 ssl;
    server_name market.testtty.ru;
    # placeholder cert until certbot issues the real one (reuse wallet's so nginx starts)
    ssl_certificate /etc/letsencrypt/live/market.testtty.ru/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/market.testtty.ru/privkey.pem; # managed by Certbot

    # market P2P bridge (light-client reads) -> the nV3 node's bridge
    location /ws {
        proxy_pass http://127.0.0.1:3055;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
    # relay API (order book, faucet, issue, tx broadcast)
    location /api/ {
        proxy_pass http://127.0.0.1:5181/api/;
        proxy_set_header Host $host;
    }
    # the market page: '/' serves market.html from the same dist fw-web hosts
    location = / { proxy_pass http://127.0.0.1:5173/market.html; }
    location / { proxy_pass http://127.0.0.1:5173; }

}
