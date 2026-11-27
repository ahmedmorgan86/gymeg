FROM wppconnect/wppconnect-server:2.10.99

COPY apply-wpp-patches.mjs /tmp/apply-wpp-patches.mjs
RUN node /tmp/apply-wpp-patches.mjs /usr/src/wpp-server && rm -f /tmp/apply-wpp-patches.mjs
