FROM alpine:3.22

RUN apk add --no-cache curl jq

COPY lavalink/pot-refresher/refresh.sh /refresh.sh
RUN chmod 755 /refresh.sh

ENTRYPOINT ["/refresh.sh"]
