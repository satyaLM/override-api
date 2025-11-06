import db from '../database.js';

class OverrideDAO {
  async createBatchOverride(input) {
    try {
      return await db.proc('create_batch_cluster_override', [
        input.clusterIds,
        null,
        null,
        null,
        null,
        null
      ]);
    } catch (err) {
      console.error('Database error in createBatchOverride:', err);
      throw new Error(`Unable to create batch override: ${err.message}`);
    }
  }
}

export default new OverrideDAO();
