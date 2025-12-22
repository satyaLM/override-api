// snap_to_road.js
import fetch from 'node-fetch';
import logger from './logger.js';

// Configuration constants (configurable via env)
const CONFIG = {
  EXTRAPOLATE_DISTANCE_M: process.env.SNAP_EXTRAPOLATE_DISTANCE_M
    ? parseFloat(process.env.SNAP_EXTRAPOLATE_DISTANCE_M)
    : 50,
  BEARING_TOLERANCE_DEG: process.env.BEARING_TOLERANCE
    ? parseFloat(process.env.BEARING_TOLERANCE)
    : 45,
  INITIAL_SEARCH_RADIUS_M: process.env.INITIAL_RADIUS
    ? parseFloat(process.env.INITIAL_RADIUS)
    : 50,
  MAX_SEARCH_RADIUS_M: process.env.MAX_RADIUS
    ? parseFloat(process.env.MAX_RADIUS)
    : 100,
  EARTH_RADIUS_M: process.env.EARTH_RADIUS
    ? parseFloat(process.env.EARTH_RADIUS)
    : 6371e3,
  FETCH_TIMEOUT_MS: 15000,
  OVERPASS_RETRY_DELAY_MS: 2000,
  RADIUS_GROWTH_FACTOR: 1.5,
};

const API = {
  USA_LOCAL_SERVER: process.env.USA_NGROK_API,
  OVERPASS: process.env.OVERPASS_API,
};

// === Utility Math Functions ===
export function bearing(lat1, lon1, lat2, lon2) {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);

  return (θ * 180 / Math.PI + 360) % 360;
}

export function angleDiff(deg1, deg2) {
  let diff = Math.abs(((deg2 - deg1 + 180) % 360) - 180);
  return diff <= 180 ? diff : 360 - diff;
}

export function extrapolate(lat, lon, bearingDeg, distanceM = CONFIG.EXTRAPOLATE_DISTANCE_M) {
  const R = CONFIG.EARTH_RADIUS_M;
  const reverseBearingRad = ((bearingDeg - 180 + 360) % 360) * Math.PI / 180;

  const lat1Rad = (lat * Math.PI) / 180;
  const lon1Rad = (lon * Math.PI) / 180;

  const lat2Rad = Math.asin(
    Math.sin(lat1Rad) * Math.cos(distanceM / R) +
    Math.cos(lat1Rad) * Math.sin(distanceM / R) * Math.cos(reverseBearingRad)
  );

  const lon2Rad =
    lon1Rad +
    Math.atan2(
      Math.sin(reverseBearingRad) * Math.sin(distanceM / R) * Math.cos(lat1Rad),
      Math.cos(distanceM / R) - Math.sin(lat1Rad) * Math.sin(lat2Rad)
    );

  return {
    lat: (lat2Rad * 180) / Math.PI,
    lon: (lon2Rad * 180) / Math.PI,
  };
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const A = px - ax;
  const B = py - ay;
  const C = bx - ax;
  const D = by - ay;

  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = lenSq !== 0 ? dot / lenSq : -1;

  let closestX, closestY;
  if (param < 0) {
    closestX = ax;
    closestY = ay;
  } else if (param > 1) {
    closestX = bx;
    closestY = by;
  } else {
    closestX = ax + param * C;
    closestY = ay + param * D;
  }

  const distance = Math.hypot(px - closestX, py - closestY);
  const projection = Math.max(0, Math.min(1, param));

  return { distance, projection, closestX, closestY };
}

function getOnewayDirection(tags = {}) {
  const oneway = tags.oneway;
  const isRoundabout = tags.junction === 'roundabout';

  if (isRoundabout || oneway === 'yes' || oneway === '1' || oneway === 'true') {
    return { forward: true, reverse: false };
  }
  if (oneway === '-1' || oneway === 'reverse') {
    return { forward: false, reverse: true };
  }
  return { forward: true, reverse: true };
}

// === API Snapping Functions ===
async function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

