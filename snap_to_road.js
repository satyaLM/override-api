import fetch from "node-fetch";
import logger from './logger.js';

const DISTANCE_M = process.env.SNAP_EXTRAPOLATE_DISTANCE_M ? parseFloat(process.env.SNAP_EXTRAPOLATE_DISTANCE_M) : 10;
const BEARING_TOLERANCE = process.env.BEARING_TOLERANCE ? parseFloat(process.env.BEARING_TOLERANCE) : 45;
const INITIAL_RADIUS = process.env.INITIAL_RADIUS ? parseFloat(process.env.INITIAL_RADIUS) : 50;
const MAX_RADIUS = process.env.MAX_RADIUS ? parseFloat(process.env.MAX_RADIUS) : 100;
const EARTH_RADIUS = process.env.EARTH_RADIUS ? parseFloat(process.env.EARTH_RADIUS) : 6371e3;
const USA_NGROK_API = process.env.USA_NGROK_API;
const OVERPASS_API = process.env.OVERPASS_API;

function bearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return (θ * 180 / Math.PI + 360) % 360;
}

function angleDiff(a, b) {
  let diff = Math.abs(((b - a + 180) % 360) - 180);
  if (diff > 180) diff = 360 - diff;
  return diff;
}

function extrapolate(lat, lon, bearingDeg, distance = DISTANCE_M) {
  const R = EARTH_RADIUS;
  const reverseBearing = (bearingDeg - 180 + 360) % 360;
  const brng = reverseBearing * Math.PI / 180;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distance / R) +
    Math.cos(lat1) * Math.sin(distance / R) * Math.cos(brng)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * Math.sin(distance / R) * Math.cos(lat1),
    Math.cos(distance / R) - Math.sin(lat1) * Math.sin(lat2)
  );
  return { lat: lat2 * 180 / Math.PI, lon: lon2 * 180 / Math.PI };
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const A = px - ax, B = py - ay;
  const C = bx - ax, D = by - ay;
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = lenSq !== 0 ? dot / lenSq : -1;
  let xx, yy;
  if (param < 0) { xx = ax; yy = ay; }
  else if (param > 1) { xx = bx; yy = by; }
  else { xx = ax + param * C; yy = ay + param * D; }
  return { distance: Math.hypot(px - xx, py - yy), projection: Math.max(0, Math.min(1, param)) };
}

function getOnewayDirection(way) {
  const t = way.tags || {};
  const oneway = t.oneway;
  const roundabout = t.junction === "roundabout";
  if (roundabout || oneway === "yes" || oneway === "1" || oneway === "true") {
    return { forward: true, reverse: false };
  }
  if (oneway === "-1" || oneway === "reverse") {
    return { forward: false, reverse: true };
  }
  return { forward: true, reverse: true };
}

async function snapUSAProgressive(lat, lon, bearingDeg) {
  let radius = INITIAL_RADIUS;
  let best = null;
  logger.info(`[USA API] Starting progressive search`);
  while (radius <= MAX_RADIUS && !best) {
    const url = `${USA_NGROK_API}?lat=${lat.toFixed(8)}&lon=${lon.toFixed(8)}&bearing=${bearingDeg.toFixed(1)}&radius=${radius}`;
    logger.info(`[USA API] Trying radius=${radius.toFixed(1)}m → ${url}`);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (resp.status === 404 || resp.status === 504 || resp.status === 429 || resp.status === 408 || !resp.ok) {
        logger.info(`[USA API] ${resp.status} → falling back to Overpass API`);
        return null;  // Trigger fallback
      } else {
        const data = await resp.json();
        if (data && data.lat && data.lon) {
          logger.snap(`[USA API] Snapped at ${radius.toFixed(1)}m → ${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}`);
          best = {
            lat: data.lat,
            lon: data.lon,
            roadBearing: data.bearing || bearingDeg,
            wayId: data.way_id || null,
            wayName: data.way_name || null,
            radiusUsed: radius,
          };
          break;
        } else {
          logger.info(`[USA API] No snap at ${radius.toFixed(1)}m → falling back to Overpass API`);
          return null;  
        }
      }
    } catch (err) {
      logger.error(`[USA API] Error: ${err.message} → falling back to Overpass API`);
      return null;  
    }
  }
  return best;
}

