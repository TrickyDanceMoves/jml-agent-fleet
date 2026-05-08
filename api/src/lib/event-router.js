'use strict';

const AGENT_MAP = {
  hire:      'joiner',
  terminate: 'leaver',
  transfer:  'mover'
};

function routeEvent(event) {
  const agent = AGENT_MAP[event.eventType];
  if (!agent) throw new Error(`Unknown eventType: ${event.eventType}`);
  return agent;
}

module.exports = { routeEvent };
