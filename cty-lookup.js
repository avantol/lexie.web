const fs = require('fs');
const path = require('path');

// Parse cty.dat and build lookup structures
// Format: each entity starts with a header line, followed by prefix lines ending with ;
// Header: "Entity Name: CQzone: ITUzone: Continent: Lat: Lon: UTC: PrimaryPrefix:"
// Prefixes can have modifiers: =CALL (exact), (CQ) [ITU] {cont} <lat/lon> ~UTC

function loadCtyDat(filePath) {
  const data = fs.readFileSync(filePath || path.join(__dirname, 'cty.dat'), 'utf8');
  const lines = data.split('\n');

  const exactMatches = new Map();   // callsign -> entity name
  const prefixMatches = [];         // [{ prefix, entity }] sorted longest first
  const entityCoords = new Map();   // entity name -> { lat, lon }

  let currentEntity = null;
  let prefixBuffer = '';

  for (const line of lines) {
    if (!line.trim()) continue;

    // Header line: doesn't start with whitespace
    if (line[0] !== ' ' && line[0] !== '\t') {
      // Flush previous entity
      if (currentEntity && prefixBuffer) {
        parsePrefixes(prefixBuffer, currentEntity, exactMatches, prefixMatches);
        prefixBuffer = '';
      }

      const parts = line.split(':');
      if (parts.length >= 8) {
        currentEntity = parts[0].trim();
        // cty.dat stores lon with inverted sign (west = positive)
        const lat = parseFloat(parts[4]);
        const lon = -parseFloat(parts[5]);
        if (!isNaN(lat) && !isNaN(lon)) {
          entityCoords.set(currentEntity, { lat, lon });
        }
      }
    } else {
      // Prefix continuation line
      prefixBuffer += line.trim();
    }
  }

  // Flush last entity
  if (currentEntity && prefixBuffer) {
    parsePrefixes(prefixBuffer, currentEntity, exactMatches, prefixMatches);
  }

  // Sort prefix matches by length descending (longest prefix wins)
  prefixMatches.sort((a, b) => b.prefix.length - a.prefix.length);

  return { exactMatches, prefixMatches, entityCoords };
}

function parsePrefixes(buffer, entity, exactMatches, prefixMatches) {
  // Remove trailing semicolon and split by comma
  buffer = buffer.replace(/;$/, '');
  const parts = buffer.split(',');

  for (let part of parts) {
    part = part.trim();
    if (!part) continue;

    // Strip zone/continent/latlon overrides: (CQ) [ITU] {cont} <lat/lon> ~UTC
    const cleaned = part.replace(/\([^)]*\)/g, '')
                        .replace(/\[[^\]]*\]/g, '')
                        .replace(/\{[^}]*\}/g, '')
                        .replace(/<[^>]*>/g, '')
                        .replace(/~[^,;]*/g, '')
                        .trim();

    if (!cleaned) continue;

    if (cleaned.startsWith('=')) {
      // Exact callsign match
      const call = cleaned.substring(1).toUpperCase();
      exactMatches.set(call, entity);
    } else {
      // Prefix match
      prefixMatches.push({ prefix: cleaned.toUpperCase(), entity });
    }
  }
}

// Convert lat/lon to 4-char Maidenhead grid
function latLonToGrid(lat, lon) {
  const adjLon = lon + 180;
  const adjLat = lat + 90;
  const field1 = String.fromCharCode(65 + Math.floor(adjLon / 20));
  const field2 = String.fromCharCode(65 + Math.floor(adjLat / 10));
  const sq1 = Math.floor((adjLon % 20) / 2);
  const sq2 = Math.floor(adjLat % 10);
  return field1 + field2 + sq1 + sq2;
}

function createLookup(filePath) {
  const { exactMatches, prefixMatches, entityCoords } = loadCtyDat(filePath);

  console.log(`CTY loaded: ${exactMatches.size} exact matches, ${prefixMatches.length} prefixes, ${entityCoords.size} entities with coords`);

  function entityGrid(entityName) {
    const coords = entityCoords.get(entityName);
    if (!coords) return null;
    return latLonToGrid(coords.lat, coords.lon);
  }

  function lookupCallsign(callsign) {
    const call = callsign.toUpperCase().replace(/\/.*$/, ''); // strip /P, /M, /QRP etc. from end
    // Also handle prefix/call format (e.g. EA8/S51TA -> use EA8 prefix)
    const slashParts = callsign.toUpperCase().split('/');
    let baseCall = call;
    let prefixOverride = null;

    if (slashParts.length === 2) {
      // Could be PREFIX/CALL or CALL/SUFFIX
      // If first part is shorter, it's likely a prefix override
      if (slashParts[0].length < slashParts[1].length) {
        prefixOverride = slashParts[0];
        baseCall = slashParts[1];
      } else {
        baseCall = slashParts[0];
      }
    }

    // 1. Try exact match on full callsign (without portable suffix)
    if (exactMatches.has(baseCall)) {
      return exactMatches.get(baseCall);
    }

    // 2. If there's a prefix override, try matching that
    if (prefixOverride) {
      for (const entry of prefixMatches) {
        if (prefixOverride.startsWith(entry.prefix) || prefixOverride === entry.prefix) {
          return entry.entity;
        }
      }
    }

    // 3. Longest prefix match on the base callsign
    for (const entry of prefixMatches) {
      if (baseCall.startsWith(entry.prefix)) {
        return entry.entity;
      }
    }

    return null; // Unknown
  }

  return { lookupCallsign, entityGrid };
}

module.exports = { createLookup };
