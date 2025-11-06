import overrideDao from '../dao/overrideDao.js';

class OverrideService {
  async createBatchOverride(input) {
    const rawResult = await overrideDao.createBatchOverride(input);

    if (Array.isArray(rawResult) && rawResult.length > 0) {
      return rawResult[0];
    }

    return rawResult || {
      processed_count: 0,
      failed_count: 0,
      failed_ids: [],
      skipped_count: 0,
      skipped_ids: []
    };
  }
}

export default new OverrideService();
