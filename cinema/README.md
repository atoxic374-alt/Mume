# Mume Cinema Activity

An isolated Discord Embedded App / Activity service. It does not use or modify Lavalink, Poru, or music playback.

## Current scope

- Discord Embedded App SDK bootstrap and OAuth2 authorization-code exchange.
- Room WebSocket for shared play, pause, seek, and media-load state.
- TMDB movie/series metadata search when \`TMDB_API_KEY\` is configured.
- Consumet anime catalog search through your own \`CONSUMET_API_URL\` instance.
- Direct HTTPS video playback only when the room host supplies a source they are authorized to use.

Catalog providers return metadata only. The service deliberately does not call Consumet episode-stream/extractor endpoints or present catalog search results as playable streams.

## Run

1. Copy \`.env.example\` to the environment used by your host and fill in the values.
2. Install the repository dependencies with \`npm install\` (the root project already includes \`axios\` and \`ws\`).
3. Start the standalone service with \`node cinema/server.js\`.
4. Configure the Discord application as an Embedded App / Activity and map its HTTPS URL to this service.
5. Set the Activity URL to the deployed service URL. For a room, append \`?room=room-name\`.

The OAuth redirect URI must exactly match the URI registered in the Discord Developer Portal. Keep the client secret server-side; never put it in the Activity page.

## Important limitations

- HTTPS hosting and Discord Developer Portal configuration are required before the Activity can launch in Discord.
- A public Consumet API is not bundled. Configure an instance you control; availability and provider behavior depend on that instance.
- TMDB API credentials are optional and are not included.
- Catalog metadata does not grant streaming rights. The player accepts direct HTTPS media URLs supplied by the host; browser codec/CORS rules still apply.
- The first connected participant becomes room host. Room state is in memory and resets when this process restarts. Run one service instance unless you add shared pub/sub and persistent room storage.
- This is an initial integration layer, not a claim that every title has a playable source or that a legal infinite catalog exists.
