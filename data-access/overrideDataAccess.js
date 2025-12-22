// dao/overrideDao.js
import db from '../database.js';

class OverrideDAO {

  async getBatchClusterData(clusterObjs) {
    return await db.func("get_batch_cluster_data_v2", [clusterObjs]);
  }

  async writeBatchClusterOverrides(overrideArray) {
    const jsonArray = overrideArray.map(clusters => JSON.stringify(clusters));
    return await db.proc('write_batch_overrides', [jsonArray]);
  }

  async getBatchViolationData(points) {
    return await db.func('get_batch_violation_data', [points], 'jsonb[]');
  }

  async writeAdasOverrides(overrideArray) {
    return await db.proc('write_adas_overrides', [overrideArray]);
  }

async getStopSignData(points) {
    return await db.func("get_stop_sign_data", [JSON.stringify(points)]);
}


  async writeStopOverrides(rows) {
    const payload = rows;
    return await db.proc("write_stop_overrides", [payload]);
  }

  async checkAdasDuplicate(params) {
    return await db.func('check_adas_duplicate', [
      params.lat,
      params.lon,
      params.bearing,
      params.expected_speed
    ]);
  }
}

export default new OverrideDAO();