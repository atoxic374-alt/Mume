// Shared state — tracks live Lavalink node status from Poru events
const nodes = new Map();
// nodes: name -> { status, connectedAt, ping, reconnects }

module.exports = {
  setNode(name, data) { nodes.set(name, { ...(nodes.get(name) || {}), ...data }); },
  getNodes() { return nodes; },
};