async function snapViaLocalServer(targetLat, targetLon, vehicleBearingDeg) {
  let radius = CONFIG.INITIAL_SEARCH_RADIUS_M;

  logger.info('[LocalServer] Starting progressive search for nearest road');

  while (radius <= CONFIG.MAX_SEARCH_RADIUS_M) {
    const url = `${API.USA_LOCAL_SERVER}?lat=${targetLat.toFixed(8)}&lon=${targetLon.toFixed(8)}&bearing=${vehicleBearingDeg.toFixed(1)}&radius=${radius}`;

    logger.info(`[LocalServer] Trying radius=${radius.toFixed(1)}m`);

    try {
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        if ([404, 504, 429, 408].includes(response.status)) {
          logger.info(`[LocalServer] HTTP ${response.status} → falling back to Overpass`);
          return null;
        }
        logger.warn(`[LocalServer] Unexpected status ${response.status}`);
      }

      const data = await response.json();

      if (data?.lat && data?.lon) {
        logger.snap(`[LocalServer] SUCCESS at ${radius}m → (${data.lat.toFixed(6)}, ${data.lon.toFixed(6)})`);
        return {
          lat: data.lat,
          lon: data.lon,
          roadBearing: data.bearing ?? vehicleBearingDeg,
          wayId: data.way_id ?? null,
          wayName: data.way_name ?? null,
          radiusUsed: radius,
          source: 'local_server',
        };
      }

      logger.info(`[LocalServer] No result at ${radius}m → trying larger radius`);
    } catch (error) {
      logger.error(`[LocalServer] Request failed: ${error.message}`);
      return null; // Always fallback on any error
    }

    radius *= CONFIG.RADIUS_GROWTH_FACTOR;
  }

  logger.info('[LocalServer] Max radius reached without result → fallback');
  return null;
}

