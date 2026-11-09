# Mume Cinema — Discord Embedded Activity

Mume Cinema is a standalone watch-party service for the Mume Discord application. It is isolated from Poru/Lavalink and does not change music playback.

## Included

- Discord Embedded App SDK 2.5.0 authorization and client authentication.
- Responsive catalog UI for movies, series and anime.
- TMDB trending/search metadata for movies and series.
- Consumet anime search metadata through an instance you configure.
- Private rooms with invite codes and public rooms.
- Host/owner permissions, host handoff, participant removal, invite rotation, participant presence and reconnect handling.
- Shared play/pause/seek/load, drift correction, bounded/reorderable queue, remove-own-item rules, skip voting and next-item controls.
- Room chat, emoji reactions, participant list, and host settings for chat, queue, sync, loop, visibility and room name.
- Short-lived in-memory metadata cache and per-user catalog/room creation rate limits.
- MP4/WebM and HLS playback, device-local volume/speed, fullscreen, picture-in-picture and WebVTT subtitles.
- WebSocket heartbeat, bounded payloads, rate limits, authentication, validation and graceful shutdown.
- PostgreSQL room persistence when DATABASE_URL is configured; otherwise atomic local JSON persistence.

## Start

From the repository root run npm install, then npm run start:cinema. The Replit Project workflow also starts the cinema service on port 3010 alongside the music bot. Set the variables in cinema/.env.example in your hosting environment. The service listens on CINEMA_HOST:CINEMA_PORT (default 0.0.0.0:3010). Health check: /health.

## Discord Developer Portal

1. Open the Mume application in the Discord Developer Portal.
2. Enable Activities / Embedded App and configure Activity URL Mapping to the HTTPS origin hosting this service.
3. Under OAuth2 → Redirects, add the Embedded Activity placeholder redirect https://127.0.0.1.
4. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in the service environment. Set DISCORD_REDIRECT_URI=https://127.0.0.1 to exactly match the registered redirect.
5. Enable the Activity Entry Point command. Discord creates a default Launch command when Activities are enabled; users launch Cinema from the App Launcher.
6. Keep the client secret server-side. Never put it in the frontend or commit it to Git.

## Catalog providers

TMDB_API_KEY enables movie/series trending and search metadata. CONSUMET_API_URL points to a Consumet instance you operate; the integration uses anime search only. Search results are metadata and posters, not verified media sources. The Activity does not call third-party episode extractors or claim that a title is playable.

## Playback and rights

The player supports direct HTTPS MP4/WebM and HLS sources. The host must provide a source they own or are authorized to use. Browser CORS, codec support and source availability still apply. CINEMA_ALLOWED_MEDIA_HOSTS can restrict media URLs to approved hostnames. Subtitles are WebVTT URLs loaded locally on each participant device.

## Storage and scale

PostgreSQL is recommended for persistent deployments. Set DATABASE_URL; the service creates and updates the cinema_rooms table automatically. Without PostgreSQL, snapshots are written atomically to cinema/data/rooms.json; use persistent disk storage for that directory. This implementation is a single active WebSocket service instance. Do not horizontally scale multiple instances yet: shared database persistence alone does not provide cross-instance WebSocket fan-out or conflict-free room transactions. Add a pub/sub coordinator and transactional room versioning before multi-instance deployment. Room state is saved with a short debounce and on graceful shutdown; abrupt termination can lose the most recent debounce window.

## Operational notes

Use HTTPS in production. Never commit .env, Discord secrets, API keys, database credentials, or private media URLs. The Discord Activity must be enabled and deployed in the Developer Portal before it can be launched. Code changes alone cannot complete those external steps.
