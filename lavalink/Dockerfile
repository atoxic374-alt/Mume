FROM ghcr.io/bon5co/lavalink-railway:4.2.2

# The base image already contains Lavalink 4.2.2 and youtube-plugin 1.18.2.
# Keep both plugin JARs in this service directory so Railway builds a
# reproducible image and Spotify support does not depend on a boot-time fetch.
COPY lavalink/plugins/ /opt/Lavalink/plugins/
COPY lavalink/application.yml /opt/Lavalink/application.yml
