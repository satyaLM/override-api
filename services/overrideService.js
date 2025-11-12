import overrideDao from '../dao/overrideDao.js';
import { snapToNearestRoadWithDirection } from '../snap_to_road.js';

class OverrideService {
  async createBatchOverride({ cluster_ids }) {
    const dbResult = await overrideDao.getBatchClusterData(cluster_ids);
    const row = dbResult[0];

    if (!row || row.processed_count === 0) {
      return {
        processed_count: 0,
        failed_count: row?.failed_count || 0,
        failed_ids: row?.failed_ids || [],
        skipped_count: row?.skipped_count || 0,
        skipped_ids: row?.skipped_ids || [],
        processed_ids: [],
        messages: []
      };
    }

    const { cluster_data } = row;

    const snapResults = await Promise.all(
      cluster_data.map(async (cluster) => {
        const snapResult = await snapToNearestRoadWithDirection(cluster);

        return {
          cluster_id: snapResult.cluster_id,
          lat: snapResult.lat,
          lon: snapResult.lon,
          bearing: snapResult.bearing,
          accuracy: cluster.accuracy,                  
          speed_limit_read_by_engine: cluster.speed_limit_read_by_engine, 
          method: snapResult.method,
          message: snapResult.message,
        };
      })
    );

    const overridesForDB = snapResults.map(r => ({
      cluster_id: r.cluster_id,
      lat: r.lat,
      lon: r.lon,
      bearing: r.bearing,
      accuracy: r.accuracy,
      speed_limit_read_by_engine: r.speed_limit_read_by_engine,
    }));

    await overrideDao.writeBatchOverrides(overridesForDB);

    return {
      processed_count: snapResults.length,
      failed_count: row.failed_count,
      failed_ids: row.failed_ids,
      skipped_count: row.skipped_count,
      skipped_ids: row.skipped_ids,
      processed_ids: snapResults.map(r => r.cluster_id),
      messages: snapResults.map(r => r.message),
    };
  }
}

export default new OverrideService();