async function snapViaOverpass(targetLat, targetLon) {
  let radius = CONFIG.INITIAL_SEARCH_RADIUS_M;
  let bestMatch = null;

  logger.info('[Overpass] Starting progressive road search');

  while (radius <= CONFIG.MAX_SEARCH_RADIUS_M && !bestMatch) {
    const overpassQuery = `[out:json][timeout:30];
    way(around:${radius},${targetLat.toFixed(8)},${targetLon.toFixed(8)})[highway];
    out geom tags;`;

    logger.info(`[Overpass] Querying roads within ${radius.toFixed(1)}m`);

    let shouldContinue = true;

    try {
      const response = await fetchWithTimeout(API.OVERPASS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(overpassQuery)}`,
      });

      if (!response.ok) {
        logger.warn(`[Overpass] HTTP ${response.status} → retrying`);
        shouldContinue = true;
      } else {
        const { elements } = await response.json();
        const ways = elements.filter((w) => w.type === 'way' && w.geometry?.length >= 2 && w.tags);

        if (ways.length === 0) {
          logger.info(`[Overpass] No highways found in ${radius}m → increasing radius`);
          shouldContinue = true;
        } else {
          logger.success(`[Overpass] Found ${ways.length} road(s) → evaluating segments`);

          for (const way of ways) {
            const direction = getOnewayDirection(way.tags);
            const segments = way.geometry;

            for (let i = 0; i < segments.length - 1; i++) {
              const start = segments[i];
              const end = segments[i + 1];
              const segmentBearing = bearing(start.lat, start.lon, end.lat, end.lon);

              const candidateBearings = [];
              if (direction.forward) candidateBearings.push(segmentBearing);
              if (direction.reverse) candidateBearings.push((segmentBearing + 180) % 360);

              for (const roadBearing of candidateBearings) {
                const { distance, projection, closestX, closestY } = distanceToSegment(
                  targetLat,
                  targetLon,
                  start.lat,
                  start.lon,
                  end.lat,
                  end.lon
                );

                if (!bestMatch || distance < bestMatch.distance) {
                  bestMatch = {
                    lat: closestX,
                    lon: closestY,
                    distance,
                    roadBearing,
                    wayId: way.id,
                    wayName: way.tags.name || way.tags.ref || null,
                    radiusUsed: radius,
                    source: 'overpass',
                  };
                }
              }
            }
          }

          if (bestMatch) {
            logger.snap(`[Overpass] Best snap at ${radius}m → (${bestMatch.lat.toFixed(6)}, ${bestMatch.lon.toFixed(6)})`);
            break;
          } else {
            logger.info(`[Overpass] No suitable bearing match → increasing radius`);
            shouldContinue = true;
          }
        }
      }
    } catch (error) {
      logger.warn(`[Overpass] ${error.name === 'AbortError' ? 'Timeout' : 'Error'}: ${error.message}`);
      shouldContinue = true;
    }

    if (shouldContinue) {
      await new Promise((resolve) => setTimeout(resolve, CONFIG.OVERPASS_RETRY_DELAY_MS));
      radius *= CONFIG.RADIUS_GROWTH_FACTOR;
      if (radius > CONFIG.MAX_SEARCH_RADIUS_M) {
        logger.warn(`[Overpass] Max radius reached (${CONFIG.MAX_SEARCH_RADIUS_M}m)`);
        break;
      }
    }
  }

  return bestMatch;
}

// === Main Export ===
export async function snapToNearestRoadWithDirection({ cluster_id, lat: origLat, lon: origLon, bearing: origBearingDeg, country_code_iso3 }) {
  logger.info(
    `[Snap Request] ID: ${cluster_id} | Country: ${country_code_iso3} | Pos: (${origLat.toFixed(6)}, ${origLon.toFixed(6)}) | Bearing: ${origBearingDeg.toFixed(1)}°`
  );

  const extrapolatedPoint = extrapolate(origLat, origLon, origBearingDeg);
  logger.info(`[Extrapolated] → (${extrapolatedPoint.lat.toFixed(6)}, ${extrapolatedPoint.lon.toFixed(6)})`);

  let snapResult = null;

  // Decide which snapping strategy to use
  if (country_code_iso3 === 'USA' || country_code_iso3 === 'US') {
    snapResult = await snapViaLocalServer(extrapolatedPoint.lat, extrapolatedPoint.lon, origBearingDeg);
    if (!snapResult) {
      logger.info('[Fallback] Local server failed → using Overpass');
      snapResult = await snapViaOverpass(extrapolatedPoint.lat, extrapolatedPoint.lon);
    }
  } else {
    snapResult = await snapViaOverpass(extrapolatedPoint.lat, extrapolatedPoint.lon);
  }

  // Final decision: accept snap or fall back to extrapolated point
  if (!snapResult) {
    const result = {
      cluster_id,
      original_lat: origLat,
      original_lon: origLon,
      lat: extrapolatedPoint.lat,
      lon: extrapolatedPoint.lon,
      bearing: origBearingDeg,
      method: 'extrapolated_no_snap',
      message: `No road found within ${CONFIG.MAX_SEARCH_RADIUS_M}m → using extrapolated point`,
    };
    logger.info(`[FINAL] ${result.message}`);
    return result;
  }

  const bearingDiff = angleDiff(origBearingDeg, snapResult.roadBearing);

  if (bearingDiff <= CONFIG.BEARING_TOLERANCE_DEG) {
    const result = {
      cluster_id,
      original_lat: origLat,
      original_lon: origLon,
      lat: snapResult.lat,
      lon: snapResult.lon,
      bearing: snapResult.roadBearing,
      way_id: snapResult.wayId,
      way_name: snapResult.wayName,
      method: 'snapped_accepted',
      message: `Snapped successfully (bearing diff: ${bearingDiff.toFixed(1)}°)`,
    };
    logger.info(`[FINAL] ${result.message} → (${result.lat.toFixed(6)}, ${result.lon.toFixed(6)})`);
    return result;
  } else {
    const result = {
      cluster_id,
      original_lat: origLat,
      original_lon: origLon,
      lat: extrapolatedPoint.lat,
      lon: extrapolatedPoint.lon,
      bearing: origBearingDeg,
      method: 'bearing_rejected',
      message: `Bearing mismatch (${bearingDiff.toFixed(1)}° > ±${CONFIG.BEARING_TOLERANCE_DEG}°) → using extrapolated point`,
    };
    logger.info(`[FINAL] ${result.message}`);
    return result;
  }
}