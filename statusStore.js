// Shared state — tracks live NodeLink node status from NodeLink events
const nodes = new Map();
// nodes: name -> { status, connectedAt, ping, reconnects }

module.exports = {
  setNode(name, data) { nodes.set(name, { ...(nodes.get(name) || {}), ...data }); },
  getNodes() { return nodes; },
};