async function snapOverpass(extrLat, extrLon) {
  let radius = INITIAL_RADIUS;
  let best = null;
  logger.info(`[Overpass] Starting progressive search`);
  while (radius <= MAX_RADIUS && !best) {
    const ql = `[out:json][timeout:30];way(around:${radius},${extrLat},${extrLon})[highway];out geom tags;`;
    logger.info(`[Overpass] Searching ${radius.toFixed(1)}m around ${extrLat.toFixed(6)}, ${extrLon.toFixed(6)}`);
    let shouldRetry = false;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(OVERPASS_API, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(ql)}`,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (resp.status === 504 || resp.status === 429 || resp.status === 408 || !resp.ok) {
        logger.warn(`[Overpass] ${resp.status} → retrying after 2s...`);
        shouldRetry = true;
      } else {
        const data = await resp.json();
        const ways = data.elements.filter(w => w.geometry && w.geometry.length >= 2 && w.tags);
        if (ways.length === 0) {
          logger.info(`[Overpass] No roads in ${radius.toFixed(1)}m → increasing radius`);
          shouldRetry = true;
        } else {
          logger.success(`[Overpass] Found ${ways.length} road(s) in ${radius.toFixed(1)}m → snapping...`);
          for (const way of ways) {
            const dir = getOnewayDirection(way);
            for (let i = 0; i < way.geometry.length - 1; i++) {
              const a = way.geometry[i];
              const b = way.geometry[i + 1];
              const segBearing = bearing(a.lat, a.lon, b.lat, b.lon);
              const candidates = [];
              if (dir.forward) candidates.push(segBearing);
              if (dir.reverse) candidates.push((segBearing + 180) % 360);
              for (const roadBearing of candidates) {
                const d = distanceToSegment(extrLat, extrLon, a.lat, a.lon, b.lat, b.lon);
                if (!best || d.distance < best.distance) {
                  const proj = d.projection;
                  best = {
                    lat: a.lat + (b.lat - a.lat) * proj,
                    lon: a.lon + (b.lon - a.lon) * proj,
                    distance: d.distance,
                    roadBearing,
                    wayId: way.id,
                    wayName: way.tags.name || way.tags.ref || null,
                    radiusUsed: radius,
                  };
                }
              }
            }
          }
          if (best) {
            logger.snap(`[Overpass] Snapped at ${radius.toFixed(1)}m → ${best.lat.toFixed(6)}, ${best.lon.toFixed(6)}`);
            break;
          } else {
            logger.info(`[Overpass] No valid bearing match in ${radius.toFixed(1)}m → increasing radius`);
            shouldRetry = true;
          }
        }
      }
    } catch (err) {
      logger.warn(`[Overpass] ${err.name === 'AbortError' ? 'Timeout' : 'Error'}: ${err.message} → retrying`);
      shouldRetry = true;
    }
    if (shouldRetry) {
      await new Promise(r => setTimeout(r, 2000));
      const nextRadius = radius * 1.5;
      if (nextRadius > MAX_RADIUS) {
        logger.warn(`[Overpass] MAX_RADIUS=${MAX_RADIUS}m reached → stopping`);
        break;
      }
      radius = nextRadius;
    }
  }
  if (!best) {
    logger.info(`[Overpass] No snap found within ${MAX_RADIUS}m → using extrapolated point`);
  }
  return best;
}

export async function snapToNearestRoadWithDirection(cluster) {
  const { cluster_id, lat: origLat, lon: origLon, bearing: origBearingDeg, country_code_iso3 } = cluster;
  logger.info(`Requested for:  [${cluster_id}] | country: ${country_code_iso3} |latitude & longitude: ${origLat.toFixed(6)}, ${origLon.toFixed(6)} | bearing: ${origBearingDeg.toFixed(1)}°`);
  const extr = extrapolate(origLat, origLon, origBearingDeg);
  logger.info(` Extrapolated latitude & longitude:  ${extr.lat.toFixed(6)}, ${extr.lon.toFixed(6)}`);
  let bestSnap = null;
  if (country_code_iso3 === 'USA' || country_code_iso3 === 'US') {
    bestSnap = await snapUSAProgressive(extr.lat, extr.lon, origBearingDeg);
    if (!bestSnap) {
      logger.info(`[USA API] Fallback triggered → switching to Overpass API`);
      bestSnap = await snapOverpass(extr.lat, extr.lon);
    }
  } else {
    bestSnap = await snapOverpass(extr.lat, extr.lon);
  }
  let result;
  if (!bestSnap) {
    result = {
      cluster_id,
      original_lat: origLat,    
      original_lon: origLon,     
      lat: extr.lat,
      lon: extr.lon,
      bearing: origBearingDeg,
      method: "extrapolated_no_snap",
      message: `No snap point found for ${cluster_id} → using extrapolated point`,
    };
    logger.info(`[Result] ${result.message}`);
    logger.info(` **FINAL POINT**: ${result.lat.toFixed(6)}, ${result.lon.toFixed(6)} (extrapolated)`);
  } else {
    const snapBearing = bestSnap.roadBearing || origBearingDeg;
    const bearingDiff = angleDiff(origBearingDeg, snapBearing);
    if (bearingDiff <= BEARING_TOLERANCE) {
      result = {
        cluster_id,
        original_lat: origLat,    
        original_lon: origLon,
        lat: bestSnap.lat,
        lon: bestSnap.lon,
        bearing: snapBearing,
        method: "snapped_accepted",
        message: `Snapped to road for id: ${cluster_id} (bearing: ${snapBearing.toFixed(1)}°, diff: ${bearingDiff.toFixed(1)}°)`,
        way_id: bestSnap.wayId || null,
        way_name: bestSnap.wayName || null,
      };
      logger.info(`[Result] ${result.message}`);
      logger.info(` **FINAL SNAPPED POINT**: ${result.lat.toFixed(6)}, ${result.lon.toFixed(6)}`);
    } else {
      result = {
        cluster_id,
        original_lat: origLat,    
        original_lon: origLon,
        lat: extr.lat,
        lon: extr.lon,
        bearing: origBearingDeg,
        method: "bearing_rejected",
        message: `Bearing mismatch ${bearingDiff.toFixed(1)}° > ±45° for id: ${cluster_id} → using extrapolated point`,
      };
      logger.info(`[Result] ${result.message}`);
      logger.info(` **FINAL POINT**: ${result.lat.toFixed(6)}, ${result.lon.toFixed(6)} (extrapolated)`);
    }
  }
  return result;
}

export { extrapolate, bearing, angleDiff };

