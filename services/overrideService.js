// services/overrideService.js
import overrideDao from '../dao/overrideDao.js';
import { snapToNearestRoadWithDirection, extrapolate } from '../snap_to_road.js';

class OverrideService {
  async createBatchOverride({ cluster_ids }) {
    // 1. Get validated cluster data from DB
    const dbResult = await overrideDao.getBatchClusterData(cluster_ids);
    const row = dbResult[0];

    if (!row || row.processed_count === 0) {
      return {
        processed_count: row?.processed_count || 0,
        failed_count: row?.failed_count || 0,
        failed_ids: row?.failed_ids || [],
        skipped_count: row?.skipped_count || 0,
        skipped_ids: row?.skipped_ids || [],
        processed_ids: [],
      };
    }

    const { cluster_data } = row;

    // 2. Snap each cluster to road
    const snapPromises = cluster_data.map(async (c) => {
      const snap = await snapToNearestRoadWithDirection(
        c.lat,
        c.lon,
        c.bearing,
        50,
        50
      );

      let finalLat, finalLon, finalBearing;

      if (snap && snap.method === 'overpass_snap') {
        finalLat = snap.lat;
        finalLon = snap.lon;
        finalBearing = snap.bearing;
      } else {
        // Fallback: use simple extrapolation (reverse bearing)
        const extr = extrapolate(c.lat, c.lon, c.bearing, 50);
        finalLat = extr.lat;
        finalLon = extr.lon;
        finalBearing = c.bearing; // keep original
      }

      return {
        cluster_id: c.cluster_id,
        lat: finalLat,
        lon: finalLon,
        bearing: finalBearing,
        accuracy: c.accuracy,
        speed_limit_read_by_engine: c.speed_limit_read_by_engine,
      };
    });

    const snappedOverrides = await Promise.all(snapPromises);

    // 3. Write to DB
    await overrideDao.writeBatchOverrides(snappedOverrides);

    // 4. Return summary
    const processedIds = snappedOverrides.map((o) => o.cluster_id);

    return {
      processed_count: processedIds.length,
      failed_count: row.failed_count,
      failed_ids: row.failed_ids,
      skipped_count: row.skipped_count,
      skipped_ids: row.skipped_ids,
      processed_ids: processedIds,
    };
  }
}

export default new OverrideService();