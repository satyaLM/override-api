// dao/overrideDao.js
import db from '../database.js';

class OverrideDAO {
  async getBatchClusterData(clusterIds) {
    return await db.func('get_batch_cluster_data', [clusterIds]);
  }

  async writeBatchOverrides(overrideArray) {
    return await db.proc('write_batch_overrides', [overrideArray]);
  }
}

export default new OverrideDAO();