'use strict';

const API_KEY = process.env.JML_API_KEY;

function requireApiKey(request) {
  if (!API_KEY) {
    throw new Error('JML_API_KEY environment variable not set');
  }
  const provided = request.headers.get('x-api-key');
  if (!provided || provided !== API_KEY) {
    return { authorized: false };
  }
  return { authorized: true };
}

module.exports = { requireApiKey };
